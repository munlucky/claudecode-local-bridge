import type { RouterConfig } from '../server/config.js'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
	CodexPromptMetrics,
} from '../shared/index.js'
import { listOllamaModels, runOllamaTurn, streamOllamaTurn } from './ollama/index.js'
import { createCodexAnthropicStream, executeCodexTurn, getCodexBridgeRuntimeSnapshot } from './codex/index.js'
import { mapCodexResultToAnthropic } from './anthropic/index.js'
import type { StreamLifecycleLogger } from './codex/index.js'

export interface BackendModelEntry {
	id: string
	display_name: string
}

type OllamaUsage = {
	input_tokens: number
	output_tokens: number
	total_tokens: number
	cache_read_input_tokens: number
	reasoning_output_tokens: number
}

type StreamCompletePayload = {
	stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
	usage: OllamaUsage
	promptMetrics?: {
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
	finalText?: string
	decision?: {
		kind: 'assistant' | 'tool_use'
		name?: string
		input?: unknown
		preamble?: string | null
	}
	metadata: {
		model: string
	}
}

export type StreamLifecycleLoggerLike = StreamLifecycleLogger & {
	onComplete?: (payload: StreamCompletePayload) => void | Promise<void>
	onError?: (payload: { error: unknown; metadata?: { model?: string } }) => void | Promise<void>
	onSessionReady?: (metadata: { model: string; threadId?: string }) => void | Promise<void>
}

export type BackendModel = BackendModelEntry
export type BackendResponseContentBlock = AnthropicResponseContentBlock
export type BackendProviderContract = BackendProvider

export interface BackendNonStreamResult {
	response: AnthropicMessagesResponse
	promptMetrics?: CodexPromptMetrics
}

export interface BackendProvider {
	backend: 'codex_app_server' | 'ollama_api'
	listModels(
		config: RouterConfig,
		abortSignal?: AbortSignal | null,
	): Promise<BackendModelEntry[]>
	executeNonStream(
		config: RouterConfig,
		request: AnthropicMessagesRequest,
		context?: {
			sessionId?: string | null
			routerRequestId?: string | null
			userAgent?: string | null
			abortSignal?: AbortSignal | null
		},
	): Promise<BackendNonStreamResult>
	createStream(
		config: RouterConfig,
		request: AnthropicMessagesRequest,
		context?: {
			sessionId?: string | null
			routerRequestId?: string | null
			userAgent?: string | null
			abortSignal?: AbortSignal | null
		},
		logger?: StreamLifecycleLoggerLike,
	): ReadableStream<Uint8Array>
}

function createCodexProvider(): BackendProvider {
	return {
		backend: 'codex_app_server',
		listModels(config): Promise<BackendModelEntry[]> {
			const aliases = Object.keys(config.modelAliases)
			return Promise.resolve(
				aliases.map((id) => ({
					id,
					display_name: id,
				})),
			)
		},
		async executeNonStream(config, request, context) {
			const result = await executeCodexTurn(config, request, {
				sessionId: context?.sessionId,
				routerRequestId: context?.routerRequestId,
				userAgent: context?.userAgent,
				abortSignal: context?.abortSignal,
			})
			return {
				response: mapCodexResultToAnthropic(result, request.model),
				promptMetrics: result.promptMetrics,
			}
		},
		createStream(config, request, context, logger) {
			return createCodexAnthropicStream(
				config,
				request,
				{
					sessionId: context?.sessionId,
					routerRequestId: context?.routerRequestId,
					userAgent: context?.userAgent,
					abortSignal: context?.abortSignal,
				},
				logger,
			)
		},
	}
}

function createOllamaProvider(): BackendProvider {
	return {
		backend: 'ollama_api',
		listModels(config, abortSignal): Promise<BackendModelEntry[]> {
			return listOllamaModels(config, abortSignal).then((models) =>
				models.map((model) => ({
					id: model.model,
					display_name: model.model,
				})),
			)
		},
		executeNonStream(config, request, context) {
			return runOllamaTurn(config, request, {
				sessionId: context?.sessionId,
				routerRequestId: context?.routerRequestId,
				userAgent: context?.userAgent,
				abortSignal: context?.abortSignal,
			})
		},
		createStream(config, request, context, logger) {
			return streamOllamaTurn(
				config,
				request,
				{
					sessionId: context?.sessionId,
					routerRequestId: context?.routerRequestId,
					userAgent: context?.userAgent,
					abortSignal: context?.abortSignal,
				},
				logger,
			)
		},
	}
}

export function createBackendProvider(config: RouterConfig): BackendProvider {
	return config.bridgeBackend === 'ollama' ? createOllamaProvider() : createCodexProvider()
}

export function getCodexBackendHealthSnapshot() {
	return getCodexBridgeRuntimeSnapshot()
}
