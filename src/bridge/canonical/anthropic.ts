import type {
	AnthropicInputContentBlock,
	AnthropicThinkingConfig,
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
} from '../../shared/index.js'
import type {
	CanonicalBridgeRequest,
	CanonicalBridgeResponse,
	CanonicalContentBlock,
	CanonicalRequestSource,
	CanonicalUsage,
} from './types.js'

function anthropicBlockToCanonical(block: AnthropicInputContentBlock): CanonicalContentBlock {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text }
		case 'image':
			return {
				type: 'image',
				source: {
					type: block.source.type,
					mediaType: block.source.media_type,
					data: block.source.data,
				},
			}
		case 'thinking':
			return { type: 'thinking', text: block.thinking }
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input,
			}
		case 'tool_result':
			return {
				type: 'tool_result',
				toolUseId: block.tool_use_id,
				content:
					typeof block.content === 'string'
						? block.content
						: block.content.map(anthropicBlockToCanonical),
			}
	}
}

function canonicalBlockToAnthropicInput(block: CanonicalContentBlock): AnthropicInputContentBlock {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text }
		case 'image':
			return {
				type: 'image',
				source: {
					type: block.source.type,
					media_type: block.source.mediaType,
					data: block.source.data,
				},
			}
		case 'thinking':
			return { type: 'thinking', thinking: block.text }
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input,
			}
		case 'tool_result':
			return {
				type: 'tool_result',
				tool_use_id: block.toolUseId,
				content:
					typeof block.content === 'string'
						? block.content
						: block.content.map(canonicalBlockToAnthropicInput),
			}
	}
}

function canonicalBlockToAnthropicResponse(
	block: CanonicalContentBlock,
): AnthropicResponseContentBlock {
	switch (block.type) {
		case 'text':
			return { type: 'text', text: block.text }
		case 'thinking':
			return { type: 'thinking', thinking: block.text }
		case 'tool_use':
			return {
				type: 'tool_use',
				id: block.id,
				name: block.name,
				input: block.input,
			}
		case 'image':
			throw new Error('Canonical image blocks cannot be emitted in Anthropic message responses.')
		case 'tool_result':
			throw new Error('Canonical tool_result blocks cannot be emitted in Anthropic message responses.')
	}
}

function anthropicUsageToCanonical(
	usage: AnthropicMessagesResponse['usage'],
): CanonicalUsage {
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cachedInputTokens: usage.cache_read_input_tokens ?? 0,
		reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
		totalTokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
	}
}

function extractReasoningBudget(
	thinking: AnthropicThinkingConfig | undefined,
): number | undefined {
	if (!thinking) {
		return undefined
	}

	if ('budget_tokens' in thinking && typeof thinking.budget_tokens === 'number') {
		return thinking.budget_tokens
	}

	return undefined
}

export function anthropicContentToCanonical(
	content: string | AnthropicInputContentBlock[] | undefined,
): CanonicalContentBlock[] {
	if (typeof content === 'string') {
		return content ? [{ type: 'text', text: content }] : []
	}

	return (content ?? []).map(anthropicBlockToCanonical)
}

export function canonicalContentToAnthropicInput(
	content: CanonicalContentBlock[],
): AnthropicInputContentBlock[] {
	return content.map(canonicalBlockToAnthropicInput)
}

export function anthropicRequestToCanonical(
	request: AnthropicMessagesRequest,
	options?: {
		source?: CanonicalRequestSource
		metadata?: Partial<CanonicalBridgeRequest['metadata']>
	},
): CanonicalBridgeRequest {
	return {
		model: request.model,
		stream: request.stream === true,
		source: options?.source ?? 'anthropic-route',
		system: anthropicContentToCanonical(request.system),
		messages: request.messages.map((message) => ({
			role: message.role,
			content: anthropicContentToCanonical(message.content),
		})),
		tools: request.tools ?? [],
		toolChoice: request.tool_choice,
		sampling: {
			maxTokens: request.max_tokens,
			temperature: request.temperature,
			topP: request.top_p,
			topK: request.top_k,
		},
		reasoning: request.thinking
			? {
					enabled: request.thinking.type !== 'disabled',
					budgetTokens: extractReasoningBudget(request.thinking),
					raw: request.thinking,
				}
			: undefined,
		metadata: {
			sessionId: options?.metadata?.sessionId ?? null,
			routerRequestId: options?.metadata?.routerRequestId ?? null,
			userAgent: options?.metadata?.userAgent ?? null,
		},
	}
}

export function canonicalRequestToAnthropic(
	request: CanonicalBridgeRequest,
): AnthropicMessagesRequest {
	return {
		model: request.model,
		max_tokens: request.sampling.maxTokens,
		messages: request.messages.map((message) => ({
			role:
				message.role === 'tool'
					? 'user'
					: (message.role as Extract<typeof message.role, 'system' | 'user' | 'assistant'>),
			content: canonicalContentToAnthropicInput(message.content),
		})),
		system: canonicalContentToAnthropicInput(request.system),
		stream: request.stream,
		tools: request.tools,
		tool_choice: request.toolChoice,
		thinking: request.reasoning?.raw as AnthropicMessagesRequest['thinking'],
		temperature: request.sampling.temperature,
		top_p: request.sampling.topP,
		top_k: request.sampling.topK,
	}
}

export function canonicalResponseToAnthropic(
	response: CanonicalBridgeResponse,
): AnthropicMessagesResponse {
	return {
		id: response.id,
		type: 'message',
		role: 'assistant',
		model: response.model,
		content: response.content.map(canonicalBlockToAnthropicResponse),
		stop_reason: response.stopReason,
		stop_sequence: response.stopSequence,
		usage: {
			input_tokens: response.usage.inputTokens,
			output_tokens: response.usage.outputTokens,
			cache_read_input_tokens: response.usage.cachedInputTokens,
			reasoning_output_tokens: response.usage.reasoningOutputTokens,
			total_tokens: response.usage.totalTokens,
		},
	}
}

export function anthropicResponseToCanonical(
	response: AnthropicMessagesResponse,
	provider: CanonicalBridgeResponse['provider'],
): CanonicalBridgeResponse {
	return {
		id: response.id,
		model: response.model,
		content: response.content.map(anthropicBlockToCanonical),
		stopReason: response.stop_reason,
		stopSequence: response.stop_sequence,
		usage: anthropicUsageToCanonical(response.usage),
		provider,
	}
}
