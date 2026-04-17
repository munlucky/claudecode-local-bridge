import type { RouterConfig } from '../server/config.js'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
	CodexPromptMetrics,
} from '../shared/index.js'
import type {
	CanonicalProviderId,
	CanonicalStopReason,
} from './canonical/types.js'
import { listOllamaModels, runOllamaTurn, streamOllamaTurn } from './ollama/index.js'
import { createCodexAnthropicStream, executeCodexTurn, getCodexBridgeRuntimeSnapshot } from './codex/index.js'
import { mapCodexResultToAnthropic } from './anthropic/index.js'
import type { StreamLifecycleLogger } from './codex/index.js'

export interface BackendModelEntry {
	id: string
	display_name: string
}

type LegacyBackendId = Extract<CanonicalProviderId, 'codex-app-server' | 'ollama-chat'>

type StreamCompleteUsage = {
	input_tokens: number
	output_tokens: number
	total_tokens: number
	cache_read_input_tokens: number
	reasoning_output_tokens: number
}

type StreamCompletePayload = {
	stopReason: CanonicalStopReason
	usage: StreamCompleteUsage
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
		messageId?: string | null
		upstreamResponseId?: string | null
		provisionalMessageId?: boolean
	}
}

export type StreamLifecycleLoggerLike = StreamLifecycleLogger & {
	onComplete?: (payload: StreamCompletePayload) => void | Promise<void>
	onError?: (payload: {
		error: unknown
		metadata?: {
			model?: string
			upstreamResponseId?: string | null
		}
	}) => void | Promise<void>
	onSessionReady?: (metadata: {
		model: string
		threadId?: string
		messageId?: string | null
		upstreamResponseId?: string | null
		provisionalMessageId?: boolean
	}) => void | Promise<void>
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
	providerId: LegacyBackendId
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

export function createCodexProvider(): BackendProvider {
	return {
		backend: 'codex_app_server',
		providerId: 'codex-app-server',
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

export function createOllamaProvider(): BackendProvider {
	return {
		backend: 'ollama_api',
		providerId: 'ollama-chat',
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

export function createBackendProviderById(providerId: LegacyBackendId): BackendProvider {
	return providerId === 'ollama-chat' ? createOllamaProvider() : createCodexProvider()
}

export function createBackendProvider(config: RouterConfig): BackendProvider {
	return createBackendProviderById(
		config.activeProviderId === 'codex-direct' ? 'codex-app-server' : config.activeProviderId,
	)
}

export function getCodexBackendHealthSnapshot() {
	return getCodexBridgeRuntimeSnapshot()
}
