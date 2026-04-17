import type { RouterConfig } from '../../server/config.js'
import type { CanonicalProviderId } from '../canonical/types.js'
import {
	createBackendProviderById,
} from '../backend-provider.js'
import type { BridgeProviderAdapter } from './contract.js'
import { createLegacyBackendAdapter } from './legacy-adapter.js'
import { createOpenAiCompatibleAdapter } from './openai-compatible.js'

export interface ProviderRegistryEntry {
	id: CanonicalProviderId
	enabled: boolean
	adapter: BridgeProviderAdapter
	defaults: {
		model?: string
	}
	aliases: Record<string, string>
	capabilities: {
		streaming: boolean
		tools: boolean
		thinking: boolean
		inputImages: boolean
		modelListing: boolean
	}
}

export function createProviderRegistry(config: RouterConfig): Map<ProviderRegistryEntry['id'], ProviderRegistryEntry> {
	const codexProvider = createBackendProviderById('codex-app-server')
	const ollamaProvider = createBackendProviderById('ollama-chat')
	const openAiCompatibleProvider = createOpenAiCompatibleAdapter()

	return new Map([
		[
			'codex-app-server',
			{
				id: 'codex-app-server',
				enabled: true,
				adapter: createLegacyBackendAdapter(codexProvider),
				defaults: {
					model: config.providerRouting.providerDefaults['codex-app-server'],
				},
				aliases: config.modelAliases,
				capabilities: {
					streaming: true,
					tools: true,
					thinking: true,
					inputImages: true,
					modelListing: true,
				},
			},
		],
		[
			'openai-compatible',
			{
				id: 'openai-compatible',
				enabled: Boolean(config.openAiCompatibleBaseUrl),
				adapter: openAiCompatibleProvider,
				defaults: {
					model: config.providerRouting.providerDefaults['openai-compatible'],
				},
				aliases: {},
				capabilities: {
					streaming: false,
					tools: true,
					thinking: false,
					inputImages: false,
					modelListing: true,
				},
			},
		],
		[
			'ollama-chat',
			{
				id: 'ollama-chat',
				enabled: true,
				adapter: createLegacyBackendAdapter(ollamaProvider),
				defaults: {
					model: config.providerRouting.providerDefaults['ollama-chat'] ?? config.ollamaModel,
				},
				aliases: config.ollamaModelAliases,
				capabilities: {
					streaming: true,
					tools: true,
					thinking: true,
					inputImages: true,
					modelListing: true,
				},
			},
		],
	])
}

export function getProviderRegistryEntry(
	registry: Map<CanonicalProviderId, ProviderRegistryEntry>,
	providerId: CanonicalProviderId,
): ProviderRegistryEntry {
	const entry = registry.get(providerId)
	if (!entry || !entry.enabled) {
		throw new Error(`provider '${providerId}' is not available`)
	}

	return entry
}
