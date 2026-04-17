import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../../src/server/index.js'
import {
	parseModelAddress,
	resolveProviderTarget,
} from '../../../src/bridge/provider/selector.js'

describe('provider selector', () => {
	const withEnv = (values: Record<string, string | undefined>) => {
		const original = Object.fromEntries(
			Object.keys(values).map((key) => [key, process.env[key]]),
		) as Record<string, string | undefined>
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = value
			}
		}

		return () => {
			for (const [key, value] of Object.entries(original)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}
	}

	test('parses provider-qualified model ids', () => {
		expect(parseModelAddress('ollama/qwen3.5:27b')).toEqual({
			type: 'qualified',
			providerId: 'ollama-chat',
			modelId: 'qwen3.5:27b',
		})
		expect(parseModelAddress('codex-direct/gpt-5.4')).toEqual({
			type: 'qualified',
			providerId: 'codex-direct',
			modelId: 'gpt-5.4',
		})
	})

	test('keeps legacy Anthropic ids on the active codex path by default', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_MODEL_SONNET: 'gpt-5.4',
			PROVIDER_ROUTING_JSON: undefined,
		})
		try {
			const config = loadConfig()

			expect(
				resolveProviderTarget(config, {
					requestedModel: 'claude-sonnet-4-5-20250929',
					requestSource: 'anthropic-route',
				}),
			).toEqual({
				providerId: 'codex-app-server',
				providerModel: 'gpt-5.4',
				exposedModel: 'claude-sonnet-4-5-20250929',
				resolutionReason: 'legacy-alias',
			})
		} finally {
			restore()
		}
	})

	test('uses skill policy when a skill flow is active', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			PROVIDER_ROUTING_JSON: JSON.stringify({
				skillPolicies: {
					review: 'ollama/qwen3.5:27b',
				},
			}),
		})
		try {
			const config = loadConfig()

			expect(
				resolveProviderTarget(config, {
					requestedModel: 'claude-sonnet-4-5-20250929',
					requestSource: 'tool-loop',
					skillName: 'review',
				}),
			).toEqual({
				providerId: 'ollama-chat',
				providerModel: 'qwen3.5:27b',
				exposedModel: 'claude-sonnet-4-5-20250929',
				resolutionReason: 'skill-policy',
			})
		} finally {
			restore()
		}
	})

	test('uses fallback for unresolved policy models before provider default', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			PROVIDER_ROUTING_JSON: JSON.stringify({
				fallback: 'openai-compatible/gpt-5.4-mini',
			}),
		})
		try {
			const config = loadConfig()

			expect(
				resolveProviderTarget(config, {
					requestedModel: 'skill:missing-policy',
					requestSource: 'direct-skill',
				}),
			).toEqual({
				providerId: 'openai-compatible',
				providerModel: 'gpt-5.4-mini',
				exposedModel: 'skill:missing-policy',
				resolutionReason: 'fallback',
			})
		} finally {
			restore()
		}
	})

	test('keeps codex-direct qualified routing distinct from legacy codex path', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
		})
		try {
			const config = loadConfig()

			expect(
				resolveProviderTarget(config, {
					requestedModel: 'codex-direct/gpt-5.4-mini',
					requestSource: 'anthropic-route',
				}),
			).toEqual({
				providerId: 'codex-direct',
				providerModel: 'gpt-5.4-mini',
				exposedModel: 'codex-direct/gpt-5.4-mini',
				resolutionReason: 'qualified',
			})
		} finally {
			restore()
		}
	})
})
