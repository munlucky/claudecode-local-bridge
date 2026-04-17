import type {
	AnthropicToolChoice,
	AnthropicToolDefinition,
	JsonValue,
} from '../../shared/index.js'

export type CanonicalProviderId = 'codex-app-server' | 'ollama-chat' | 'openai-compatible'

export type CanonicalRequestSource =
	| 'anthropic-route'
	| 'direct-skill'
	| 'tool-loop'
	| 'system-default'

export type CanonicalStopReason =
	| 'end_turn'
	| 'tool_use'
	| 'max_tokens'
	| 'stop_sequence'
	| null

export interface CanonicalUsage {
	inputTokens: number
	outputTokens: number
	cachedInputTokens: number
	reasoningOutputTokens: number
	totalTokens: number
}

export type CanonicalContentBlock =
	| {
			type: 'text'
			text: string
	  }
	| {
			type: 'image'
			source: {
				type: 'base64'
				mediaType: string
				data: string
			}
	  }
	| {
			type: 'thinking'
			text: string
	  }
	| {
			type: 'tool_use'
			id: string
			name: string
			input: JsonValue
	  }
	| {
			type: 'tool_result'
			toolUseId: string
			content: string | CanonicalContentBlock[]
	  }

export interface CanonicalMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: CanonicalContentBlock[]
}

export interface CanonicalBridgeRequest {
	model: string
	stream: boolean
	source: CanonicalRequestSource
	system: CanonicalContentBlock[]
	messages: CanonicalMessage[]
	tools: AnthropicToolDefinition[]
	toolChoice?: AnthropicToolChoice
	sampling: {
		maxTokens: number
		temperature?: number
		topP?: number
		topK?: number
	}
	reasoning?: {
		enabled: boolean
		budgetTokens?: number
		raw?: unknown
	}
	metadata: {
		sessionId?: string | null
		routerRequestId?: string | null
		userAgent?: string | null
	}
}

export interface CanonicalBridgeResponse {
	id: string
	model: string
	content: CanonicalContentBlock[]
	stopReason: CanonicalStopReason
	stopSequence: string | null
	usage: CanonicalUsage
	provider: {
		id: CanonicalProviderId
		model: string
		rawModel?: string | null
	}
	promptMetrics?: Record<string, unknown>
}

export type CanonicalStreamEvent =
	| {
			type: 'message_start'
			messageId: string
			model: string
			usage: CanonicalUsage
	  }
	| {
			type: 'content_block_start'
			index: number
			contentBlock:
				| {
						type: 'text'
						text: string
				  }
				| {
						type: 'thinking'
						text: string
				  }
				| {
						type: 'tool_use'
						id: string
						name: string
						input: JsonValue
				  }
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
						text: string
				  }
				| {
						type: 'input_json_delta'
						partialJson: string
				  }
	  }
	| {
			type: 'content_block_stop'
			index: number
	  }
	| {
			type: 'message_delta'
			stopReason: CanonicalStopReason
			stopSequence?: string | null
			usage?: Partial<CanonicalUsage>
	  }
	| {
			type: 'message_stop'
	  }
	| {
			type: 'error'
			error: {
				message: string
			}
	  }

export interface CanonicalProviderHealth {
	providerId: CanonicalProviderId
	live: boolean
	readiness: 'ready' | 'degraded'
	auth: {
		mode?: string
		dependencyOk?: boolean
		message?: string | null
	}
	model?: string | null
	metadata: Record<string, unknown>
}

export interface CanonicalModelListingEntry {
	exposedModel: string
	displayName: string
	providerId: CanonicalProviderId
	providerModel?: string | null
}
