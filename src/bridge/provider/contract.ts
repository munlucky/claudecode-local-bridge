import type { RouterConfig } from '../../server/config.js'
import type {
	CanonicalBridgeRequest,
	CanonicalBridgeResponse,
	CanonicalModelListingEntry,
	CanonicalProviderHealth,
	CanonicalProviderId,
	CanonicalStopReason,
	CanonicalStreamEvent,
	CanonicalUsage,
} from '../canonical/types.js'

export interface ProviderExecutionContext {
	sessionId?: string | null
	routerRequestId?: string | null
	userAgent?: string | null
	abortSignal?: AbortSignal | null
}

export interface ProviderStreamObserver {
	onSessionReady?: (metadata: {
		model: string
		threadId?: string
		messageId?: string | null
		upstreamResponseId?: string | null
		provisionalMessageId?: boolean
	}) => void | Promise<void>
	onComplete?: (payload: {
		stopReason: CanonicalStopReason
		usage: CanonicalUsage
		promptMetrics?: Record<string, unknown>
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
	}) => void | Promise<void>
	onError?: (payload: {
		error: unknown
		metadata?: {
			model?: string
			upstreamResponseId?: string | null
		}
	}) => void | Promise<void>
	onCancel?: () => void | Promise<void>
	onEvent?: (event: CanonicalStreamEvent) => void | Promise<void>
}

export interface BridgeProviderAdapter {
	providerId: CanonicalProviderId
	legacyBackend: 'codex' | 'ollama' | 'openai-compatible'
	healthBackend:
		| 'codex_app_server'
		| 'codex_direct_api'
		| 'ollama_api'
		| 'openai_compatible_api'
	listModels(
		config: RouterConfig,
		abortSignal?: AbortSignal | null,
	): Promise<CanonicalModelListingEntry[]>
	execute(
		config: RouterConfig,
		request: CanonicalBridgeRequest,
		context?: ProviderExecutionContext,
	): Promise<CanonicalBridgeResponse>
	stream(
		config: RouterConfig,
		request: CanonicalBridgeRequest,
		context?: ProviderExecutionContext,
		observer?: ProviderStreamObserver,
	): ReadableStream<CanonicalStreamEvent>
	getHealth?(config: RouterConfig): Promise<CanonicalProviderHealth> | CanonicalProviderHealth
}
