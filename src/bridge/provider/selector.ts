import type { RouterConfig } from '../../server/config.js'
import type { CanonicalProviderId, CanonicalRequestSource } from '../canonical/types.js'
import { resolveModelAlias } from '../anthropic/compat.js'

export type ModelAddress =
	| {
			type: 'qualified'
			providerId: CanonicalProviderId
			modelId: string
	  }
	| {
			type: 'exposed'
			exposedModel: string
	  }
	| {
			type: 'policy'
			alias: string
	  }

export interface SkillAwareResolveInput {
	requestedModel: string
	requestSource: CanonicalRequestSource
	skillName?: string | null
	activeProviderId?: CanonicalProviderId | null
}

export interface SkillAwareResolveResult {
	providerId: CanonicalProviderId
	providerModel: string
	exposedModel: string
	resolutionReason:
		| 'qualified'
		| 'skill-policy'
		| 'routing-alias'
		| 'legacy-alias'
		| 'family-policy'
		| 'provider-default'
		| 'fallback'
}

const PROVIDER_ID_ALIASES: Record<string, CanonicalProviderId> = {
	codex: 'codex-app-server',
	'codex-app-server': 'codex-app-server',
	ollama: 'ollama-chat',
	'ollama-chat': 'ollama-chat',
	'openai-compatible': 'openai-compatible',
}

function normalizeProviderId(raw: string): CanonicalProviderId | null {
	return PROVIDER_ID_ALIASES[raw.trim().toLowerCase()] ?? null
}

function parseProviderTarget(target: string): { providerId: CanonicalProviderId; modelId: string } | null {
	const trimmed = target.trim()
	const slashIndex = trimmed.indexOf('/')
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return null
	}

	const providerId = normalizeProviderId(trimmed.slice(0, slashIndex))
	if (!providerId) {
		return null
	}

	return {
		providerId,
		modelId: trimmed.slice(slashIndex + 1).trim(),
	}
}

export function parseModelAddress(requestedModel: string): ModelAddress {
	const trimmed = requestedModel.trim()
	const qualified = parseProviderTarget(trimmed)
	if (qualified) {
		return {
			type: 'qualified',
			providerId: qualified.providerId,
			modelId: qualified.modelId,
		}
	}

	if (trimmed.startsWith('skill:') && trimmed.length > 'skill:'.length) {
		return {
			type: 'policy',
			alias: trimmed,
		}
	}

	return {
		type: 'exposed',
		exposedModel: trimmed,
	}
}

function resolveLegacyModelForProvider(
	config: RouterConfig,
	providerId: CanonicalProviderId,
	requestedModel: string,
): string {
	switch (providerId) {
		case 'codex-app-server':
			return resolveModelAlias(config, requestedModel)
		case 'ollama-chat':
			return config.ollamaModelAliases[requestedModel] ?? config.ollamaModel
		case 'openai-compatible':
			return requestedModel
	}
}

function resolvePolicyTarget(
	target: string,
	exposedModel: string,
	reason: SkillAwareResolveResult['resolutionReason'],
): SkillAwareResolveResult | null {
	const parsed = parseProviderTarget(target)
	if (!parsed) {
		return null
	}

	return {
		providerId: parsed.providerId,
		providerModel: parsed.modelId,
		exposedModel,
		resolutionReason: reason,
	}
}

export function resolveProviderTarget(
	config: RouterConfig,
	input: SkillAwareResolveInput,
): SkillAwareResolveResult {
	const requestedModel = input.requestedModel.trim()
	const activeProviderId = input.activeProviderId ?? config.activeProviderId
	const address = parseModelAddress(requestedModel)

	if (address.type === 'qualified') {
		return {
			providerId: address.providerId,
			providerModel: address.modelId,
			exposedModel: requestedModel,
			resolutionReason: 'qualified',
		}
	}

	const policySkillName =
		input.skillName?.trim() ||
		(address.type === 'policy' && address.alias.startsWith('skill:')
			? address.alias.slice('skill:'.length).trim()
			: '')

	if (policySkillName) {
		const skillTarget = config.providerRouting.skillPolicies[policySkillName]
		if (skillTarget) {
			const resolved = resolvePolicyTarget(
				skillTarget,
				requestedModel,
				'skill-policy',
			)
			if (resolved) {
				return resolved
			}
		}
	}

	const routingAliasTarget = config.providerRouting.aliases[requestedModel]
	if (routingAliasTarget) {
		const resolved = resolvePolicyTarget(
			routingAliasTarget,
			requestedModel,
			'routing-alias',
		)
		if (resolved) {
			return resolved
		}
	}

	const familyTarget = config.providerRouting.familyPolicies[requestedModel]
	if (familyTarget) {
		const resolved = resolvePolicyTarget(
			familyTarget,
			requestedModel,
			'family-policy',
		)
		if (resolved) {
			return resolved
		}
	}

	const fallback = resolvePolicyTarget(config.providerRouting.fallback, requestedModel, 'fallback')
	if (fallback && address.type === 'policy') {
		return fallback
	}

	const providerDefault = config.providerRouting.providerDefaults[activeProviderId]
	if (providerDefault && address.type === 'policy') {
		return {
			providerId: activeProviderId,
			providerModel: providerDefault,
			exposedModel: requestedModel,
			resolutionReason: 'provider-default',
		}
	}

	if (address.type === 'exposed') {
		return {
			providerId: activeProviderId,
			providerModel: resolveLegacyModelForProvider(config, activeProviderId, requestedModel),
			exposedModel: requestedModel,
			resolutionReason: 'legacy-alias',
		}
	}

	return {
		providerId: activeProviderId,
		providerModel:
			config.providerRouting.providerDefaults[activeProviderId] ??
			resolveLegacyModelForProvider(config, activeProviderId, requestedModel),
		exposedModel: requestedModel,
		resolutionReason: 'provider-default',
	}
}
