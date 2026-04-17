import type { RouterConfig } from '../../server/config.js'
import type { JsonValue } from '../../shared/index.js'
import type {
	CanonicalBridgeRequest,
	CanonicalBridgeResponse,
	CanonicalContentBlock,
	CanonicalModelListingEntry,
	CanonicalStopReason,
	CanonicalStreamEvent,
} from '../canonical/types.js'
import type {
	BridgeProviderAdapter,
	ProviderExecutionContext,
	ProviderStreamObserver,
} from './contract.js'

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

type OpenAiModelListResponse = {
	data?: Array<{
		id?: string
	}>
}

function requireBaseUrl(config: RouterConfig) {
	if (!config.openAiCompatibleBaseUrl) {
		throw new Error('OPENAI_COMPATIBLE_BASE_URL is required for openai-compatible routing')
	}

	return config.openAiCompatibleBaseUrl.replace(/\/+$/, '')
}

function buildHeaders(config: RouterConfig) {
	return {
		'content-type': 'application/json',
		...(config.openAiCompatibleApiKey
			? {
					authorization: `Bearer ${config.openAiCompatibleApiKey}`,
				}
			: {}),
	}
}

function asSignalPair(requestSignal: AbortSignal | null | undefined, timeoutMs: number) {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort(new Error(`openai-compatible 요청이 ${timeoutMs}ms 내에 완료되지 않았습니다.`))
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
			throw new Error('openai-compatible adapter does not support canonical image blocks yet')
	}
}

function serializeContent(blocks: CanonicalContentBlock[]): string | null {
	const parts = blocks.map(blockToText).filter(Boolean)
	return parts.length > 0 ? parts.join('\n') : null
}

function serializeToolResultContent(
	content: string | CanonicalContentBlock[],
): string {
	return typeof content === 'string' ? content : content.map(blockToText).join('\n')
}

function buildOpenAiMessages(request: CanonicalBridgeRequest): OpenAiChatMessage[] {
	const messages: OpenAiChatMessage[] = []

	if (request.system.length > 0) {
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
			`openai-compatible returned invalid JSON arguments${suffix}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

function toCanonicalResponse(
	request: CanonicalBridgeRequest,
	response: OpenAiChatCompletionResponse,
): CanonicalBridgeResponse {
	const choice = response.choices?.[0]
	const message = choice?.message
	const content: CanonicalBridgeResponse['content'] = []

	if (typeof message?.content === 'string' && message.content) {
		content.push({
			type: 'text',
			text: message.content,
		})
	}

	for (const toolCall of message?.tool_calls ?? []) {
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
		stopReason: mapStopReason(choice?.finish_reason),
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
			id: 'openai-compatible',
			model: response.model ?? request.model,
		},
	}
}

export function createOpenAiCompatibleAdapter(): BridgeProviderAdapter {
	return {
		providerId: 'openai-compatible',
		legacyBackend: 'openai-compatible',
		healthBackend: 'openai_compatible_api',
		async listModels(
			config: RouterConfig,
			abortSignal?: AbortSignal | null,
		): Promise<CanonicalModelListingEntry[]> {
			const baseUrl = requireBaseUrl(config)
			const requestSignal = asSignalPair(abortSignal, config.openAiCompatibleRequestTimeoutMs)
			try {
				const response = await fetch(`${baseUrl}/v1/models`, {
					method: 'GET',
					headers: buildHeaders(config),
					signal: requestSignal.signal,
				})
				if (!response.ok) {
					throw new Error(`openai-compatible model list failed with status ${response.status}`)
				}
				const payload = (await response.json()) as OpenAiModelListResponse
				return (payload.data ?? [])
					.map((entry) => entry.id?.trim())
					.filter((entry): entry is string => Boolean(entry))
					.map((id) => ({
						exposedModel: `openai-compatible/${id}`,
						displayName: `openai-compatible/${id}`,
						providerId: 'openai-compatible',
						providerModel: id,
					}))
			} finally {
				requestSignal.cleanup()
			}
		},
		async execute(
			config: RouterConfig,
			request: CanonicalBridgeRequest,
			context?: ProviderExecutionContext,
		): Promise<CanonicalBridgeResponse> {
			const baseUrl = requireBaseUrl(config)
			const requestSignal = asSignalPair(
				context?.abortSignal,
				config.openAiCompatibleRequestTimeoutMs,
			)
			try {
				const response = await fetch(`${baseUrl}/v1/chat/completions`, {
					method: 'POST',
					headers: buildHeaders(config),
					signal: requestSignal.signal,
					body: JSON.stringify({
						model: request.model,
						messages: buildOpenAiMessages(request),
						max_tokens: request.sampling.maxTokens,
						temperature: request.sampling.temperature,
						top_p: request.sampling.topP,
						stream: false,
						tools:
							request.tools?.map((tool) => ({
								type: 'function',
								function: {
									name: tool.name,
									description: tool.description,
									parameters: tool.input_schema,
								},
							})) ?? undefined,
						tool_choice: mapToolChoice(request),
					}),
				})
				if (!response.ok) {
					throw new Error(`openai-compatible request failed with status ${response.status}`)
				}
				const payload = (await response.json()) as OpenAiChatCompletionResponse
				return toCanonicalResponse(request, payload)
			} finally {
				requestSignal.cleanup()
			}
		},
		stream(
			_config: RouterConfig,
			_request: CanonicalBridgeRequest,
			_context?: ProviderExecutionContext,
			_observer?: ProviderStreamObserver,
		): ReadableStream<CanonicalStreamEvent> {
			throw new Error('openai-compatible streaming is not implemented yet')
		},
	}
}
