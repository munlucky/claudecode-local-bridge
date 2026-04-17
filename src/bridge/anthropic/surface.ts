import type { AnthropicResponseContentBlock } from '../../shared/index.js'
import type {
	CanonicalContentBlock,
	CanonicalStopReason,
	CanonicalStreamEvent,
	CanonicalUsage,
} from '../canonical/types.js'

type AnthropicEventPayload =
	| {
			type: 'message_start'
			message: {
				id: string
				model: string
				usage?: {
					input_tokens?: number
					output_tokens?: number
					cache_read_input_tokens?: number
					reasoning_output_tokens?: number
					total_tokens?: number
				}
			}
	  }
	| {
			type: 'content_block_start'
			index: number
			content_block: AnthropicResponseContentBlock
	  }
	| {
			type: 'content_block_delta'
			index: number
			delta:
				| {
						type: 'text_delta'
						text: string
				  }
				| {
						type: 'thinking_delta'
						thinking: string
				  }
				| {
						type: 'input_json_delta'
						partial_json: string
				  }
	  }
	| {
			type: 'content_block_stop'
			index: number
	  }
	| {
			type: 'message_delta'
			delta: {
				stop_reason: CanonicalStopReason
				stop_sequence: string | null
			}
			usage?: {
				input_tokens?: number
				output_tokens?: number
				cache_read_input_tokens?: number
				reasoning_output_tokens?: number
				total_tokens?: number
			}
	  }
	| {
			type: 'message_stop'
	  }
	| {
			type: 'error'
			error?: {
				message?: string
			}
	  }

function toCanonicalUsage(
	usage:
		| {
				input_tokens?: number
				output_tokens?: number
				cache_read_input_tokens?: number
				reasoning_output_tokens?: number
				total_tokens?: number
		  }
		| undefined,
): CanonicalUsage {
	return {
		inputTokens: usage?.input_tokens ?? 0,
		outputTokens: usage?.output_tokens ?? 0,
		cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
		reasoningOutputTokens: usage?.reasoning_output_tokens ?? 0,
		totalTokens:
			usage?.total_tokens ??
			(usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
	}
}

function toCanonicalPartialUsage(
	usage:
		| {
				input_tokens?: number
				output_tokens?: number
				cache_read_input_tokens?: number
				reasoning_output_tokens?: number
				total_tokens?: number
		  }
		| undefined,
): Partial<CanonicalUsage> | undefined {
	if (!usage) {
		return undefined
	}

	return {
		...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
		...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
		...(usage.cache_read_input_tokens === undefined
			? {}
			: { cachedInputTokens: usage.cache_read_input_tokens }),
		...(usage.reasoning_output_tokens === undefined
			? {}
			: { reasoningOutputTokens: usage.reasoning_output_tokens }),
		...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
	}
}

function toCanonicalContentBlock(
	block: AnthropicResponseContentBlock,
): Extract<CanonicalContentBlock, { type: 'text' | 'thinking' | 'tool_use' }> {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text }
		case 'thinking':
			return { type: 'thinking', text: block.thinking }
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input,
			}
	}
}

function toAnthropicContentBlock(
	block: Extract<CanonicalStreamEvent, { type: 'content_block_start' }>['contentBlock'],
): AnthropicResponseContentBlock {
	switch (block.type) {
		case 'text':
			return {
				type: 'text',
				text: block.text,
			}
		case 'thinking':
			return {
				type: 'thinking',
				thinking: block.text,
			}
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input,
			}
	}
}

function toAnthropicUsage(usage: CanonicalUsage) {
	return {
		input_tokens: usage.inputTokens,
		output_tokens: usage.outputTokens,
		cache_read_input_tokens: usage.cachedInputTokens,
		reasoning_output_tokens: usage.reasoningOutputTokens,
		total_tokens: usage.totalTokens,
	}
}

function toAnthropicPartialUsage(usage?: Partial<CanonicalUsage>) {
	if (!usage) {
		return undefined
	}

	return {
		...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
		...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
		...(usage.cachedInputTokens === undefined
			? {}
			: { cache_read_input_tokens: usage.cachedInputTokens }),
		...(usage.reasoningOutputTokens === undefined
			? {}
			: { reasoning_output_tokens: usage.reasoningOutputTokens }),
		...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
	}
}

export function formatAnthropicSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
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

function parseAnthropicEvent(block: string): CanonicalStreamEvent | null {
	const parsed = parseSseBlock(block)
	if (!parsed || parsed.data === '[DONE]') {
		return null
	}

	const payload = JSON.parse(parsed.data) as AnthropicEventPayload
	switch (parsed.event) {
		case 'message_start':
			if (payload.type !== 'message_start') {
				return null
			}
			return {
				type: 'message_start',
				messageId: payload.message.id,
				model: payload.message.model,
				usage: toCanonicalUsage(payload.message.usage),
			}
		case 'content_block_start':
			if (payload.type !== 'content_block_start') {
				return null
			}
			return {
				type: 'content_block_start',
				index: payload.index,
				contentBlock: toCanonicalContentBlock(payload.content_block),
			}
		case 'content_block_delta':
			if (payload.type !== 'content_block_delta') {
				return null
			}
			if (payload.delta.type === 'text_delta') {
				return {
					type: 'content_block_delta',
					index: payload.index,
					delta: {
						type: 'text_delta',
						text: payload.delta.text,
					},
				}
			}
			if (payload.delta.type === 'thinking_delta') {
				return {
					type: 'content_block_delta',
					index: payload.index,
					delta: {
						type: 'thinking_delta',
						text: payload.delta.thinking,
					},
				}
			}
			return {
				type: 'content_block_delta',
				index: payload.index,
				delta: {
					type: 'input_json_delta',
					partialJson: payload.delta.partial_json,
				},
			}
		case 'content_block_stop':
			if (payload.type !== 'content_block_stop') {
				return null
			}
			return {
				type: 'content_block_stop',
				index: payload.index,
			}
		case 'message_delta':
			if (payload.type !== 'message_delta') {
				return null
			}
			return {
				type: 'message_delta',
				stopReason: payload.delta.stop_reason,
				stopSequence: payload.delta.stop_sequence,
				usage: toCanonicalPartialUsage(payload.usage),
			}
		case 'message_stop':
			return {
				type: 'message_stop',
			}
		case 'error':
			return {
				type: 'error',
				error: {
					message:
						payload.type === 'error'
							? payload.error?.message ?? 'unknown provider error'
							: 'unknown provider error',
				},
			}
		default:
			return null
	}
}

export function parseAnthropicSseToCanonicalStream(
	stream: ReadableStream<Uint8Array>,
	onEvent?: (event: CanonicalStreamEvent) => void | Promise<void>,
): ReadableStream<CanonicalStreamEvent> {
	const decoder = new TextDecoder()
	let buffer = ''

	return new ReadableStream<CanonicalStreamEvent>({
		async start(controller) {
			const reader = stream.getReader()
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
						const event = parseAnthropicEvent(part)
						if (!event) {
							continue
						}
						await onEvent?.(event)
						controller.enqueue(event)
					}
				}

				buffer += decoder.decode()
				if (buffer.trim()) {
					const event = parseAnthropicEvent(buffer)
					if (event) {
						await onEvent?.(event)
						controller.enqueue(event)
					}
				}

				controller.close()
			} catch (error) {
				controller.error(error)
			} finally {
				reader.releaseLock()
			}
		},
	})
}

function renderCanonicalEvent(
	event: CanonicalStreamEvent,
	options?: {
		exposedModel?: string
	},
): Uint8Array {
	switch (event.type) {
		case 'message_start':
			return formatAnthropicSse('message_start', {
				type: 'message_start',
				message: {
					id: event.messageId,
					type: 'message',
					role: 'assistant',
					model: options?.exposedModel ?? event.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: toAnthropicUsage(event.usage),
				},
			})
		case 'content_block_start':
			return formatAnthropicSse('content_block_start', {
				type: 'content_block_start',
				index: event.index,
				content_block: toAnthropicContentBlock(event.contentBlock),
			})
		case 'content_block_delta':
			return formatAnthropicSse('content_block_delta', {
				type: 'content_block_delta',
				index: event.index,
				delta:
					event.delta.type === 'text_delta'
						? {
								type: 'text_delta',
								text: event.delta.text,
							}
						: event.delta.type === 'thinking_delta'
							? {
									type: 'thinking_delta',
									thinking: event.delta.text,
								}
							: {
									type: 'input_json_delta',
									partial_json: event.delta.partialJson,
								},
			})
		case 'content_block_stop':
			return formatAnthropicSse('content_block_stop', {
				type: 'content_block_stop',
				index: event.index,
			})
		case 'message_delta':
			return formatAnthropicSse('message_delta', {
				type: 'message_delta',
				delta: {
					stop_reason: event.stopReason,
					stop_sequence: event.stopSequence ?? null,
				},
				usage: toAnthropicPartialUsage(event.usage),
			})
		case 'message_stop':
			return formatAnthropicSse('message_stop', {
				type: 'message_stop',
			})
		case 'error':
			return formatAnthropicSse('error', {
				type: 'error',
				error: {
					message: event.error.message,
				},
			})
	}
}

export function renderCanonicalStreamAsAnthropicSse(
	stream: ReadableStream<CanonicalStreamEvent>,
	options?: {
		exposedModel?: string
	},
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = stream.getReader()
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) {
						break
					}

					controller.enqueue(renderCanonicalEvent(value, options))
				}
				controller.close()
			} catch (error) {
				controller.error(error)
			} finally {
				reader.releaseLock()
			}
		},
	})
}
