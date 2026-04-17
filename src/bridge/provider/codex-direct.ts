import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RouterConfig } from '../../server/config.js'
import type { JsonValue } from '../../shared/index.js'
import { buildCodexDeveloperInstructions, resolveModelAlias } from '../anthropic/compat.js'
import { canonicalRequestToAnthropic } from '../canonical/anthropic.js'
import type {
	CanonicalBridgeRequest,
	CanonicalBridgeResponse,
	CanonicalContentBlock,
	CanonicalModelListingEntry,
	CanonicalProviderHealth,
	CanonicalStopReason,
	CanonicalStreamEvent,
	CanonicalUsage,
} from '../canonical/types.js'
import type {
	BridgeProviderAdapter,
	ProviderExecutionContext,
	ProviderStreamObserver,
} from './contract.js'
import {
	getCodexDirectAuthHealth,
	readCodexDirectAuthState,
	type CodexDirectAuthState,
} from './codex-direct-auth.js'

const CODEX_DIRECT_AUTH_ISSUER = 'https://auth.openai.com'
const DEFAULT_CODEX_DIRECT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_CODEX_DIRECT_REQUEST_PATH = '/responses'
const AUTH_REFRESH_SKEW_MS = 30_000
const PRESTART_BUFFER_WINDOW_MS = 50
const PRESTART_BUFFER_EVENT_LIMIT = 3

type OpenAiChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: string | null
	tool_call_id?: string
	tool_calls?: Array<{
		id: string
		type: 'function'
		function: {
			name: string
			arguments: string
		}
	}>
}

type OpenAiChatCompletionResponse = {
	id?: string
	model?: string
	choices?: Array<{
		finish_reason?: 'stop' | 'tool_calls' | 'length' | null
		message?: {
			content?: string | null
			tool_calls?: Array<{
				id?: string
				type?: 'function'
				function?: {
					name?: string
					arguments?: string
				}
			}>
		}
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
}

type CodexDirectRefreshResponse = {
	access_token?: string
	refresh_token?: string
	expires_in?: number
	expires_at?: string
	account_id?: string
	id_token?: string
}

type CodexDirectResponsesResponse = {
	id?: string
	model?: string
	status?: string
	incomplete_details?: {
		reason?: string | null
	}
	output?: Array<
		| {
				type?: 'message'
				role?: string
				content?: Array<{
					type?: 'output_text' | 'text'
					text?: string | null
				}>
		  }
		| {
				type?: 'function_call'
				call_id?: string
				name?: string
				arguments?: string
		  }
	>
	usage?: {
		input_tokens?: number
		output_tokens?: number
		total_tokens?: number
	}
}

type CodexDirectSseEnvelope = {
	type?: string
	response?: CodexDirectResponsesResponse & {
		error?: {
			message?: string | null
		}
	}
	error?: {
		message?: string | null
	}
	delta?: string
	text?: string
	item_id?: string
	output_index?: number
	name?: string
	arguments?: string
	item?: {
		type?: string
		id?: string
		call_id?: string
		name?: string
		arguments?: string
	}
}

export class CodexDirectProviderError extends Error {
	readonly status: number | null
	readonly requestId: string | null
	readonly responseBodyPreview: string | null

	constructor(
		message: string,
		options?: {
			status?: number | null
			requestId?: string | null
			responseBodyPreview?: string | null
		},
	) {
		super(message)
		this.name = 'CodexDirectProviderError'
		this.status = options?.status ?? null
		this.requestId = options?.requestId ?? null
		this.responseBodyPreview = options?.responseBodyPreview ?? null
	}
}

function toExposedModel(config: RouterConfig, modelId: string): string {
	return config.activeProviderId === 'codex-direct' ? modelId : `codex-direct/${modelId}`
}

function requireBaseUrl(config: RouterConfig) {
	return (config.codexDirectBaseUrl ?? DEFAULT_CODEX_DIRECT_BASE_URL).replace(/\/+$/, '')
}

function buildCodexDirectUrl(config: RouterConfig, path: string) {
	const baseUrl = requireBaseUrl(config)
	if (baseUrl.endsWith('/responses')) {
		if (path === DEFAULT_CODEX_DIRECT_REQUEST_PATH) {
			return baseUrl
		}

		return `${baseUrl.slice(0, -'/responses'.length)}${path}`
	}

	if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
		return `${baseUrl}${path.slice('/v1'.length)}`
	}

	return `${baseUrl}${path}`
}

type IdTokenClaims = {
	chatgpt_account_id?: string
	organizations?: Array<{ id?: string }>
	'https://api.openai.com/auth'?: {
		chatgpt_account_id?: string
	}
}

function parseJwtClaims(token: string): IdTokenClaims | null {
	const parts = token.split('.')
	if (parts.length !== 3) {
		return null
	}
	const payload = parts[1]
	if (!payload) {
		return null
	}

	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims
	} catch {
		return null
	}
}

function extractAccountIdFromClaims(claims: IdTokenClaims | null): string | null {
	if (!claims) {
		return null
	}

	return (
		claims.chatgpt_account_id ||
		claims['https://api.openai.com/auth']?.chatgpt_account_id ||
		claims.organizations?.[0]?.id ||
		null
	)
}

function extractAccountId(payload: CodexDirectRefreshResponse): string | null {
	return (
		payload.account_id ||
		extractAccountIdFromClaims(
			parseJwtClaims(payload.id_token ?? payload.access_token ?? ''),
		) ||
		null
	)
}

function getRequestId(headers: Headers): string | null {
	return (
		headers.get('x-request-id')?.trim() ||
		headers.get('request-id')?.trim() ||
		headers.get('openai-request-id')?.trim() ||
		null
	)
}

function summarizeBodyPreview(rawBody: string): string | null {
	const trimmed = rawBody.trim()
	if (!trimmed) {
		return null
	}

	try {
		const parsed = JSON.parse(trimmed) as {
			error?: { message?: unknown; code?: unknown; type?: unknown }
			message?: unknown
		}
		if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) {
			return parsed.error.message.trim()
		}
		if (typeof parsed?.message === 'string' && parsed.message.trim()) {
			return parsed.message.trim()
		}
	} catch {
		// Fall through to the raw preview below.
	}

	return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
}

function parseSseBlock(block: string) {
	const lines = block.split('\n')
	let event = 'message'
	const dataLines: string[] = []

	for (const line of lines) {
		if (line.startsWith('event: ')) {
			event = line.slice('event: '.length).trim()
			continue
		}
		if (line.startsWith('data: ')) {
			dataLines.push(line.slice('data: '.length))
		}
	}

	if (dataLines.length === 0) {
		return null
	}

	return {
		event,
		data: dataLines.join('\n'),
	}
}

function looksLikeSsePayload(rawBody: string): boolean {
	const trimmed = rawBody.trimStart()
	return (
		trimmed.startsWith('event:') ||
		trimmed.startsWith('data:') ||
		trimmed.includes('\nevent:') ||
		trimmed.includes('\ndata:')
	)
}

function parseCodexDirectSsePayloads(
	response: Response,
	payloads: CodexDirectSseEnvelope[],
): CodexDirectResponsesResponse {
	let completedResponse: CodexDirectResponsesResponse | null = null
	let responseId: string | undefined
	let responseModel: string | undefined
	let text = ''
	const functionCalls = new Map<
		string,
		{
			call_id?: string
			name?: string
			arguments: string
		}
	>()

	for (const payload of payloads) {
		if (payload.response?.id) {
			responseId = payload.response.id
		}
		if (payload.response?.model) {
			responseModel = payload.response.model
		}

		if (payload.type === 'response.completed' && payload.response) {
			completedResponse = payload.response
			continue
		}

		if (payload.type === 'response.failed') {
			throw new CodexDirectProviderError(
				payload.response?.error?.message?.trim() ||
					payload.error?.message?.trim() ||
					'codex-direct streaming request failed',
				{
					status: response.status,
					requestId: getRequestId(response.headers),
				},
			)
		}

		if (payload.type === 'error') {
			throw new CodexDirectProviderError(
				payload.error?.message?.trim() || 'codex-direct streaming request failed',
				{
					status: response.status,
					requestId: getRequestId(response.headers),
				},
			)
		}

		if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
			text += payload.delta
			continue
		}

		if (payload.type === 'response.output_text.done' && typeof payload.text === 'string') {
			text = payload.text
			continue
		}

		if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
			const key = payload.item_id ?? payload.item.id ?? `call_${functionCalls.size}`
			functionCalls.set(key, {
				call_id: payload.item.call_id,
				name: payload.item.name,
				arguments: payload.item.arguments ?? '',
			})
			continue
		}

		if (
			payload.type === 'response.function_call_arguments.delta' &&
			typeof payload.delta === 'string'
		) {
			const key = payload.item_id ?? `call_${payload.output_index ?? functionCalls.size}`
			const current = functionCalls.get(key) ?? { arguments: '', name: payload.name }
			current.arguments += payload.delta
			if (payload.name && !current.name) {
				current.name = payload.name
			}
			functionCalls.set(key, current)
			continue
		}

		if (
			payload.type === 'response.function_call_arguments.done' &&
			typeof payload.arguments === 'string'
		) {
			const key = payload.item_id ?? `call_${payload.output_index ?? functionCalls.size}`
			const current = functionCalls.get(key) ?? { arguments: '', name: payload.name }
			current.arguments = payload.arguments
			if (payload.name && !current.name) {
				current.name = payload.name
			}
			functionCalls.set(key, current)
		}
	}

	const collectedOutput = [
		...(text
			? [
					{
						type: 'message' as const,
						role: 'assistant',
						content: [{ type: 'output_text' as const, text }],
					},
				]
			: []),
		...[...functionCalls.values()].map((call) => ({
			type: 'function_call' as const,
			call_id: call.call_id,
			name: call.name,
			arguments: call.arguments,
		})),
	]

	if (completedResponse) {
		const hasCompletedText = (completedResponse.output ?? []).some(
			(item) =>
				item.type === 'message' &&
				item.role === 'assistant' &&
				(item.content ?? []).some(
					(block) =>
						(block.type === 'output_text' || block.type === 'text') &&
						typeof block.text === 'string' &&
						block.text.length > 0,
				),
		)
		const hasCompletedToolCalls = (completedResponse.output ?? []).some(
			(item) => item.type === 'function_call',
		)
		if ((!hasCompletedText && text) || (!hasCompletedToolCalls && functionCalls.size > 0)) {
			return {
				...completedResponse,
				output: [
					...(completedResponse.output ?? []),
					...collectedOutput.filter(
						(item) =>
							(item.type === 'message' && !hasCompletedText) ||
							(item.type === 'function_call' && !hasCompletedToolCalls),
					),
				],
			}
		}
		return completedResponse
	}

	if (collectedOutput.length > 0) {
		return {
			id: responseId,
			model: responseModel,
			output: collectedOutput,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
			},
		}
	}

	throw new CodexDirectProviderError('codex-direct stream ended without a completed response', {
		status: response.status,
		requestId: getRequestId(response.headers),
	})
}

function parseCodexDirectSseText(
	response: Response,
	rawBody: string,
): CodexDirectResponsesResponse {
	try {
		const payloads: CodexDirectSseEnvelope[] = []
		for (const part of rawBody.split('\n\n')) {
			const parsed = parseSseBlock(part)
			if (!parsed || parsed.data === '[DONE]') {
				continue
			}
			payloads.push(JSON.parse(parsed.data) as CodexDirectSseEnvelope)
		}
		return parseCodexDirectSsePayloads(response, payloads)
	} catch (error) {
		if (error instanceof CodexDirectProviderError) {
			throw error
		}
		throw new CodexDirectProviderError(
			`codex-direct request returned invalid SSE: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{
				status: response.status,
				requestId: getRequestId(response.headers),
				responseBodyPreview: summarizeBodyPreview(rawBody),
			},
		)
	}
}

async function parseCodexDirectSseResponse(
	response: Response,
): Promise<CodexDirectResponsesResponse> {
	if (!response.body) {
		throw new CodexDirectProviderError('codex-direct request returned an empty response stream', {
			status: response.status,
			requestId: getRequestId(response.headers),
		})
	}

	const decoder = new TextDecoder()
	const reader = response.body.getReader()
	let buffer = ''
	const payloads: CodexDirectSseEnvelope[] = []

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			buffer += decoder.decode(value, { stream: true })
			const parts = buffer.split('\n\n')
			buffer = parts.pop() ?? ''
			for (const part of parts) {
				const parsed = parseSseBlock(part)
				if (!parsed || parsed.data === '[DONE]') {
					continue
				}

				payloads.push(JSON.parse(parsed.data) as CodexDirectSseEnvelope)
			}
		}

		buffer += decoder.decode()
		if (buffer.trim()) {
			const parsed = parseSseBlock(buffer)
			if (parsed && parsed.data !== '[DONE]') {
				payloads.push(JSON.parse(parsed.data) as CodexDirectSseEnvelope)
			}
		}
	} catch (error) {
		if (error instanceof CodexDirectProviderError) {
			throw error
		}

		throw new CodexDirectProviderError(
			`codex-direct request returned invalid SSE: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{
				status: response.status,
				requestId: getRequestId(response.headers),
			},
		)
	} finally {
		reader.releaseLock()
	}

	return parseCodexDirectSsePayloads(response, payloads)
}

async function parseJsonBody<T>(
	response: Response,
	stage: 'request' | 'token refresh',
): Promise<T> {
	const rawBody = await response.text()
	if (!rawBody.trim()) {
		throw new CodexDirectProviderError(`codex-direct ${stage} returned an empty response body`, {
			status: response.status,
			requestId: getRequestId(response.headers),
			responseBodyPreview: null,
		})
	}

	try {
		return JSON.parse(rawBody) as T
	} catch (error) {
		if (stage === 'request' && looksLikeSsePayload(rawBody)) {
			return parseCodexDirectSseText(response, rawBody) as T
		}
		throw new CodexDirectProviderError(
			`codex-direct ${stage} returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{
				status: response.status,
				requestId: getRequestId(response.headers),
				responseBodyPreview: summarizeBodyPreview(rawBody),
			},
		)
	}
}

function asSignalPair(requestSignal: AbortSignal | null | undefined, timeoutMs: number) {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort(new Error(`codex-direct request did not complete within ${timeoutMs}ms.`))
	}, timeoutMs)

	const listeners: Array<() => void> = []
	if (requestSignal) {
		const abortFromRequest = () => {
			controller.abort(
				requestSignal.reason instanceof Error
					? requestSignal.reason
					: new Error('request was aborted'),
			)
		}
		if (requestSignal.aborted) {
			abortFromRequest()
		} else {
			requestSignal.addEventListener('abort', abortFromRequest, { once: true })
			listeners.push(() => requestSignal.removeEventListener('abort', abortFromRequest))
		}
	}

	return {
		signal: controller.signal,
		abort(reason?: unknown) {
			controller.abort(
				reason instanceof Error
					? reason
					: new Error(typeof reason === 'string' ? reason : 'request was aborted'),
			)
		},
		cleanup() {
			clearTimeout(timeout)
			for (const remove of listeners) {
				remove()
			}
		},
	}
}

function blockToText(block: CanonicalContentBlock): string {
	switch (block.type) {
		case 'text':
			return block.text
		case 'thinking':
			return block.text
		case 'tool_use':
			return `Tool use (${block.name}): ${JSON.stringify(block.input)}`
		case 'tool_result':
			return `Tool result (${block.toolUseId}): ${
				typeof block.content === 'string'
					? block.content
					: block.content.map(blockToText).join('\n')
			}`
		case 'image':
			throw new Error('codex-direct does not support canonical image blocks yet')
	}
}

function serializeContent(blocks: CanonicalContentBlock[]): string | null {
	const parts = blocks.map(blockToText).filter(Boolean)
	return parts.length > 0 ? parts.join('\n') : null
}

function serializeToolResultContent(content: string | CanonicalContentBlock[]): string {
	return typeof content === 'string' ? content : content.map(blockToText).join('\n')
}

function buildOpenAiMessages(
	request: CanonicalBridgeRequest,
	options?: { includeSystem?: boolean },
): OpenAiChatMessage[] {
	const messages: OpenAiChatMessage[] = []

	if (options?.includeSystem !== false && request.system.length > 0) {
		messages.push({
			role: 'system',
			content: serializeContent(request.system),
		})
	}

	for (const message of request.messages) {
		if (message.role === 'assistant') {
			const textBlocks: CanonicalContentBlock[] = []
			const toolUseBlocks: Array<Extract<CanonicalContentBlock, { type: 'tool_use' }>> = []

			for (const block of message.content) {
				if (block.type === 'tool_use') {
					toolUseBlocks.push(block)
					continue
				}
				textBlocks.push(block)
			}

			if (textBlocks.length > 0 || toolUseBlocks.length > 0) {
				messages.push({
					role: 'assistant',
					content: serializeContent(textBlocks),
					...(toolUseBlocks.length > 0
						? {
								tool_calls: toolUseBlocks.map((block) => ({
									id: block.id,
									type: 'function',
									function: {
										name: block.name,
										arguments: JSON.stringify(block.input),
									},
								})),
							}
						: {}),
				})
			}
			continue
		}

		let pendingBlocks: CanonicalContentBlock[] = []
		const flushPendingBlocks = () => {
			const content = serializeContent(pendingBlocks)
			pendingBlocks = []
			if (!content) {
				return
			}
			messages.push({
				role: message.role === 'tool' ? 'user' : message.role,
				content,
			})
		}

		for (const block of message.content) {
			if (block.type === 'tool_result') {
				flushPendingBlocks()
				messages.push({
					role: 'tool',
					tool_call_id: block.toolUseId,
					content: serializeToolResultContent(block.content),
				})
				continue
			}

			pendingBlocks.push(block)
		}

		flushPendingBlocks()
	}

	return messages
}

function buildCodexDirectInstructions(request: CanonicalBridgeRequest): string {
	return buildCodexDeveloperInstructions(canonicalRequestToAnthropic(request))
}

function mapToolChoice(
	request: CanonicalBridgeRequest,
):
	| 'auto'
	| 'required'
	| 'none'
	| {
			type: 'function'
			function: {
				name: string
			}
	  }
	| undefined {
	const choice = request.toolChoice
	if (!choice) {
		return undefined
	}

	if (choice === 'auto') {
		return 'auto'
	}
	if (choice === 'any') {
		return 'required'
	}
	if (choice === 'none') {
		return 'none'
	}
	if (choice.type === 'none') {
		return 'none'
	}

	return {
		type: 'function',
		function: {
			name: choice.name,
		},
	}
}

function mapStopReason(finishReason: string | null | undefined): CanonicalStopReason {
	switch (finishReason) {
		case 'tool_calls':
			return 'tool_use'
		case 'length':
			return 'max_tokens'
		case 'stop':
		default:
			return 'end_turn'
	}
}

function parseToolArguments(raw: string | undefined, toolName?: string): JsonValue {
	if (!raw || !raw.trim()) {
		return {}
	}

	try {
		return JSON.parse(raw) as JsonValue
	} catch (error) {
		const suffix = toolName ? ` for tool '${toolName}'` : ''
		throw new Error(
			`codex-direct returned invalid JSON arguments${suffix}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

function isChatCompletionResponse(
	response: OpenAiChatCompletionResponse | CodexDirectResponsesResponse,
): response is OpenAiChatCompletionResponse {
	return Array.isArray((response as OpenAiChatCompletionResponse).choices)
}

function toCanonicalChatCompletionResponse(
	request: CanonicalBridgeRequest,
	response: OpenAiChatCompletionResponse,
): CanonicalBridgeResponse {
	const choice = response.choices?.[0]
	if (!choice) {
		throw new CodexDirectProviderError('codex-direct response is missing choices[0]')
	}
	const message = choice.message
	if (!message) {
		throw new CodexDirectProviderError('codex-direct response is missing choices[0].message')
	}

	const content: CanonicalBridgeResponse['content'] = []
	if (typeof message.content === 'string' && message.content) {
		content.push({
			type: 'text',
			text: message.content,
		})
	}

	for (const toolCall of message.tool_calls ?? []) {
		content.push({
			type: 'tool_use',
			id: toolCall.id ?? `call_${crypto.randomUUID()}`,
			name: toolCall.function?.name ?? 'unknown_tool',
			input: parseToolArguments(toolCall.function?.arguments, toolCall.function?.name),
		})
	}

	return {
		id: response.id ?? `msg_${crypto.randomUUID()}`,
		model: response.model ?? request.model,
		content,
		stopReason: mapStopReason(choice.finish_reason),
		stopSequence: null,
		usage: {
			inputTokens: response.usage?.prompt_tokens ?? 0,
			outputTokens: response.usage?.completion_tokens ?? 0,
			cachedInputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens:
				response.usage?.total_tokens ??
				(response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
		},
		provider: {
			id: 'codex-direct',
			model: response.model ?? request.model,
			rawModel: response.model ?? null,
		},
	}
}

function mapResponsesStopReason(
	response: CodexDirectResponsesResponse,
	content: CanonicalBridgeResponse['content'],
): CanonicalStopReason {
	if (content.some((block) => block.type === 'tool_use')) {
		return 'tool_use'
	}

	switch (response.incomplete_details?.reason) {
		case 'max_output_tokens':
		case 'max_tokens':
			return 'max_tokens'
		default:
			return 'end_turn'
	}
}

function toCanonicalResponsesApiResponse(
	request: CanonicalBridgeRequest,
	response: CodexDirectResponsesResponse,
): CanonicalBridgeResponse {
	const content: CanonicalBridgeResponse['content'] = []

	for (const item of response.output ?? []) {
		if (item.type === 'message' && item.role === 'assistant') {
			for (const block of item.content ?? []) {
				if (
					(block.type === 'output_text' || block.type === 'text') &&
					typeof block.text === 'string' &&
					block.text
				) {
					content.push({
						type: 'text',
						text: block.text,
					})
				}
			}
			continue
		}

		if (item.type === 'function_call') {
			content.push({
				type: 'tool_use',
				id: item.call_id ?? `call_${crypto.randomUUID()}`,
				name: item.name ?? 'unknown_tool',
				input: parseToolArguments(item.arguments, item.name),
			})
		}
	}

	return {
		id: response.id ?? `msg_${crypto.randomUUID()}`,
		model: response.model ?? request.model,
		content,
		stopReason: mapResponsesStopReason(response, content),
		stopSequence: null,
		usage: {
			inputTokens: response.usage?.input_tokens ?? 0,
			outputTokens: response.usage?.output_tokens ?? 0,
			cachedInputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens:
				response.usage?.total_tokens ??
				(response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
		},
		provider: {
			id: 'codex-direct',
			model: response.model ?? request.model,
			rawModel: response.model ?? null,
		},
	}
}

function toCanonicalResponse(
	request: CanonicalBridgeRequest,
	response: OpenAiChatCompletionResponse | CodexDirectResponsesResponse,
): CanonicalBridgeResponse {
	return isChatCompletionResponse(response)
		? toCanonicalChatCompletionResponse(request, response)
		: toCanonicalResponsesApiResponse(request, response)
}

function isExpired(expiresAt: string | null | undefined, skewMs = AUTH_REFRESH_SKEW_MS) {
	if (!expiresAt) {
		return false
	}

	const expiresAtMs = Date.parse(expiresAt)
	return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + skewMs
}

async function persistAuthState(config: RouterConfig, state: CodexDirectAuthState) {
	await mkdir(dirname(config.codexDirectAuthStateFile), { recursive: true })
	const tempPath = `${config.codexDirectAuthStateFile}.tmp-${process.pid}-${crypto.randomUUID()}`
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	})

	try {
		await rename(tempPath, config.codexDirectAuthStateFile)
	} catch (error) {
		await unlink(tempPath).catch(() => {})
		throw error
	}
}

function toExpiresAt(refresh: CodexDirectRefreshResponse, currentState: CodexDirectAuthState) {
	if (typeof refresh.expires_at === 'string' && refresh.expires_at.trim()) {
		return refresh.expires_at
	}
	if (typeof refresh.expires_in === 'number' && Number.isFinite(refresh.expires_in)) {
		return new Date(Date.now() + refresh.expires_in * 1000).toISOString()
	}
	return currentState.expiresAt ?? null
}

async function refreshAccessToken(
	config: RouterConfig,
	authState: CodexDirectAuthState,
	requestSignal: AbortSignal | null | undefined,
): Promise<CodexDirectAuthState> {
	if (!authState.refreshToken) {
		throw new CodexDirectProviderError('codex-direct OAuth access token is expired')
	}

	const signalPair = asSignalPair(requestSignal, config.codexDirectRequestTimeoutMs)
	try {
		const response = await fetch(`${CODEX_DIRECT_AUTH_ISSUER}/oauth/token`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
			signal: signalPair.signal,
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: authState.refreshToken,
				client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
			}),
		})

		if (!response.ok) {
			const rawBody = await response.text()
			const preview = summarizeBodyPreview(rawBody)
			throw new CodexDirectProviderError(
				`codex-direct token refresh failed with status ${response.status}${
					preview ? `: ${preview}` : ''
				}`,
				{
					status: response.status,
					requestId: getRequestId(response.headers),
					responseBodyPreview: preview,
				},
			)
		}

		const payload = await parseJsonBody<CodexDirectRefreshResponse>(response, 'token refresh')
		if (!payload.access_token?.trim()) {
			throw new CodexDirectProviderError(
				'codex-direct token refresh response is missing access_token',
				{
					status: response.status,
					requestId: getRequestId(response.headers),
				},
			)
		}

		const nextState: CodexDirectAuthState = {
			authType: authState.authType,
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token ?? authState.refreshToken ?? null,
			expiresAt: toExpiresAt(payload, authState),
			accountId: extractAccountId(payload) ?? authState.accountId ?? null,
		}
		await persistAuthState(config, nextState)
		return nextState
	} finally {
		signalPair.cleanup()
	}
}

async function resolveBearerToken(
	config: RouterConfig,
	requestSignal: AbortSignal | null | undefined,
): Promise<{
	token: string
	accountId: string | null
}> {
	if (config.codexDirectAuthMode === 'api_key') {
		if (!config.codexOpenAiApiKey) {
			throw new CodexDirectProviderError(
				'CODEX_OPENAI_API_KEY is required for codex-direct api_key mode',
			)
		}

		return {
			token: config.codexOpenAiApiKey,
			accountId: null,
		}
	}

	let authState = readCodexDirectAuthState(config)
	if (!authState && config.codexOpenAiApiKey && config.codexDirectAuthMode === 'auto') {
		return {
			token: config.codexOpenAiApiKey,
			accountId: null,
		}
	}

	if (!authState) {
		throw new CodexDirectProviderError('codex-direct OAuth state file is missing or invalid')
	}

	if (!authState.accessToken && authState.authType === 'api_key') {
		throw new CodexDirectProviderError('codex-direct api_key state is missing an access token')
	}

	if (!authState.accessToken) {
		throw new CodexDirectProviderError('codex-direct OAuth state does not contain an access token')
	}

	if (authState.authType === 'api_key') {
		return {
			token: authState.accessToken,
			accountId: authState.accountId ?? null,
		}
	}

	if (isExpired(authState.expiresAt)) {
		if (authState.refreshToken) {
			authState = await refreshAccessToken(config, authState, requestSignal)
		} else if (config.codexOpenAiApiKey && config.codexDirectAuthMode === 'auto') {
			return {
				token: config.codexOpenAiApiKey,
				accountId: null,
			}
		} else {
			throw new CodexDirectProviderError('codex-direct OAuth access token is expired')
		}
	}

	if (!authState.accessToken) {
		throw new CodexDirectProviderError('codex-direct OAuth state does not contain an access token')
	}

	return {
		token: authState.accessToken,
		accountId: authState.accountId ?? null,
	}
}

async function buildHeaders(
	config: RouterConfig,
	requestSignal: AbortSignal | null | undefined,
) {
	const auth = await resolveBearerToken(config, requestSignal)
	return {
		'content-type': 'application/json',
		authorization: `Bearer ${auth.token}`,
		...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
	}
}

function buildCodexDirectRequestBody(request: CanonicalBridgeRequest) {
	return {
		model: request.model,
		store: false,
		instructions: buildCodexDirectInstructions(request),
		input: buildOpenAiMessages(request, { includeSystem: false }),
		temperature: request.sampling.temperature,
		top_p: request.sampling.topP,
		stream: true,
		tools:
			request.tools?.map((tool) => ({
				type: 'function',
				name: tool.name,
				description: tool.description,
				parameters: tool.input_schema,
			})) ?? undefined,
		tool_choice: mapToolChoice(request),
	}
}

type CodexDirectStreamBlockState =
	| {
			kind: 'text'
			index: number
			itemId: string | null
			started: boolean
			closed: boolean
			text: string
	  }
	| {
			kind: 'tool_use'
			index: number
			itemId: string | null
			started: boolean
			closed: boolean
			toolUseId: string
			name: string
			arguments: string
	  }

type CodexDirectStreamState = {
	responseId: string | null
	model: string | null
	messageStarted: boolean
	startedMessageId: string | null
	provisionalMessageId: string | null
	messageStartedWithProvisionalId: boolean
	completed: boolean
	blocksByIndex: Map<number, CodexDirectStreamBlockState>
	outputIndexByItemId: Map<string, number>
	pendingStartPayloads: CodexDirectSseEnvelope[]
	pendingStartBufferedAt: number | null
}

function toZeroUsage(): CanonicalUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	}
}

function createCodexDirectStreamState(request: CanonicalBridgeRequest): CodexDirectStreamState {
	return {
		responseId: null,
		model: request.model,
		messageStarted: false,
		startedMessageId: null,
		provisionalMessageId: null,
		messageStartedWithProvisionalId: false,
		completed: false,
		blocksByIndex: new Map(),
		outputIndexByItemId: new Map(),
		pendingStartPayloads: [],
		pendingStartBufferedAt: null,
	}
}

function sanitizeIdSegment(value: string | null | undefined): string | null {
	if (!value) {
		return null
	}

	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
	return sanitized ? sanitized.slice(0, 48) : null
}

function buildDeterministicProvisionalMessageId(
	request: CanonicalBridgeRequest,
	seeds?: Array<string | number | null | undefined>,
) {
	const segments = [
		sanitizeIdSegment(request.metadata.routerRequestId ?? null),
		sanitizeIdSegment(request.metadata.sessionId ?? null),
		...(seeds ?? []).map((seed) => sanitizeIdSegment(seed == null ? null : String(seed))),
	].filter((segment): segment is string => Boolean(segment))

	return `msg_provisional_${(segments.length > 0 ? segments : ['codex_direct']).join('_')}`
}

function updateStreamIdentity(
	state: CodexDirectStreamState,
	payload: CodexDirectSseEnvelope,
) {
	if (payload.response?.id) {
		state.responseId = payload.response.id
	}
	if (payload.response?.model) {
		state.model = payload.response.model
	}
}

function registerOutputIndex(
	state: CodexDirectStreamState,
	index: number,
	itemId?: string | null,
) {
	if (itemId) {
		state.outputIndexByItemId.set(itemId, index)
	}
}

function resolveOutputIndex(
	state: CodexDirectStreamState,
	payload: CodexDirectSseEnvelope,
): number {
	if (typeof payload.output_index === 'number') {
		registerOutputIndex(state, payload.output_index, payload.item_id ?? payload.item?.id ?? null)
		return payload.output_index
	}

	const knownItemId = payload.item_id ?? payload.item?.id ?? null
	if (knownItemId && state.outputIndexByItemId.has(knownItemId)) {
		return state.outputIndexByItemId.get(knownItemId) ?? 0
	}

	const nextIndex = state.blocksByIndex.size
	registerOutputIndex(state, nextIndex, knownItemId)
	return nextIndex
}

function getOrderedStreamBlocks(state: CodexDirectStreamState): CodexDirectStreamBlockState[] {
	return [...state.blocksByIndex.values()].sort((left, right) => left.index - right.index)
}

function summarizeStreamCompletion(state: CodexDirectStreamState): {
	finalText: string
	decision: {
		kind: 'assistant' | 'tool_use'
		name?: string
		input?: unknown
		preamble?: string | null
	}
} {
	const blocks = getOrderedStreamBlocks(state)
	const finalText = blocks
		.filter((block): block is Extract<CodexDirectStreamBlockState, { kind: 'text' }> => block.kind === 'text')
		.map((block) => block.text)
		.join('')
	const firstToolUse = blocks.find(
		(block): block is Extract<CodexDirectStreamBlockState, { kind: 'tool_use' }> =>
			block.kind === 'tool_use',
	)

	if (!firstToolUse) {
		return {
			finalText,
			decision: {
				kind: 'assistant',
			},
		}
	}

	const preamble = blocks
		.filter(
			(block): block is Extract<CodexDirectStreamBlockState, { kind: 'text' }> =>
				block.kind === 'text' && block.index < firstToolUse.index,
		)
		.map((block) => block.text)
		.join('')

	return {
		finalText,
		decision: {
			kind: 'tool_use',
			name: firstToolUse.name,
			input: parseToolArguments(firstToolUse.arguments, firstToolUse.name),
			preamble: preamble || null,
		},
	}
}

async function streamCodexDirectSseToCanonical(
	response: Response,
	request: CanonicalBridgeRequest,
	controller: ReadableStreamDefaultController<CanonicalStreamEvent>,
	observer?: ProviderStreamObserver,
) {
	if (!response.body) {
		throw new CodexDirectProviderError('codex-direct request returned an empty response stream', {
			status: response.status,
			requestId: getRequestId(response.headers),
		})
	}

	const state = createCodexDirectStreamState(request)
	const decoder = new TextDecoder()
	const reader = response.body.getReader()
	let buffer = ''

	const emit = async (event: CanonicalStreamEvent) => {
		await observer?.onEvent?.(event)
		controller.enqueue(event)
	}

	const ensureMessageStart = async (seedPayload?: CodexDirectSseEnvelope) => {
		if (state.messageStarted) {
			return
		}

		if (!state.responseId && !state.provisionalMessageId) {
			state.provisionalMessageId = buildDeterministicProvisionalMessageId(request, [
				seedPayload?.item_id,
				seedPayload?.item?.id,
				seedPayload?.output_index,
			])
		}

		const messageId = state.responseId ?? state.provisionalMessageId ?? `msg_${crypto.randomUUID()}`
		const upstreamResponseId = state.responseId ?? null
		state.messageStarted = true
		state.startedMessageId = messageId
		state.messageStartedWithProvisionalId = upstreamResponseId == null
		await observer?.onSessionReady?.({
			model: state.model ?? request.model,
			messageId,
			upstreamResponseId,
			provisionalMessageId: upstreamResponseId == null,
		})
		await emit({
			type: 'message_start',
			messageId,
			model: state.model ?? request.model,
			usage: toZeroUsage(),
		})
	}

	const ensureTextBlock = async (index: number, itemId?: string | null) => {
		registerOutputIndex(state, index, itemId ?? null)
		const existing = state.blocksByIndex.get(index)
		if (existing && existing.kind === 'text') {
			if (itemId && !existing.itemId) {
				existing.itemId = itemId
			}
			if (!existing.started) {
				existing.started = true
				await emit({
					type: 'content_block_start',
					index,
					contentBlock: {
						type: 'text',
						text: '',
					},
				})
			}
			return existing
		}

		const block: Extract<CodexDirectStreamBlockState, { kind: 'text' }> = {
			kind: 'text',
			index,
			itemId: itemId ?? null,
			started: true,
			closed: false,
			text: '',
		}
		state.blocksByIndex.set(index, block)
		await emit({
			type: 'content_block_start',
			index,
			contentBlock: {
				type: 'text',
				text: '',
			},
		})
		return block
	}

	const ensureToolUseBlock = async (
		index: number,
		options?: {
			itemId?: string | null
			callId?: string | null
			name?: string | null
		},
	) => {
		registerOutputIndex(state, index, options?.itemId ?? null)
		const existing = state.blocksByIndex.get(index)
		if (existing && existing.kind === 'tool_use') {
			if (options?.itemId && !existing.itemId) {
				existing.itemId = options.itemId
			}
			if (options?.callId && existing.toolUseId.startsWith('call_')) {
				existing.toolUseId = options.callId
			}
			if (options?.name && existing.name === 'unknown_tool') {
				existing.name = options.name
			}
			if (!existing.started) {
				existing.started = true
				await emit({
					type: 'content_block_start',
					index,
					contentBlock: {
						type: 'tool_use',
						id: existing.toolUseId,
						name: existing.name,
						input: {},
					},
				})
			}
			return existing
		}

		const block: Extract<CodexDirectStreamBlockState, { kind: 'tool_use' }> = {
			kind: 'tool_use',
			index,
			itemId: options?.itemId ?? null,
			started: true,
			closed: false,
			toolUseId:
				options?.callId ??
				(options?.itemId ? `call_${options.itemId}` : `call_${crypto.randomUUID()}`),
			name: options?.name ?? 'unknown_tool',
			arguments: '',
		}
		state.blocksByIndex.set(index, block)
		await emit({
			type: 'content_block_start',
			index,
			contentBlock: {
				type: 'tool_use',
				id: block.toolUseId,
				name: block.name,
				input: {},
			},
		})
		return block
	}

	const appendTextDelta = async (
		index: number,
		text: string,
		itemId?: string | null,
	) => {
		if (!text) {
			return
		}
		await ensureMessageStart(
			itemId ? { item_id: itemId, output_index: index } : { output_index: index },
		)
		const block = await ensureTextBlock(index, itemId)
		block.text += text
		await emit({
			type: 'content_block_delta',
			index,
			delta: {
				type: 'text_delta',
				text,
			},
		})
	}

	const appendToolArgumentsDelta = async (
		index: number,
		partialJson: string,
		options?: {
			itemId?: string | null
			callId?: string | null
			name?: string | null
		},
	) => {
		if (!partialJson) {
			return
		}
		await ensureMessageStart(
			options?.itemId
				? { item_id: options.itemId, output_index: index }
				: { output_index: index },
		)
		const block = await ensureToolUseBlock(index, options)
		block.arguments += partialJson
		await emit({
			type: 'content_block_delta',
			index,
			delta: {
				type: 'input_json_delta',
				partialJson,
			},
		})
	}

	const closeBlock = async (index: number) => {
		const block = state.blocksByIndex.get(index)
		if (!block || block.closed || !block.started) {
			return
		}

		block.closed = true
		await emit({
			type: 'content_block_stop',
			index,
		})
	}

	const closeAllBlocks = async () => {
		for (const block of getOrderedStreamBlocks(state)) {
			await closeBlock(block.index)
		}
	}

	const emitCompletedResponseOutput = async (completedResponse: CodexDirectResponsesResponse) => {
		for (const [index, item] of (completedResponse.output ?? []).entries()) {
			if (item.type === 'message' && item.role === 'assistant') {
				const completedText = (item.content ?? [])
					.filter(
						(block) =>
							(block.type === 'output_text' || block.type === 'text') &&
							typeof block.text === 'string',
					)
					.map((block) => block.text ?? '')
					.join('')
				const existing = state.blocksByIndex.get(index)
				const emittedText =
					existing && existing.kind === 'text' ? existing.text : ''
				const remainder = completedText.startsWith(emittedText)
					? completedText.slice(emittedText.length)
					: emittedText
						? ''
						: completedText
				if (remainder) {
					await appendTextDelta(index, remainder, existing?.itemId ?? null)
				}
				continue
			}

			if (item.type === 'function_call') {
				const existing = state.blocksByIndex.get(index)
				const emittedArgs =
					existing && existing.kind === 'tool_use' ? existing.arguments : ''
				const finalArgs = item.arguments ?? ''
				const remainder = finalArgs.startsWith(emittedArgs)
					? finalArgs.slice(emittedArgs.length)
					: emittedArgs
						? ''
						: finalArgs
					await ensureMessageStart({
						item_id: item.call_id ?? undefined,
						output_index: index,
					})
					await ensureToolUseBlock(index, {
						itemId: item.call_id ?? null,
						callId: item.call_id ?? null,
						name: item.name ?? null,
					})
				if (remainder) {
					await appendToolArgumentsDelta(index, remainder, {
						itemId: item.call_id ?? null,
						callId: item.call_id ?? null,
						name: item.name ?? null,
					})
				}
			}
		}
	}

	const completeStream = async (completedResponse: CodexDirectResponsesResponse) => {
		state.completed = true
		updateStreamIdentity(state, { response: completedResponse })
		await ensureMessageStart({ response: completedResponse })
		await emitCompletedResponseOutput(completedResponse)
		await closeAllBlocks()

		const stopReason = mapResponsesStopReason(
			completedResponse,
			getOrderedStreamBlocks(state).map((block) =>
				block.kind === 'text'
					? ({
							type: 'text',
							text: block.text,
						} satisfies CanonicalBridgeResponse['content'][number])
					: ({
							type: 'tool_use',
							id: block.toolUseId,
							name: block.name,
							input: parseToolArguments(block.arguments, block.name),
						} satisfies CanonicalBridgeResponse['content'][number]),
			),
		)
		const usage: CanonicalUsage = {
			inputTokens: completedResponse.usage?.input_tokens ?? 0,
			outputTokens: completedResponse.usage?.output_tokens ?? 0,
			cachedInputTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens:
				completedResponse.usage?.total_tokens ??
				(completedResponse.usage?.input_tokens ?? 0) +
					(completedResponse.usage?.output_tokens ?? 0),
		}

		await emit({
			type: 'message_delta',
			stopReason,
			stopSequence: null,
			usage,
		})
		await emit({
			type: 'message_stop',
		})

		const summary = summarizeStreamCompletion(state)
		await observer?.onComplete?.({
			stopReason,
			usage,
			finalText: summary.finalText,
			decision: summary.decision,
			metadata: {
				model: completedResponse.model ?? state.model ?? request.model,
				messageId: state.startedMessageId,
				upstreamResponseId: completedResponse.id ?? state.responseId ?? null,
				provisionalMessageId: state.messageStartedWithProvisionalId,
			},
		})
	}

	const shouldBufferBeforeMessageStart = (payload: CodexDirectSseEnvelope) => {
		if (state.messageStarted || state.responseId) {
			return false
		}

		switch (payload.type) {
			case 'response.created':
			case 'response.completed':
			case 'response.incomplete':
			case 'response.failed':
			case 'error':
				return false
			default:
				return true
		}
	}

	const enqueuePendingStartPayload = (payload: CodexDirectSseEnvelope) => {
		if (state.pendingStartPayloads.length === 0) {
			state.pendingStartBufferedAt = Date.now()
		}
		state.pendingStartPayloads.push(payload)
	}

	const shouldFlushPendingStartPayloads = () => {
		if (state.pendingStartPayloads.length === 0 || state.pendingStartBufferedAt == null) {
			return false
		}

		return (
			state.pendingStartPayloads.length >= PRESTART_BUFFER_EVENT_LIMIT ||
			Date.now() - state.pendingStartBufferedAt >= PRESTART_BUFFER_WINDOW_MS
		)
	}

	const flushPendingStartPayloads = async () => {
		if (state.pendingStartPayloads.length === 0) {
			state.pendingStartBufferedAt = null
			return
		}

		const buffered = [...state.pendingStartPayloads]
		state.pendingStartPayloads = []
		state.pendingStartBufferedAt = null
		for (const payload of buffered) {
			await processPayload(payload, { allowBuffer: false })
		}
	}

	const processPayload = async (
		payload: CodexDirectSseEnvelope,
		options?: { allowBuffer?: boolean },
	) => {
		if (options?.allowBuffer !== false && shouldBufferBeforeMessageStart(payload)) {
			enqueuePendingStartPayload(payload)
			return
		}

		updateStreamIdentity(state, payload)

		switch (payload.type) {
			case 'response.created':
				if (state.pendingStartPayloads.length > 0) {
					await flushPendingStartPayloads()
				}
				return
			case 'response.output_item.added': {
				const index = resolveOutputIndex(state, payload)
				if (payload.item?.type === 'function_call') {
					await ensureMessageStart(payload)
					await ensureToolUseBlock(index, {
						itemId: payload.item.id ?? payload.item_id ?? null,
						callId: payload.item.call_id ?? null,
						name: payload.item.name ?? null,
					})
					if (payload.item.arguments) {
						await appendToolArgumentsDelta(index, payload.item.arguments, {
							itemId: payload.item.id ?? payload.item_id ?? null,
							callId: payload.item.call_id ?? null,
							name: payload.item.name ?? null,
						})
					}
				} else {
					registerOutputIndex(state, index, payload.item?.id ?? payload.item_id ?? null)
				}
				return
			}
			case 'response.output_text.delta': {
				const index = resolveOutputIndex(state, payload)
				await appendTextDelta(index, typeof payload.delta === 'string' ? payload.delta : '', payload.item_id ?? null)
				return
			}
			case 'response.output_text.done': {
				const index = resolveOutputIndex(state, payload)
				const existing = state.blocksByIndex.get(index)
				const emittedText = existing && existing.kind === 'text' ? existing.text : ''
				const fullText = typeof payload.text === 'string' ? payload.text : ''
				const remainder = fullText.startsWith(emittedText)
					? fullText.slice(emittedText.length)
					: emittedText
						? ''
						: fullText
				if (remainder) {
					await appendTextDelta(index, remainder, payload.item_id ?? null)
				}
				return
			}
			case 'response.function_call_arguments.delta': {
				const index = resolveOutputIndex(state, payload)
				await appendToolArgumentsDelta(
					index,
					typeof payload.delta === 'string' ? payload.delta : '',
					{
						itemId: payload.item_id ?? null,
						callId: payload.item?.call_id ?? payload.item_id ?? null,
						name: payload.name ?? payload.item?.name ?? null,
					},
				)
				return
			}
			case 'response.function_call_arguments.done': {
				const index = resolveOutputIndex(state, payload)
				const existing = state.blocksByIndex.get(index)
				const emittedArgs =
					existing && existing.kind === 'tool_use' ? existing.arguments : ''
				const fullArgs = typeof payload.arguments === 'string' ? payload.arguments : ''
				const remainder = fullArgs.startsWith(emittedArgs)
					? fullArgs.slice(emittedArgs.length)
					: emittedArgs
						? ''
						: fullArgs
				if (remainder) {
					await appendToolArgumentsDelta(index, remainder, {
						itemId: payload.item_id ?? null,
						callId: payload.item?.call_id ?? payload.item_id ?? null,
						name: payload.name ?? payload.item?.name ?? null,
					})
				}
				await closeBlock(index)
				return
			}
			case 'response.output_item.done': {
				const index = resolveOutputIndex(state, payload)
				if (payload.item?.type === 'function_call') {
					const existing = state.blocksByIndex.get(index)
					const emittedArgs =
						existing && existing.kind === 'tool_use' ? existing.arguments : ''
					const fullArgs = payload.item.arguments ?? ''
					const remainder = fullArgs.startsWith(emittedArgs)
						? fullArgs.slice(emittedArgs.length)
						: emittedArgs
							? ''
							: fullArgs
					if (remainder) {
						await appendToolArgumentsDelta(index, remainder, {
							itemId: payload.item.id ?? payload.item_id ?? null,
							callId: payload.item.call_id ?? null,
							name: payload.item.name ?? null,
						})
					}
				}
				await closeBlock(index)
				return
			}
			case 'response.completed':
			case 'response.incomplete':
				if (payload.response) {
					if (state.pendingStartPayloads.length > 0) {
						await flushPendingStartPayloads()
					}
					await completeStream(payload.response)
					return
				}
				break
			case 'response.failed':
				throw new CodexDirectProviderError(
					payload.response?.error?.message?.trim() ||
						payload.error?.message?.trim() ||
						'codex-direct streaming request failed',
					{
						status: response.status,
						requestId: getRequestId(response.headers),
					},
				)
			case 'error':
				throw new CodexDirectProviderError(
					payload.error?.message?.trim() || 'codex-direct streaming request failed',
					{
						status: response.status,
						requestId: getRequestId(response.headers),
					},
				)
		}
	}

	try {
		let pendingRead: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null

		while (true) {
			if (shouldFlushPendingStartPayloads()) {
				await flushPendingStartPayloads()
				continue
			}

			let nextRead: Awaited<ReturnType<typeof reader.read>>
			if (state.pendingStartPayloads.length > 0 && state.pendingStartBufferedAt != null) {
				const remainingMs = Math.max(
					0,
					PRESTART_BUFFER_WINDOW_MS - (Date.now() - state.pendingStartBufferedAt),
				)
				pendingRead ??= reader.read()
				const winner = await Promise.race([
					pendingRead.then((result) => ({ kind: 'read' as const, result })),
					new Promise<{ kind: 'flush' }>((resolve) => {
						setTimeout(() => resolve({ kind: 'flush' }), remainingMs)
					}),
				])
				if (winner.kind === 'flush') {
					await flushPendingStartPayloads()
					continue
				}
				nextRead = winner.result
				pendingRead = null
			} else {
				nextRead = pendingRead ? await pendingRead : await reader.read()
				pendingRead = null
			}

			const { done, value } = nextRead
			if (done) {
				break
			}

			buffer += decoder.decode(value, { stream: true })
			const parts = buffer.split('\n\n')
			buffer = parts.pop() ?? ''
			for (const part of parts) {
				const parsed = parseSseBlock(part)
				if (!parsed || parsed.data === '[DONE]') {
					continue
				}
				await processPayload(JSON.parse(parsed.data) as CodexDirectSseEnvelope)
			}
		}

		buffer += decoder.decode()
		if (buffer.trim()) {
			const parsed = parseSseBlock(buffer)
			if (parsed && parsed.data !== '[DONE]') {
				await processPayload(JSON.parse(parsed.data) as CodexDirectSseEnvelope)
			}
		}
	} catch (error) {
		if (error instanceof CodexDirectProviderError) {
			throw error
		}
		throw new CodexDirectProviderError(
			`codex-direct request returned invalid SSE: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{
				status: response.status,
				requestId: getRequestId(response.headers),
			},
		)
	} finally {
		reader.releaseLock()
	}

	if (state.pendingStartPayloads.length > 0) {
		await flushPendingStartPayloads()
	}

	if (!state.completed) {
		throw new CodexDirectProviderError('codex-direct stream ended without a completed response', {
			status: response.status,
			requestId: getRequestId(response.headers),
		})
	}
}

function buildStreamCompletionSummary(response: CanonicalBridgeResponse): {
	finalText?: string
	decision?: {
		kind: 'assistant' | 'tool_use'
		name?: string
		input?: unknown
		preamble?: string | null
	}
} {
	const textParts: string[] = []
	let firstToolUse:
		| Extract<CanonicalBridgeResponse['content'][number], { type: 'tool_use' }>
		| null = null

	for (const block of response.content) {
		if (block.type === 'text' || block.type === 'thinking') {
			textParts.push(block.text)
			continue
		}
		if (block.type === 'tool_use' && !firstToolUse) {
			firstToolUse = block
		}
	}

	if (firstToolUse) {
		return {
			finalText: textParts.join(''),
			decision: {
				kind: 'tool_use',
				name: firstToolUse.name,
				input: firstToolUse.input,
				preamble: textParts.length > 0 ? textParts.join('') : null,
			},
		}
	}

	return {
		finalText: textParts.join(''),
		decision: {
			kind: 'assistant',
		},
	}
}

function createCanonicalEventStreamFromResponse(
	response: CanonicalBridgeResponse,
	observer?: ProviderStreamObserver,
): ReadableStream<CanonicalStreamEvent> {
	return new ReadableStream<CanonicalStreamEvent>({
		async start(controller) {
			const emit = async (event: CanonicalStreamEvent) => {
				await observer?.onEvent?.(event)
				controller.enqueue(event)
			}

			try {
				await emit({
					type: 'message_start',
					messageId: response.id,
					model: response.model,
					usage: {
						inputTokens: response.usage.inputTokens,
						outputTokens: 0,
						cachedInputTokens: response.usage.cachedInputTokens,
						reasoningOutputTokens: 0,
						totalTokens: response.usage.inputTokens,
					},
				})

				for (const [index, block] of response.content.entries()) {
					if (block.type === 'text' || block.type === 'thinking') {
						await emit({
							type: 'content_block_start',
							index,
							contentBlock: {
								type: block.type,
								text: '',
							},
						})
						await emit({
							type: 'content_block_delta',
							index,
							delta:
								block.type === 'thinking'
									? {
											type: 'thinking_delta',
											text: block.text,
										}
									: {
											type: 'text_delta',
											text: block.text,
										},
						})
						await emit({
							type: 'content_block_stop',
							index,
						})
						continue
					}

					if (block.type === 'tool_use') {
						await emit({
							type: 'content_block_start',
							index,
							contentBlock: {
								type: 'tool_use',
								id: block.id,
								name: block.name,
								input: {},
							},
						})
						await emit({
							type: 'content_block_delta',
							index,
							delta: {
								type: 'input_json_delta',
								partialJson: JSON.stringify(block.input),
							},
						})
						await emit({
							type: 'content_block_stop',
							index,
						})
					}
				}

				await emit({
					type: 'message_delta',
					stopReason: response.stopReason,
					stopSequence: response.stopSequence,
					usage: {
						inputTokens: response.usage.inputTokens,
						outputTokens: response.usage.outputTokens,
						cachedInputTokens: response.usage.cachedInputTokens,
						reasoningOutputTokens: response.usage.reasoningOutputTokens,
						totalTokens: response.usage.totalTokens,
					},
				})
				await emit({
					type: 'message_stop',
				})

				const summary = buildStreamCompletionSummary(response)
				await observer?.onComplete?.({
					stopReason: response.stopReason,
					usage: response.usage,
					finalText: summary.finalText,
					decision: summary.decision,
					metadata: {
						model: response.provider.rawModel ?? response.provider.model,
					},
				})
				controller.close()
			} catch (error) {
				await observer?.onError?.({
					error,
					metadata: {
						model: response.provider.rawModel ?? response.provider.model,
					},
				})
				controller.error(error)
			}
		},
		cancel() {
			void observer?.onCancel?.()
		},
	})
}

export function createCodexDirectAdapter(): BridgeProviderAdapter {
	return {
		providerId: 'codex-direct',
		legacyBackend: 'codex',
		healthBackend: 'codex_direct_api',
		async listModels(config: RouterConfig): Promise<CanonicalModelListingEntry[]> {
			return Object.keys(config.modelAliases).map((modelId) => ({
				exposedModel: toExposedModel(config, modelId),
				displayName: toExposedModel(config, modelId),
				providerId: 'codex-direct',
				providerModel: resolveModelAlias(config, modelId),
			}))
		},
		async execute(
			config: RouterConfig,
			request: CanonicalBridgeRequest,
			context?: ProviderExecutionContext,
			): Promise<CanonicalBridgeResponse> {
				const requestSignal = asSignalPair(
					context?.abortSignal,
					config.codexDirectRequestTimeoutMs,
				)
				try {
					const response = await fetch(
						buildCodexDirectUrl(config, DEFAULT_CODEX_DIRECT_REQUEST_PATH),
						{
						method: 'POST',
						headers: await buildHeaders(config, requestSignal.signal),
						signal: requestSignal.signal,
						body: JSON.stringify(buildCodexDirectRequestBody(request)),
						},
					)

				if (!response.ok) {
					const rawBody = await response.text()
					const preview = summarizeBodyPreview(rawBody)
					throw new CodexDirectProviderError(
						`codex-direct request failed with status ${response.status}${
							preview ? `: ${preview}` : ''
						}`,
						{
							status: response.status,
							requestId: getRequestId(response.headers),
							responseBodyPreview: preview,
						},
					)
				}

					const payload =
						response.headers.get('content-type')?.includes('text/event-stream')
							? await parseCodexDirectSseResponse(response)
							: await parseJsonBody<OpenAiChatCompletionResponse | CodexDirectResponsesResponse>(
									response,
									'request',
								)
					return toCanonicalResponse(request, payload)
				} finally {
					requestSignal.cleanup()
			}
		},
		stream(
			config: RouterConfig,
			request: CanonicalBridgeRequest,
			context?: ProviderExecutionContext,
			observer?: ProviderStreamObserver,
		): ReadableStream<CanonicalStreamEvent> {
			let activeRequestSignal: ReturnType<typeof asSignalPair> | null = null
			let cancelled = false
			return new ReadableStream<CanonicalStreamEvent>({
				async start(controller) {
					const requestSignal = asSignalPair(
						context?.abortSignal,
						config.codexDirectRequestTimeoutMs,
					)
					activeRequestSignal = requestSignal

					try {
						const response = await fetch(
							buildCodexDirectUrl(config, DEFAULT_CODEX_DIRECT_REQUEST_PATH),
							{
								method: 'POST',
								headers: await buildHeaders(config, requestSignal.signal),
								signal: requestSignal.signal,
								body: JSON.stringify(buildCodexDirectRequestBody(request)),
							},
						)

						if (!response.ok) {
							const rawBody = await response.text()
							const preview = summarizeBodyPreview(rawBody)
							throw new CodexDirectProviderError(
								`codex-direct request failed with status ${response.status}${
									preview ? `: ${preview}` : ''
								}`,
								{
									status: response.status,
									requestId: getRequestId(response.headers),
									responseBodyPreview: preview,
								},
							)
						}

						if (response.headers.get('content-type')?.includes('application/json')) {
							const payload = await parseJsonBody<
								OpenAiChatCompletionResponse | CodexDirectResponsesResponse
							>(response, 'request')
							const canonicalResponse = toCanonicalResponse(request, payload)
							await observer?.onSessionReady?.({
								model: canonicalResponse.model,
								messageId: canonicalResponse.id,
								upstreamResponseId: canonicalResponse.id,
								provisionalMessageId: false,
							})
							const replayStream = createCanonicalEventStreamFromResponse(
								canonicalResponse,
								observer,
							)
							const reader = replayStream.getReader()
							try {
								while (true) {
									const { done, value } = await reader.read()
									if (done) {
										break
									}
									controller.enqueue(value)
								}
								controller.close()
							} finally {
								reader.releaseLock()
							}
						} else {
							await streamCodexDirectSseToCanonical(response, request, controller, observer)
							controller.close()
						}
					} catch (error) {
						if (cancelled) {
							return
						}
						await observer?.onError?.({
							error,
							metadata: {
								model: request.model,
							},
						})
						controller.error(error)
					} finally {
						requestSignal.cleanup()
						activeRequestSignal = null
					}
				},
				cancel() {
					cancelled = true
					activeRequestSignal?.abort('stream cancelled by consumer')
					void observer?.onCancel?.()
				},
			})
		},
		getHealth(config: RouterConfig): CanonicalProviderHealth {
			const auth = getCodexDirectAuthHealth(config)
			return {
				providerId: 'codex-direct',
				live: true,
				readiness: auth.ready ? 'ready' : 'degraded',
				auth: {
					mode: config.codexDirectAuthMode,
					dependencyOk: auth.ready,
					message: auth.message,
				},
				model: config.providerRouting.providerDefaults['codex-direct'] ?? null,
				metadata: {
					baseUrl: config.codexDirectBaseUrl ?? DEFAULT_CODEX_DIRECT_BASE_URL,
					rollout: config.codexDirectRollout,
					authState: auth.state,
					hasStoredState: auth.hasStoredState,
				},
			}
		},
	}
}
