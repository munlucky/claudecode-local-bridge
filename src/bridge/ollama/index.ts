import type { RouterConfig } from '../../server/config.js'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
	AnthropicToolUseBlock,
	JsonObject,
} from '../../shared/index.js'
import { AnthropicRequestValidationError } from '../anthropic/compat.js'
import type { StreamLifecycleLoggerLike } from '../backend-provider.js'

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
	if (!doneReason) {
		return hasToolCalls ? 'tool_use' : 'end_turn'
	}

	switch (doneReason) {
		case 'stop':
		case 'eos':
			return 'end_turn'
		case 'tool_calls':
		case 'tool_use':
			return 'tool_use'
		case 'length':
		case 'max_tokens':
			return 'max_tokens'
		case 'stop_sequence':
			return 'stop_sequence'
		default:
			return hasToolCalls ? 'tool_use' : 'end_turn'
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

			if (typed.type === 'tool_use' && typeof typed.name === 'string') {
				const args = typeof typed.input === 'string' ? typed.input : JSON.stringify(typed.input ?? {})
				return `[tool_use name=${typed.name} args=${args}]`
			}

			if (typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
				return `[tool_result id=${typed.tool_use_id}]`
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

function mapOllamaUsageToAnthropic(response: OllamaRawResponse) {
	const promptTokens = typeof response.prompt_eval_count === 'number' ? response.prompt_eval_count : 0
	const completionTokens = typeof response.eval_count === 'number' ? response.eval_count : 0

	return {
		input_tokens: promptTokens,
		output_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
		cache_read_input_tokens: 0,
		reasoning_output_tokens: 0,
	}
}

function normalizeUsage(
	previous: ReturnType<typeof mapOllamaUsageToAnthropic>,
	next: OllamaRawResponse,
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
	response: OllamaRawResponse,
	requestedModel: string,
): AnthropicMessagesResponse {
	const contentText = response.message?.content ?? ''
	const toolCalls = mapToolCallsToAnthropicContent(response.message?.tool_calls)
	const usage = mapOllamaUsageToAnthropic(response)
	const content: AnthropicResponseContentBlock[] = []

	if (typeof contentText === 'string' && contentText.length > 0) {
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

	const stopReason = mapOllamaDoneReason(response.done_reason as OllamaDoneReason, toolCalls.length > 0)

	return {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		model: response.model ?? requestedModel,
		content,
		stop_reason: toolCalls.length > 0 ? 'tool_use' : stopReason,
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

		const body = (await response.json()) as OllamaRawResponse
		if (typeof body !== 'object' || body === null) {
			throw new Error('Ollama 응답 형식이 유효하지 않습니다.')
		}

		return {
			response: mapOllamaTurnToAnthropic(body, request.model),
		}
	} finally {
		requestSignal.cleanup()
	}
}

function formatSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function parseStreamChunk(line: string): OllamaRawResponse | null {
	const trimmed = line.trim()
	if (!trimmed) {
		return null
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as OllamaRawResponse)
			: null
	} catch {
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

				messageText += delta
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

				const tools = buildToolBlocksFromRawToolCalls(dedupeToolCallsById(toolCalls))
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
				flushTextStop()
				if (hasTools) {
					flushToolBlocks()
				}
				stopStream(finalReason, usage.output_tokens)
				if (!isErrorState) {
					void logger?.onComplete?.({
						stopReason: finalReason,
						usage,
						finalText: messageText,
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
			let didComplete = false
			let isErrorState = false

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
						const parsed = parseStreamChunk(line)
						if (!parsed) {
							continue
						}

						resolvedModel = parsed.model || resolvedModel
						usage = normalizeUsage(usage, parsed)

						const content = parsed.message?.content ?? ''
						if (content) {
							sendTextDelta(content)
						}
						if (
							config.ollamaShowThinking &&
							typeof parsed.message?.thinking === 'string' &&
							parsed.message.thinking
						) {
							sendTextDelta(parsed.message.thinking)
						}

						const incomingToolCalls = normalizeToolCalls(parsed.message?.tool_calls)
						if (incomingToolCalls.length > 0) {
							toolCalls.push(...incomingToolCalls)
						}

						if (parsed.done) {
							const doneReason = mapOllamaDoneReason(parsed.done_reason as OllamaDoneReason, toolCalls.length > 0)
							finish(doneReason)
						}
					}
				}

				const tailChunk = parseStreamChunk(pendingChunk)
				if (!didComplete && tailChunk) {
					resolvedModel = tailChunk.model || resolvedModel
					usage = normalizeUsage(usage, tailChunk)
					const content = tailChunk.message?.content ?? ''
					if (content) {
						sendTextDelta(content)
					}
					if (
						config.ollamaShowThinking &&
						typeof tailChunk.message?.thinking === 'string' &&
						tailChunk.message.thinking
					) {
						sendTextDelta(tailChunk.message.thinking)
					}
					const tailToolCalls = normalizeToolCalls(tailChunk.message?.tool_calls)
					if (tailToolCalls.length > 0) {
						toolCalls.push(...tailToolCalls)
					}
					if (tailChunk.done) {
						const doneReason = mapOllamaDoneReason(tailChunk.done_reason as OllamaDoneReason, toolCalls.length > 0)
						finish(doneReason)
					}
				}

				if (!didComplete) {
					finish(mapOllamaDoneReason(undefined, toolCalls.length > 0))
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
