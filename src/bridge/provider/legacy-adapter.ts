import type { RouterConfig } from '../../server/config.js'
import { parseAnthropicSseToCanonicalStream } from '../anthropic/surface.js'
import {
	anthropicResponseToCanonical,
	canonicalRequestToAnthropic,
} from '../canonical/anthropic.js'
import type { CanonicalModelListingEntry } from '../canonical/types.js'
import type {
	BackendProvider,
	StreamLifecycleLoggerLike,
} from '../backend-provider.js'
import type {
	BridgeProviderAdapter,
	ProviderExecutionContext,
	ProviderStreamObserver,
} from './contract.js'

function normalizeUsage(
	usage:
		| {
				input_tokens?: number
				output_tokens?: number
				cache_read_input_tokens?: number
				reasoning_output_tokens?: number
				total_tokens?: number
		  }
		| {
				inputTokens?: number
				outputTokens?: number
				cachedInputTokens?: number
				reasoningOutputTokens?: number
				totalTokens?: number
		  },
) {
	const snakeCaseUsage =
		'input_tokens' in usage || 'output_tokens' in usage ? usage : undefined
	const camelCaseUsage =
		'inputTokens' in usage || 'outputTokens' in usage ? usage : undefined

	return {
		inputTokens: snakeCaseUsage?.input_tokens ?? camelCaseUsage?.inputTokens ?? 0,
		outputTokens: snakeCaseUsage?.output_tokens ?? camelCaseUsage?.outputTokens ?? 0,
		cachedInputTokens:
			snakeCaseUsage?.cache_read_input_tokens ?? camelCaseUsage?.cachedInputTokens ?? 0,
		reasoningOutputTokens:
			snakeCaseUsage?.reasoning_output_tokens ?? camelCaseUsage?.reasoningOutputTokens ?? 0,
		totalTokens: snakeCaseUsage?.total_tokens ?? camelCaseUsage?.totalTokens ?? 0,
	}
}

function mapObserverToLegacyLogger(
	observer?: ProviderStreamObserver,
): StreamLifecycleLoggerLike | undefined {
	if (!observer) {
		return undefined
	}

	return {
		onSessionReady: observer.onSessionReady,
		onError: observer.onError,
		onCancel: observer.onCancel,
		onComplete: (payload) =>
			observer.onComplete?.({
				stopReason: payload.stopReason,
				usage: normalizeUsage(payload.usage),
				promptMetrics: payload.promptMetrics as Record<string, unknown> | undefined,
				finalText: payload.finalText,
				decision: payload.decision ?? undefined,
				metadata: payload.metadata,
			}),
	}
}

function mapModelEntries(
	provider: BackendProvider,
	models: Awaited<ReturnType<BackendProvider['listModels']>>,
): CanonicalModelListingEntry[] {
	return models.map((model) => ({
		exposedModel: model.id,
		displayName: model.display_name,
		providerId: provider.providerId,
		providerModel: model.id,
	}))
}

function toLegacyBackend(provider: BackendProvider): BridgeProviderAdapter['legacyBackend'] {
	return provider.providerId === 'ollama-chat' ? 'ollama' : 'codex'
}

function toHealthBackend(provider: BackendProvider): BridgeProviderAdapter['healthBackend'] {
	return provider.backend
}

export function createLegacyBackendAdapter(provider: BackendProvider): BridgeProviderAdapter {
	return {
		providerId: provider.providerId,
		legacyBackend: toLegacyBackend(provider),
		healthBackend: toHealthBackend(provider),
		listModels(config: RouterConfig, abortSignal?: AbortSignal | null) {
			return provider
				.listModels(config, abortSignal)
				.then((models) => mapModelEntries(provider, models))
		},
		async execute(config, request, context) {
			const result = await provider.executeNonStream(
				config,
				canonicalRequestToAnthropic(request),
				context,
			)
			return anthropicResponseToCanonical(result.response, {
				id: provider.providerId,
				model: result.response.model,
			})
		},
		stream(
			config,
			request,
			context?: ProviderExecutionContext,
			observer?: ProviderStreamObserver,
		) {
			const stream = provider.createStream(
				config,
				canonicalRequestToAnthropic(request),
				context,
				mapObserverToLegacyLogger(observer),
			)
			return parseAnthropicSseToCanonicalStream(stream, observer?.onEvent)
		},
	}
}
