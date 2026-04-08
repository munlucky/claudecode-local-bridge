import type { RouterConfig } from '../../server/config.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
	AnthropicToolDefinition,
	AnthropicToolUseBlock,
	JsonObject,
} from '../../shared/index.js'
import { AnthropicRequestValidationError } from '../anthropic/compat.js'
import type { StreamLifecycleLoggerLike } from '../backend-provider.js'
import { appendRuntimeLog } from '../../observability/runtime-log.js'

type HeadersInit = Record<string, string> | string[][] | { [key: string]: string }

type OllamaToolChoice =
	| 'none'
	| 'auto'
	| {
			type: 'function'
			function: {
				name: string
			}
	  }

type OllamaDoneReason =
	| 'stop'
	| 'eos'
	| 'tool_calls'
	| 'tool_use'
	| 'length'
	| 'stop_sequence'
	| 'max_tokens'
	| string

type OllamaStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

type OllamaRawToolCall = {
	id?: string
	function?: {
		name?: string
		arguments?: JsonObject | string
		index?: number
	}
}

type OpenAIChatMessage = {
	role?: string
	content?: string
	thinking?: string
	tool_calls?: Array<{
		index?: number
		id?: string
		type?: string
		function?: {
			name?: string
			arguments?: JsonObject | string
		}
	}>
}

type OpenAIChatChoice = {
	index?: number
	message?: OpenAIChatMessage
	delta?: OpenAIChatMessage
	finish_reason?: string
}

type OpenAIChatResponse = {
	id?: string
	object?: string
	model?: string
	choices?: OpenAIChatChoice[]
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
}

type OllamaLikeResponse = OllamaRawResponse | OpenAIChatResponse

type OpenAIToolCallAccumulatorEntry = {
	key: string
	id?: string
	index?: number
	functionName: string
	argumentsText: string
}

type OllamaResponseShape = 'ollama' | 'openai'

type OllamaRawMessage = {
	role?: string
	content?: string
	thinking?: string
	tool_calls?: OllamaRawToolCall[]
}

type OllamaRawResponse = {
	model?: string
	message?: OllamaRawMessage
	done?: boolean
	done_reason?: string
	prompt_eval_count?: number
	eval_count?: number
	total_duration?: number
	load_duration?: number
	eval_duration?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getResponseShape(response: OllamaLikeResponse | unknown): OllamaResponseShape {
	if (!isObject(response)) {
		return 'ollama'
	}

	if (isOpenAIChatResponse(response)) {
		return 'openai'
	}

	return 'ollama'
}

export type OllamaProviderModel = {
	model: string
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError'
}

function asSignalPair(requestSignal: AbortSignal | null | undefined, timeoutMs: number) {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort(new Error(`ollama 요청이 ${timeoutMs}ms 내에 완료되지 않았습니다.`))
	}, timeoutMs)

	const listeners: Array<() => void> = []
	if (requestSignal) {
		const abortFromRequest = () => {
			controller.abort(
				requestSignal.reason instanceof Error ? requestSignal.reason : new Error('요청이 중단되었습니다.'),
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
		cleanup() {
			clearTimeout(timeout)
			for (const remove of listeners) {
				remove()
			}
		},
	}
}

function buildHeaders(config: RouterConfig): HeadersInit {
	const headers: HeadersInit = {
		'Content-Type': 'application/json',
	}
	if (config.ollamaApiKey) {
		headers.Authorization = `Bearer ${config.ollamaApiKey}`
	}
	return headers
}

function logOllamaRawSnapshot(
	config: RouterConfig,
	phase: 'non-stream' | 'stream',
	payload: OllamaLikeResponse,
	context?: {
		routerRequestId?: string | null
	},
) {
	const shape = getResponseShape(payload)
	const content = extractContent(payload)
	const thinking = extractThinking(payload)
	const toolCalls = extractToolCalls(payload)
	const usage = extractUsageCounts(payload)
	const openAIChoices = isOpenAIChatResponse(payload) ? payload.choices ?? [] : []
	const hasChoices = shape === 'openai'
	const summary = {
		shape,
		top_level_keys: Object.keys(isObject(payload) ? payload : {}).sort(),
		has_choices: hasChoices,
		choices_count: hasChoices ? openAIChoices.length : 0,
		phase,
		router_request_id: context?.routerRequestId ?? null,
		model: payload.model ?? null,
		done: isOpenAIChatResponse(payload) ? null : payload.done ?? null,
		done_reason: isOpenAIChatResponse(payload) ? null : payload.done_reason ?? null,
		done_reason_openai:
			shape === 'openai'
				? (openAIChoices[0]?.finish_reason ?? null)
				: null,
		content_length: typeof content === 'string' ? content.length : null,
		content_preview:
			typeof content === 'string' && content.length > 0 ? content.slice(0, 160) : null,
		thinking_length: typeof thinking === 'string' ? thinking.length : null,
		thinking_preview:
			typeof thinking === 'string' && thinking.length > 0 ? thinking.slice(0, 160) : null,
		tool_call_count: toolCalls.length,
		tool_call_names: toolCalls
			.map((toolCall) => toolCall.function?.name ?? null)
			.filter((name): name is string => Boolean(name)),
		prompt_eval_count: usage.promptEvalCount,
		eval_count: usage.evalCount,
		total_tokens: usage.totalTokens,
	}
	process.stdout.write(`[ollama-raw] ${JSON.stringify(summary)}\n`)
	const logPath = join(process.cwd(), '.history', 'ollama-raw.jsonl')
	void mkdir(dirname(logPath), { recursive: true })
		.then(() =>
			appendFile(
				logPath,
				`${JSON.stringify({
					timestamp: new Date().toISOString(),
					...summary,
				})}\n`,
				'utf8',
			),
		)
		.catch(() => undefined)
	void appendRuntimeLog(config, {
		channel: '04-ollama-raw',
		routerRequestId: context?.routerRequestId ?? null,
		payload: summary as unknown as Record<string, unknown>,
	})
}

function logOllamaRawLineIssue(
	config: RouterConfig,
	line: string,
	reason: 'unsupported-sse-meta' | 'parse-failed',
	context?: {
		routerRequestId?: string | null
	},
) {
	const summary = {
		timestamp: new Date().toISOString(),
		phase: 'stream-line',
		reason,
		router_request_id: context?.routerRequestId ?? null,
		line_preview: line.slice(0, 240),
		line_length: line.length,
	}
	process.stdout.write(`[ollama-raw-line] ${JSON.stringify(summary)}\n`)
	const logPath = join(process.cwd(), '.history', 'ollama-raw-lines.jsonl')
	void mkdir(dirname(logPath), { recursive: true })
		.then(() => appendFile(logPath, `${JSON.stringify(summary)}\n`, 'utf8'))
		.catch(() => undefined)
	void appendRuntimeLog(config, {
		channel: '05-ollama-raw-lines',
		routerRequestId: context?.routerRequestId ?? null,
		payload: summary as unknown as Record<string, unknown>,
	})
}

function parseModelFromArguments(raw: string | JsonObject | undefined): JsonObject {
	if (!raw) {
		return {}
	}

	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw)
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as JsonObject)
				: {}
		} catch {
			return {}
		}
	}

	return raw
}

function normalizeToolChoice(value: unknown): OllamaToolChoice | undefined {
	if (!value) {
		return undefined
	}

	if (value === 'none' || value === 'auto' || value === 'any') {
		return value === 'any' ? 'auto' : value
	}

	if (typeof value === 'object' && value !== null) {
		const maybe = value as Record<string, unknown>

		if (maybe.type === 'none') {
			return 'none'
		}

		if (maybe.type === 'tool' && typeof maybe.name === 'string' && maybe.name.trim()) {
			return {
				type: 'function',
				function: {
					name: maybe.name,
				},
			}
		}
	}

	return undefined
}

function mapOllamaDoneReason(
	doneReason: OllamaDoneReason | undefined,
	hasToolCalls: boolean,
): OllamaStopReason {
	if (hasToolCalls) {
		return 'tool_use'
	}

	if (!doneReason) {
		return 'end_turn'
	}

	switch (doneReason) {
		case 'stop':
		case 'eos':
			return 'end_turn'
		case 'tool_calls':
		case 'tool_use':
			return 'end_turn'
		case 'length':
		case 'max_tokens':
			return 'max_tokens'
		case 'stop_sequence':
			return 'stop_sequence'
		default:
			return 'end_turn'
	}
}

function mapAnthropicContentToText(content: unknown): string {
	if (typeof content === 'string') {
		return content
	}

	if (!Array.isArray(content)) {
		return ''
	}

	return content
		.map((block) => {
			if (!block || typeof block !== 'object') {
				return ''
			}

			const typed = block as Record<string, unknown>
			if (typed.type === 'text' && typeof typed.text === 'string') {
				return typed.text
			}

			if (typed.type === 'tool_use') {
				return ''
			}

			if (typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
				const resultText = mapAnthropicContentToText(typed.content)
				if (resultText.trim()) {
					return `Tool result (${typed.tool_use_id}): ${resultText}`
				}
				return `Tool result (${typed.tool_use_id}).`
			}

			return ''
		})
		.filter(Boolean)
		.join('\n')
}

function buildRequestMessages(request: AnthropicMessagesRequest) {
	const messages = request.messages.map((message) => ({
		role: message.role === 'assistant' ? 'assistant' : 'user',
		content: mapAnthropicContentToText(message.content),
	}))

	if (typeof request.system === 'string' ? request.system.trim() : false) {
		messages.unshift({
			role: 'system',
			content: mapAnthropicContentToText(request.system),
		})
	}

	return messages
		.filter((message) => Boolean(message.content))
		.map((message) => ({
			role: message.role,
			content: message.content,
		}))
}

function buildToolPayload(request: AnthropicMessagesRequest) {
	if (!request.tools?.length) {
		return undefined
	}

	return request.tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.input_schema,
		},
	}))
}

function resolveModel(config: RouterConfig, requestedModel: string): string {
	const trimmed = requestedModel.trim()
	if (!trimmed) {
		return config.ollamaModel
	}

	if (trimmed.includes(':') || trimmed.includes('/')) {
		return trimmed
	}

	const aliased = config.modelAliases[trimmed]
	return aliased ?? config.ollamaModel
}

export async function listOllamaModels(
	config: RouterConfig,
	abortSignal?: AbortSignal | null,
): Promise<OllamaProviderModel[]> {
	const requestSignal = asSignalPair(abortSignal, config.ollamaRequestTimeoutMs)
	try {
		const response = await fetch(new URL('/api/tags', config.ollamaBaseUrl), {
			method: 'GET',
			headers: buildHeaders(config),
			signal: requestSignal.signal,
		})

		if (!response.ok) {
			throw new Error(`/api/tags 호출 실패: ${response.status} ${response.statusText}`)
		}

		const payload = (await response.json()) as { models?: Array<{ model?: string; name?: string }> }
		const models = Array.isArray(payload.models) ? payload.models : []
		const mapped = models
			.map((entry) => ({
				model: typeof entry.model === 'string' && entry.model.trim() ? entry.model : String(entry.name ?? ''),
			}))
			.filter((item): item is OllamaProviderModel => Boolean(item.model))
			.sort((a, b) => a.model.localeCompare(b.model))

		if (mapped.length > 0) {
			return mapped
		}

		return [{ model: config.ollamaModel }]
	} finally {
		requestSignal.cleanup()
	}
}

export function buildOllamaRequestBody(config: RouterConfig, request: AnthropicMessagesRequest) {
	const model = resolveModel(config, request.model)
	const toolChoice = normalizeToolChoice(request.tool_choice)
	const messages = buildRequestMessages(request)
	return {
		model,
		stream: Boolean(request.stream),
		messages,
		tools: buildToolPayload(request),
		tool_choice: toolChoice,
		options: {
			...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
			...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
			...(typeof request.top_k === 'number' ? { top_k: request.top_k } : {}),
		},
	}
}

function normalizeToolCalls(raw: OllamaRawToolCall[] | undefined): OllamaRawToolCall[] {
	if (!raw?.length) {
		return []
	}

	return raw
		.filter((toolCall) => Boolean(toolCall?.function?.name))
		.map((toolCall) => ({
			id: toolCall.id?.trim() || `call_${crypto.randomUUID()}`,
			function: {
				name: toolCall.function?.name?.trim(),
				arguments: parseModelFromArguments(toolCall.function?.arguments),
				index: toolCall.function?.index,
			},
		}))
}

function getOpenAIChoice(payload: OpenAIChatResponse): OpenAIChatChoice | null {
	if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
		return null
	}

	const first = payload.choices[0]
	return first && typeof first === 'object' ? first : null
}

function getOpenAiChoicePayload(payload: OpenAIChatResponse): OpenAIChatMessage | null {
	const choice = getOpenAIChoice(payload)
	if (!choice) {
		return null
	}

	const fromMessage = choice.message
	if (fromMessage && typeof fromMessage === 'object') {
		return fromMessage
	}

	const fromDelta = choice.delta
	if (fromDelta && typeof fromDelta === 'object') {
		return fromDelta
	}

	return null
}

function normalizeOpenAICalls(rawToolCalls?: OpenAIChatMessage['tool_calls']): OllamaRawToolCall[] {
	if (!rawToolCalls?.length) {
		return []
	}

	return rawToolCalls
		.filter((toolCall) => {
			const name =
				toolCall?.function && typeof toolCall.function === 'object'
					? toolCall.function.name
					: undefined
			return Boolean(typeof name === 'string' && name.trim())
		})
		.map((toolCall) => ({
			id: toolCall?.id?.trim() || `call_${crypto.randomUUID()}`,
			function: {
				name: typeof toolCall?.function === 'object' ? toolCall.function?.name?.trim() : undefined,
				arguments: parseModelFromArguments(
					typeof toolCall?.function === 'object' ? toolCall.function?.arguments : undefined,
				),
				index: typeof toolCall?.index === 'number' ? toolCall.index : undefined,
			},
		}))
}

function buildOpenAIToolCallAccumulatorKey(
	toolCall: NonNullable<OpenAIChatMessage['tool_calls']>[number],
	position: number,
): string {
	if (typeof toolCall?.index === 'number') {
		return `index:${toolCall.index}`
	}

	if (typeof toolCall?.id === 'string' && toolCall.id.trim()) {
		return `id:${toolCall.id.trim()}`
	}

	return `position:${position}`
}

function accumulateOpenAIToolCalls(
	accumulator: Map<string, OpenAIToolCallAccumulatorEntry>,
	rawToolCalls?: OpenAIChatMessage['tool_calls'],
) {
	if (!rawToolCalls?.length) {
		return
	}

	for (const [position, toolCall] of rawToolCalls.entries()) {
		const key = buildOpenAIToolCallAccumulatorKey(toolCall, position)
		const existing = accumulator.get(key) ?? {
			key,
			functionName: '',
			argumentsText: '',
		}

		if (typeof toolCall?.id === 'string' && toolCall.id.trim()) {
			existing.id = toolCall.id.trim()
		}

		if (typeof toolCall?.index === 'number') {
			existing.index = toolCall.index
		}

		if (toolCall?.function && typeof toolCall.function === 'object') {
			if (typeof toolCall.function.name === 'string' && toolCall.function.name.length > 0) {
				existing.functionName += toolCall.function.name
			}

			if (typeof toolCall.function.arguments === 'string' && toolCall.function.arguments.length > 0) {
				existing.argumentsText += toolCall.function.arguments
			}

			if (isObject(toolCall.function.arguments)) {
				existing.argumentsText = JSON.stringify(toolCall.function.arguments)
			}
		}

		accumulator.set(key, existing)
	}
}

function finalizeAccumulatedOpenAIToolCalls(
	accumulator: Map<string, OpenAIToolCallAccumulatorEntry>,
): OllamaRawToolCall[] {
	return Array.from(accumulator.values())
		.sort((left, right) => {
			const leftIndex = typeof left.index === 'number' ? left.index : Number.MAX_SAFE_INTEGER
			const rightIndex = typeof right.index === 'number' ? right.index : Number.MAX_SAFE_INTEGER
			return leftIndex - rightIndex
		})
		.map((entry) => ({
			id: entry.id?.trim() || `call_${crypto.randomUUID()}`,
			function: {
				name: entry.functionName.trim() || undefined,
				arguments: parseModelFromArguments(entry.argumentsText),
				index: entry.index,
			},
		}))
		.filter((toolCall) => Boolean(toolCall.function?.name))
}

function isOpenAIChatResponse(response: OllamaLikeResponse): response is OpenAIChatResponse {
	if (!isObject(response)) {
		return false
	}

	return Array.isArray((response as Record<string, unknown>).choices)
}

function extractContent(response: OllamaLikeResponse): string | undefined {
	if (isOpenAIChatResponse(response)) {
		const choicePayload = getOpenAiChoicePayload(response)
		return choicePayload?.content
	}

	return response.message?.content
}

function extractThinking(response: OllamaLikeResponse): string | undefined {
	if (isOpenAIChatResponse(response)) {
		const choicePayload = getOpenAiChoicePayload(response)
		return choicePayload?.thinking
	}

	return response.message?.thinking
}

function extractToolCalls(response: OllamaLikeResponse): OllamaRawToolCall[] {
	if (isOpenAIChatResponse(response)) {
		const choicePayload = getOpenAiChoicePayload(response)
		return normalizeOpenAICalls(choicePayload?.tool_calls)
	}

	return normalizeToolCalls(response.message?.tool_calls)
}

function extractDoneReason(response: OllamaLikeResponse): string | undefined {
	if (isOpenAIChatResponse(response)) {
		const choice = getOpenAIChoice(response)
		return choice?.finish_reason
	}

	return response.done_reason
}

function extractUsageCounts(response: OllamaLikeResponse) {
	if (isOpenAIChatResponse(response)) {
		return {
			promptEvalCount:
				typeof response.usage?.prompt_tokens === 'number' ? response.usage.prompt_tokens : null,
			evalCount:
				typeof response.usage?.completion_tokens === 'number' ? response.usage.completion_tokens : null,
			totalTokens:
				typeof response.usage?.total_tokens === 'number' ? response.usage.total_tokens : null,
		}
	}

	return {
		promptEvalCount: typeof response.prompt_eval_count === 'number' ? response.prompt_eval_count : null,
		evalCount: typeof response.eval_count === 'number' ? response.eval_count : null,
		totalTokens: null,
	}
}

function buildAllowedToolMap(tools?: AnthropicToolDefinition[]): Map<string, AnthropicToolDefinition> {
	return new Map(
		(tools ?? [])
			.filter((tool): tool is AnthropicToolDefinition => Boolean(tool?.name?.trim()))
			.map((tool) => [tool.name, tool]),
	)
}

function hasRequiredToolArguments(tool: AnthropicToolDefinition | undefined, input: JsonObject): boolean {
	if (!tool || !isObject(tool.input_schema)) {
		return true
	}

	const required = Array.isArray(tool.input_schema.required)
		? tool.input_schema.required.filter((value): value is string => typeof value === 'string' && value.length > 0)
		: []

	if (required.length === 0) {
		return true
	}

	const properties = isObject(tool.input_schema.properties) ? tool.input_schema.properties : {}
	return required.every((field) => {
		if (!(field in input)) {
			return false
		}

		const value = input[field]
		if (typeof value === 'string') {
			return value.trim().length > 0
		}

			const propertySchema = properties[field]
			if (isObject(propertySchema) && propertySchema.type === 'string') {
				return false
			}

		return value !== undefined && value !== null
	})
}

function parseBracketToolUseText(
	content: string | undefined,
	allowedTools?: Map<string, AnthropicToolDefinition>,
): OllamaRawToolCall | null {
	if (typeof content !== 'string') {
		return null
	}

	const trimmed = content.trim()
	const match = /^\[tool_use\s+name=([^\s\]]+)\s+args=([\s\S]*)\]$/.exec(trimmed)
	if (!match) {
		return null
	}

	const [, name, rawArgs] = match
	if (!name || typeof rawArgs !== 'string') {
		return null
	}

	if (allowedTools && allowedTools.size > 0 && !allowedTools.has(name)) {
		return null
	}

	const parsedArguments = parseModelFromArguments(rawArgs)
	if (!hasRequiredToolArguments(allowedTools?.get(name), parsedArguments)) {
		return null
	}

	return {
		id: `call_${crypto.randomUUID()}`,
		function: {
			name,
			arguments: parsedArguments,
		},
	}
}

function filterToolCallsBySchema(
	toolCalls: OllamaRawToolCall[],
	allowedTools?: Map<string, AnthropicToolDefinition>,
): OllamaRawToolCall[] {
	if (!toolCalls.length) {
		return []
	}

	return toolCalls.filter((toolCall) => {
		const name = toolCall.function?.name?.trim()
		if (!name) {
			return false
		}

		if (allowedTools && allowedTools.size > 0 && !allowedTools.has(name)) {
			return false
		}

		const parsedArguments = parseModelFromArguments(toolCall.function?.arguments)
		return hasRequiredToolArguments(allowedTools?.get(name), parsedArguments)
	})
}

function isPossibleBracketToolUsePrefix(content: string): boolean {
	const trimmed = content.trimStart()
	if (!trimmed) {
		return false
	}

	const prefix = '[tool_use'
	return prefix.startsWith(trimmed) || trimmed.startsWith(prefix)
}

export function mapToolCallsToAnthropicContent(
	toolCalls?: OllamaRawToolCall[],
): AnthropicResponseContentBlock[] {
	if (!toolCalls?.length) {
		return []
	}

	return toolCalls
		.filter((toolCall) => Boolean(toolCall?.function?.name))
		.map((toolCall) => ({
			type: 'tool_use',
			id: toolCall.id ?? `toolu_${crypto.randomUUID()}`,
			name: toolCall.function?.name?.trim() || 'tool',
			input: parseModelFromArguments(toolCall.function?.arguments),
		} satisfies AnthropicToolUseBlock))
}

function mapOllamaUsageToAnthropic(response: OllamaLikeResponse) {
	const counts = extractUsageCounts(response)
	const promptTokens = counts.promptEvalCount ?? 0
	const completionTokens = counts.evalCount ?? 0
	const openAiTotal = counts.totalTokens
	const fallbackTotal = counts.promptEvalCount && counts.evalCount ? counts.promptEvalCount + counts.evalCount : null

	return {
		input_tokens: promptTokens,
		output_tokens: completionTokens,
		total_tokens: typeof openAiTotal === 'number' ? openAiTotal : (fallbackTotal ?? promptTokens + completionTokens),
		cache_read_input_tokens: 0,
		reasoning_output_tokens: 0,
	}
}

function normalizeUsage(
	previous: ReturnType<typeof mapOllamaUsageToAnthropic>,
	next: OllamaLikeResponse,
) {
	const incoming = mapOllamaUsageToAnthropic(next)
	return {
		input_tokens: Math.max(previous.input_tokens, incoming.input_tokens),
		output_tokens: Math.max(previous.output_tokens, incoming.output_tokens),
		total_tokens: Math.max(previous.total_tokens, incoming.total_tokens),
		cache_read_input_tokens: Math.max(
			previous.cache_read_input_tokens,
			incoming.cache_read_input_tokens,
		),
		reasoning_output_tokens: Math.max(
			previous.reasoning_output_tokens,
			incoming.reasoning_output_tokens,
		),
	}
}

export function mapOllamaTurnToAnthropic(
	response: OllamaLikeResponse,
	requestedModel: string,
	tools?: AnthropicToolDefinition[],
): AnthropicMessagesResponse {
	const contentText = extractContent(response)
	const allowedTools = buildAllowedToolMap(tools)
	const extractedToolCalls = filterToolCallsBySchema(extractToolCalls(response), allowedTools)
	const fallbackTextToolCall =
		extractedToolCalls.length === 0
			? parseBracketToolUseText(contentText, allowedTools)
			: null
	const toolCalls = mapToolCallsToAnthropicContent(
		fallbackTextToolCall ? [fallbackTextToolCall] : extractedToolCalls,
	)
	const usage = mapOllamaUsageToAnthropic(response)
	const content: AnthropicResponseContentBlock[] = []

	if (!fallbackTextToolCall && typeof contentText === 'string' && contentText.length > 0) {
		content.push({
			type: 'text',
			text: contentText,
		})
	}

	if (toolCalls.length > 0) {
		content.push(...toolCalls)
	}

	if (!content.length) {
		content.push({
			type: 'text',
			text: '',
		})
	}

	const stopReason = mapOllamaDoneReason(extractDoneReason(response) as OllamaDoneReason, toolCalls.length > 0)

	return {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		model: response.model ?? requestedModel,
		content,
		stop_reason: stopReason,
		stop_sequence: null,
		usage,
	}
}

export async function runOllamaTurn(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: {
		sessionId?: string | null
		routerRequestId?: string | null
		userAgent?: string | null
		abortSignal?: AbortSignal | null
	},
): Promise<{
	response: AnthropicMessagesResponse
}> {
	if (request.tools?.length) {
		validateToolRequestTools(request)
	}

	const payload = buildOllamaRequestBody(config, request)
	payload.stream = false
	const requestSignal = asSignalPair(context?.abortSignal, config.ollamaRequestTimeoutMs)
	try {
		const response = await fetch(new URL('/api/chat', config.ollamaBaseUrl), {
			method: 'POST',
			headers: buildHeaders(config),
			body: JSON.stringify(payload),
			signal: requestSignal.signal,
		})

		if (!response.ok) {
			throw new Error(`/api/chat 호출 실패: ${response.status} ${response.statusText}`)
		}

		const body = (await response.json()) as OllamaLikeResponse
		if (typeof body !== 'object' || body === null) {
			throw new Error('Ollama 응답 형식이 유효하지 않습니다.')
		}
		logOllamaRawSnapshot(config, 'non-stream', body, {
			routerRequestId: context?.routerRequestId,
		})

		return {
			response: mapOllamaTurnToAnthropic(
				body,
				request.model,
				request.tools,
			),
		}
	} finally {
		requestSignal.cleanup()
	}
}

function formatSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function parseStreamChunk(
	config: RouterConfig,
	line: string,
	context?: {
		routerRequestId?: string | null
	},
): OllamaLikeResponse | null {
	const trimmed = line.trim()
	if (!trimmed) {
		return null
	}

	if (trimmed.startsWith('event:')) {
		logOllamaRawLineIssue(config, trimmed, 'unsupported-sse-meta', context)
		return null
	}

	const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
	if (!payload) {
		return null
	}

	if (payload === '[DONE]') {
		return {
			object: 'chat.completion.chunk',
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: 'stop',
				},
			],
		}
	}

	try {
		const parsed = JSON.parse(payload) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as OllamaLikeResponse)
			: null
	} catch {
		logOllamaRawLineIssue(config, payload, 'parse-failed', context)
		return null
	}
}

function validateToolRequestTools(request: AnthropicMessagesRequest) {
	if (!request.tools?.length) {
		return
	}

	if (!request.tools.every((tool) => typeof tool.name === 'string' && tool.name.trim())) {
		throw new AnthropicRequestValidationError('tool.name은 비어 있을 수 없습니다.', 400)
	}
}

function buildToolBlocksFromRawToolCalls(toolCalls: OllamaRawToolCall[]) {
	const normalized = mapToolCallsToAnthropicContent(toolCalls)
	const contentBlocks: Array<{ index: number; block: AnthropicToolUseBlock }> = []

	for (const [offset, block] of normalized.entries()) {
		contentBlocks.push({
			index: offset,
			block: block as AnthropicToolUseBlock,
		})
	}

	return contentBlocks
}

function dedupeToolCallsById(toolCalls: OllamaRawToolCall[]) {
	const map = new Map<string, OllamaRawToolCall>()
	for (const toolCall of toolCalls) {
		if (!toolCall?.id) {
			continue
		}
		map.set(toolCall.id, toolCall)
	}
	return Array.from(map.values())
}

export function streamOllamaTurn(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	context?: {
		sessionId?: string | null
		routerRequestId?: string | null
		userAgent?: string | null
		abortSignal?: AbortSignal | null
	},
	logger?: StreamLifecycleLoggerLike,
): ReadableStream<Uint8Array> {
	const payload = buildOllamaRequestBody(config, request)
	payload.stream = true
	const requestModel = resolveModel(config, request.model)
	const hasTools = Boolean(request.tools?.length)
	const requestSignal = asSignalPair(context?.abortSignal, config.ollamaRequestTimeoutMs)

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const safeEnqueue = (payloadBytes: Uint8Array): boolean => {
				try {
					controller.enqueue(payloadBytes)
					return true
				} catch {
					return false
				}
			}

			const safeClose = () => {
				try {
					controller.close()
				} catch {}
			}

			const stopStream = (reason: OllamaStopReason, usageOutput = 0) => {
				safeEnqueue(
					formatSse('message_delta', {
						type: 'message_delta',
						delta: {
							stop_reason: reason,
							stop_sequence: null,
						},
						usage: {
							output_tokens: usageOutput,
						},
					}),
				)
				safeEnqueue(
					formatSse('message_stop', {
						type: 'message_stop',
					}),
				)
				safeClose()
				didComplete = true
			}

			const sendMessageStart = (model: string) => {
				safeEnqueue(
					formatSse('message_start', {
						type: 'message_start',
						message: {
							id: `msg_${crypto.randomUUID()}`,
							type: 'message',
							role: 'assistant',
							model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: {
								input_tokens: usage.input_tokens,
								output_tokens: usage.output_tokens,
							},
						},
					}),
				)
			}

			const sendTextDelta = (delta: string) => {
				if (!delta) {
					return
				}

				if (!textStreamStarted) {
					textStreamStarted = true
					safeEnqueue(
						formatSse('content_block_start', {
							type: 'content_block_start',
							index: 0,
							content_block: {
								type: 'text',
								text: '',
							},
						}),
					)
				}

				safeEnqueue(
					formatSse('content_block_delta', {
						type: 'content_block_delta',
						index: 0,
						delta: {
							type: 'text_delta',
							text: delta,
						},
					}),
				)
			}

			const flushTextStop = () => {
				if (!textStreamStarted) {
					return
				}

				safeEnqueue(
					formatSse('content_block_stop', {
						type: 'content_block_stop',
						index: 0,
					}),
				)
			}

			const flushToolBlocks = () => {
				if (toolBlocksFlushed) {
					return
				}

				const tools = buildToolBlocksFromRawToolCalls(getResolvedToolCalls())
				for (const { index, block } of tools) {
					const blockIndex = textStreamStarted ? index + 1 : index
					safeEnqueue(
						formatSse('content_block_start', {
							type: 'content_block_start',
							index: blockIndex,
							content_block: {
								type: 'tool_use',
								id: block.id,
								name: block.name,
								input: block.input ?? {},
							},
						}),
					)
					safeEnqueue(
						formatSse('content_block_delta', {
							type: 'content_block_delta',
							index: blockIndex,
							delta: {
								type: 'input_json_delta',
								partial_json: JSON.stringify(block.input ?? {}),
							},
						}),
					)
					safeEnqueue(
						formatSse('content_block_stop', {
							type: 'content_block_stop',
							index: blockIndex,
						}),
					)
				}

				toolBlocksFlushed = true
			}

			const finish = (finalReason: OllamaStopReason) => {
				if (hasTools && toolCalls.length === 0 && pendingToolSyntaxText) {
						const fallbackTextToolCall = parseBracketToolUseText(pendingToolSyntaxText, allowedTools)
					if (fallbackTextToolCall) {
						toolCalls.push(fallbackTextToolCall)
						messageText = ''
						pendingToolSyntaxText = ''
					} else {
						flushPendingToolSyntaxText()
					}
				}

				flushTextStop()
				if (hasTools) {
					flushToolBlocks()
				}
				const finalToolCalls = getResolvedToolCalls()
				const effectiveReason = finalToolCalls.length > 0 ? 'tool_use' : finalReason
				const firstToolCall = finalToolCalls[0]
				stopStream(effectiveReason, usage.output_tokens)
				if (!isErrorState) {
					void logger?.onComplete?.({
						stopReason: effectiveReason,
						usage,
						finalText: messageText,
						decision:
							firstToolCall
								? {
										kind: 'tool_use',
										name: firstToolCall.function?.name,
										input: parseModelFromArguments(firstToolCall.function?.arguments),
										preamble: null,
									}
								: undefined,
						metadata: {
							model: resolvedModel,
						},
					})
				}
			}

			if (request.tools?.length) {
				validateToolRequestTools(request)
			}

			let textStreamStarted = false
			let toolBlocksFlushed = false
			let resolvedModel = requestModel
			let messageText = ''
			let usage = mapOllamaUsageToAnthropic({})
			const toolCalls: OllamaRawToolCall[] = []
			const accumulatedOpenAIToolCalls = new Map<string, OpenAIToolCallAccumulatorEntry>()
			const allowedTools = buildAllowedToolMap(request.tools)
			let pendingToolSyntaxText = ''
			let toolSyntaxProbeActive = hasTools
			let didComplete = false
			let isErrorState = false

			const getResolvedToolCalls = () =>
				dedupeToolCallsById([
					...toolCalls,
					...filterToolCallsBySchema(
						finalizeAccumulatedOpenAIToolCalls(accumulatedOpenAIToolCalls),
						allowedTools,
					),
				])

			const flushPendingToolSyntaxText = () => {
				if (!pendingToolSyntaxText) {
					return
				}

				sendTextDelta(pendingToolSyntaxText)
				pendingToolSyntaxText = ''
				toolSyntaxProbeActive = false
			}

			const handleContentDelta = (delta: string) => {
				if (!delta) {
					return
				}

				messageText += delta
				if (!hasTools || toolCalls.length > 0 || !toolSyntaxProbeActive) {
					sendTextDelta(delta)
					return
				}

				const nextCandidate = pendingToolSyntaxText + delta
				const parsedToolCall = parseBracketToolUseText(nextCandidate, allowedTools)
				if (parsedToolCall || isPossibleBracketToolUsePrefix(nextCandidate)) {
					pendingToolSyntaxText = nextCandidate
					return
				}

				sendTextDelta(nextCandidate)
				pendingToolSyntaxText = ''
				toolSyntaxProbeActive = false
			}

			const processParsedChunk = (parsed: OllamaLikeResponse) => {
				logOllamaRawSnapshot(config, 'stream', parsed, {
					routerRequestId: context?.routerRequestId,
				})

				resolvedModel = parsed.model || resolvedModel
				usage = normalizeUsage(usage, parsed)

				const content = extractContent(parsed) ?? ''
				const thinking = extractThinking(parsed)
				const choice = isOpenAIChatResponse(parsed) ? getOpenAIChoice(parsed) : null
				const rawOpenAIDeltaToolCalls = choice?.delta?.tool_calls
				const incomingToolCalls = rawOpenAIDeltaToolCalls?.length ? [] : extractToolCalls(parsed)

				if (content) {
					handleContentDelta(content)
				}

				if (
					config.ollamaShowThinking &&
					typeof thinking === 'string' &&
					thinking
				) {
					flushPendingToolSyntaxText()
					messageText += thinking
					sendTextDelta(thinking)
				}

				if (incomingToolCalls.length > 0) {
					flushPendingToolSyntaxText()
					toolCalls.push(...filterToolCallsBySchema(incomingToolCalls, allowedTools))
				}

				if (rawOpenAIDeltaToolCalls?.length) {
					flushPendingToolSyntaxText()
					accumulateOpenAIToolCalls(accumulatedOpenAIToolCalls, rawOpenAIDeltaToolCalls)
				}

				const doneReason = extractDoneReason(parsed)
				const done = !isOpenAIChatResponse(parsed) && parsed.done
				if (done || doneReason) {
					const finalReason = mapOllamaDoneReason(
						doneReason as OllamaDoneReason,
						getResolvedToolCalls().length > 0,
					)
					finish(finalReason)
				}
			}

			void logger?.onSessionReady?.({ model: requestModel })

			try {
				const response = await fetch(new URL('/api/chat', config.ollamaBaseUrl), {
					method: 'POST',
					headers: buildHeaders(config),
					body: JSON.stringify(payload),
					signal: requestSignal.signal,
				})

				if (!response.ok) {
					throw new Error(`/api/chat 호출 실패: ${response.status} ${response.statusText}`)
				}

				const reader = response.body?.getReader()
				if (!reader) {
					throw new Error('Ollama 응답 body를 읽을 수 없습니다.')
				}

				sendMessageStart(requestModel)
				const decoder = new TextDecoder()
				let pendingChunk = ''
				while (!didComplete) {
					const { value, done } = await reader.read()
					if (done) {
						break
					}

					const chunkText = pendingChunk + decoder.decode(value, { stream: true })
					const lines = chunkText.split('\n')
					pendingChunk = lines.pop() ?? ''

					for (const line of lines) {
						const parsed = parseStreamChunk(config, line, {
							routerRequestId: context?.routerRequestId,
						})
						if (!parsed) {
							continue
						}
						processParsedChunk(parsed)
					}

					const tailChunk = parseStreamChunk(config, pendingChunk, {
						routerRequestId: context?.routerRequestId,
					})
					if (!didComplete && tailChunk) {
						processParsedChunk(tailChunk)
						pendingChunk = ''
					}
				}

				const finalChunk = parseStreamChunk(config, pendingChunk, {
					routerRequestId: context?.routerRequestId,
				})
				if (!didComplete && finalChunk) {
					processParsedChunk(finalChunk)
				}

				if (!didComplete) {
					finish(mapOllamaDoneReason(undefined, getResolvedToolCalls().length > 0))
				}
			} catch (error) {
					isErrorState = true
					didComplete = true
				if (isAbortError(error) || requestSignal.signal.aborted) {
					void logger?.onCancel?.({})
					void logger?.onError?.({
						error,
						metadata: {
							model: resolvedModel,
						},
					})
				} else {
					void logger?.onError?.({
						error,
						metadata: {
							model: resolvedModel,
						},
					})
				}

				safeEnqueue(
					formatSse('error', {
						type: 'error',
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				)
				safeClose()
			} finally {
				requestSignal.cleanup()
			}
		},
		cancel() {
			void logger?.onCancel?.({})
			requestSignal.cleanup()
		},
	})
}
