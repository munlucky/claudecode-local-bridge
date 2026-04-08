export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
	[key: string]: JsonValue
}

export interface AnthropicTextBlock {
	type: 'text'
	text: string
}

export interface AnthropicThinkingBlock {
	type: 'thinking'
	thinking: string
	signature?: string
}

export interface AnthropicToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: JsonValue
}

export interface AnthropicToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	content: string | AnthropicInputContentBlock[]
}

export interface AnthropicImageBlock {
	type: 'image'
	source: {
		type: 'base64'
		media_type: string
		data: string
	}
}

export type AnthropicInputContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock
	| AnthropicImageBlock

export interface AnthropicMessage {
	role: 'user' | 'assistant' | 'system'
	content: string | AnthropicInputContentBlock[]
}

export type AnthropicThinkingConfig =
	| {
			type: 'enabled'
			budget_tokens: number
	  }
	| {
			type: 'disabled'
	  }
	| ({
			type?: string
			budget_tokens?: number
	  } & JsonObject)

export interface AnthropicToolDefinition {
	name: string
	description?: string
	input_schema: JsonObject
}

export type AnthropicToolChoice =
	| 'auto'
	| 'any'
	| 'none'
	| {
			type: 'tool'
			name: string
	  }
	| {
			type: 'none'
	  }

export interface AnthropicMessagesRequest {
	model: string
	max_tokens: number
	messages: AnthropicMessage[]
	system?: string | AnthropicInputContentBlock[]
	stream?: boolean
	tools?: AnthropicToolDefinition[]
	tool_choice?: AnthropicToolChoice
	thinking?: AnthropicThinkingConfig
	temperature?: number
	top_p?: number
	top_k?: number
}

export interface AnthropicUsage {
	input_tokens: number
	output_tokens: number
	cache_read_input_tokens?: number
	reasoning_output_tokens?: number
	total_tokens?: number
}

export type AnthropicResponseContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock

export interface AnthropicMessagesResponse {
	id: string
	type: 'message'
	role: 'assistant'
	model: string
	content: AnthropicResponseContentBlock[]
	stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
	stop_sequence: string | null
	usage: AnthropicUsage
}

export interface AnthropicToolChoiceRaw {
	type: 'tool'
	name: string
}

export interface CodexBridgeAssistantDecision {
	kind: 'assistant'
	text: string
}

export interface CodexBridgeToolUseDecision {
	kind: 'tool_use'
	name: string
	input: JsonObject
	preamble?: string
}

export type CodexBridgeDecision =
	| CodexBridgeAssistantDecision
	| CodexBridgeToolUseDecision

export type CodexThreadMode = 'new' | 'reused' | 'recreated'

export type CodexThreadReuseReason =
	| 'no_session'
	| 'cache_miss'
	| 'fingerprint_mismatch'
	| 'retry_after_error'
	| 'cache_hit'
	| 'cache_expired'

export interface CodexTurnMetadata {
	threadId: string
	workspaceRoot: string
	sessionId: string | null
	threadMode: CodexThreadMode
	threadReuseReason: CodexThreadReuseReason
	threadCacheKey: string | null
	threadFingerprint: string
}

export interface CodexTokenUsage {
	inputTokens: number
	cachedInputTokens: number
	outputTokens: number
	reasoningOutputTokens: number
	totalTokens: number
}

export interface CodexPromptMetrics {
	userMessageCount: number
	totalMessageCount: number
	newMessageCount: number
	systemCharCount: number
	toolCount: number
	toolNames: string[]
	toolSchemaCharCount: number
	developerInstructionCharCount: number
	promptCharCount: number
	userVisibleCharCount: number
	estimatedPromptTokens: number
	estimatedUserVisibleTokens: number
	promptMode: 'full' | 'delta'
	replayFromMessageIndex: number
}

export interface CodexTurnResult {
	id: string
	model: string
	text: string
	usage: CodexTokenUsage
	promptMetrics?: CodexPromptMetrics
	decision?: CodexBridgeDecision | null
	metadata?: CodexTurnMetadata & { model: string }
}

export interface OllamaTurnMetadata {
	model: string
	provider: 'ollama'
	requestedModel: string
	stream: boolean
}

export interface OllamaToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: JsonObject
	}
}

export interface OllamaTurnResult {
	id: string
	model: string
	text: string
	usage: CodexTokenUsage
	stopReason: 'stop' | 'tool_calls'
	toolCalls?: OllamaToolCall[]
	thinking?: string | null
	metadata?: OllamaTurnMetadata
	promptMetrics?: CodexPromptMetrics
}

export type BridgeBackend = 'codex' | 'ollama'

export interface RouterHealthResponse {
	status: 'ok'
	backend: 'codex_app_server' | 'ollama_api'
	auth_mode?: 'api_key' | 'account' | 'local_auth_json' | 'disabled'
	has_auth_mode_dependency?: boolean
	live?: boolean
	readiness?: 'ready' | 'degraded'
	queue_depth?: number
	active_session_count?: number
	pending_session_creates?: number
	recent_retryable_failures?: number
	recent_non_retryable_failures?: number
	recent_retries?: number

	codex_command?: string
	codex_runtime_cwd?: string
	codex_auth_file?: string
	has_local_auth_file?: boolean
	codex_model?: string | null

	ollama_base_url?: string
	ollama_model?: string
	has_ollama_api_key?: boolean

	auth_message?: string | null
}
