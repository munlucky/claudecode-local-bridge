import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../src/server/index.js'

describe('loadConfig', () => {
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) {
			delete process.env[key]
			return
		}
		process.env[key] = value
	}

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
				restore(key, value)
			}
		}
	}

	test('defaults auth mode to local auth json for this bridge', () => {
		delete process.env.CODEX_AUTH_MODE
		delete process.env.API_TIMEOUT_MS
		delete process.env.CODEX_TURN_TIMEOUT_MS

		const config = loadConfig()

		expect(config.codexAuthMode).toBe('local_auth_json')
		expect(config.codexTurnTimeoutMs).toBe(180000)
	})

	test('caps idle timeout to Bun maximum', () => {
		process.env.API_TIMEOUT_MS = '3000000'
		delete process.env.CODEX_TURN_TIMEOUT_MS
		delete process.env.ROUTER_IDLE_TIMEOUT_SEC

		const config = loadConfig()

		expect(config.codexTurnTimeoutMs).toBe(3000000)
		expect(config.serverIdleTimeoutSec).toBe(255)
	})

	test('enables request capture by default', () => {
		delete process.env.ROUTER_RUNTIME_LOGS
		delete process.env.ROUTER_RUNTIME_LOGS_ROOT
		delete process.env.ROUTER_CAPTURE_REQUESTS
		delete process.env.ROUTER_CAPTURE_REQUESTS_PATH
		delete process.env.ROUTER_CAPTURE_RESPONSES
		delete process.env.ROUTER_CAPTURE_RESPONSES_PATH

		const config = loadConfig()

		expect(config.runtimeLogsEnabled).toBe(true)
		expect(config.runtimeLogsRootPath.endsWith('.bridge-logs')).toBe(true)
		expect(config.captureRequests).toBe(true)
		expect(config.captureRequestsPath.endsWith('anthropic-requests.jsonl')).toBe(true)
		expect(config.captureResponses).toBe(true)
		expect(config.captureResponsesPath.endsWith('anthropic-responses.jsonl')).toBe(true)
	})

	test('allows explicit disabled auth mode override', () => {
		process.env.CODEX_AUTH_MODE = 'disabled'

		const config = loadConfig()

		expect(config.codexAuthMode).toBe('disabled')
	})

	test('sets capture policy defaults', () => {
		delete process.env.ROUTER_CAPTURE_MAX_FILE_BYTES
		delete process.env.ROUTER_CAPTURE_RETENTION_DAYS

		const config = loadConfig()

		expect(config.captureMaxFileBytes).toBe(5 * 1024 * 1024)
		expect(config.captureRetentionDays).toBe(7)
	})

	test('parses bridge backend override', () => {
		const restore = withEnv({ BRIDGE_BACKEND: 'ollama' })
		const ollamaConfig = loadConfig()
		expect(ollamaConfig.bridgeBackend).toBe('ollama')

		restore()
		const restoreCodex = withEnv({ BRIDGE_BACKEND: 'codex' })
		const codexConfig = loadConfig()
		expect(codexConfig.bridgeBackend).toBe('codex')
		restoreCodex()
	})

	test('parses Ollama env and defaults', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_REQUEST_TIMEOUT_MS: '45000',
			OLLAMA_SHOW_THINKING: '1',
			OLLAMA_MODEL_ALIASES_JSON: '{"claude-sonnet-4-5-20250929":"qwen3.5:27b"}',
		})

		const config = loadConfig()

		expect(config.bridgeBackend).toBe('ollama')
		expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:11434')
		expect(config.ollamaModel).toBe('qwen3.5:27b')
		expect(config.ollamaRequestTimeoutMs).toBe(45000)
		expect(config.ollamaShowThinking).toBe(true)
		expect(config.ollamaModelAliases['claude-sonnet-4-5-20250929']).toBe('qwen3.5:27b')
		restore()
	})

	test('parses provider routing policy override', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: undefined,
			CODEX_DIRECT_ROLLOUT: undefined,
			PROVIDER_ROUTING_JSON: JSON.stringify({
				aliases: {
					fast: 'ollama/qwen3.5:27b',
				},
				skillPolicies: {
					review: 'ollama/qwen3.5:27b',
				},
				familyPolicies: {
					reasoning: 'ollama/qwen3.5:27b',
				},
				providerDefaults: {
					'codex-app-server': 'gpt-5.4',
					'codex-direct': 'gpt-5.4-mini',
					'ollama-chat': 'qwen3.5:27b',
				},
				fallback: 'ollama/qwen3.5:27b',
			}),
		})

		const config = loadConfig()

		expect(config.activeProviderId).toBe('codex-app-server')
		expect(config.providerRouting.aliases.fast).toBe('ollama/qwen3.5:27b')
		expect(config.providerRouting.skillPolicies.review).toBe('ollama/qwen3.5:27b')
		expect(config.providerRouting.familyPolicies.reasoning).toBe('ollama/qwen3.5:27b')
		expect(config.providerRouting.providerDefaults['codex-app-server']).toBe('gpt-5.4')
		expect(config.providerRouting.providerDefaults['codex-direct']).toBe('gpt-5.4-mini')
		expect(config.providerRouting.fallback).toBe('ollama/qwen3.5:27b')
		restore()
	})

	test('enables codex-direct rollout and auth config when requested', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'prefer-direct',
			CODEX_DIRECT_AUTH_MODE: 'oauth',
			CODEX_DIRECT_AUTH_STATE_FILE: '~/.codex/direct-auth.json',
			CODEX_DIRECT_BASE_URL: 'https://api.openai.example',
			CODEX_DIRECT_REQUEST_TIMEOUT_MS: '45000',
		})

		const config = loadConfig()

		expect(config.activeProviderId).toBe('codex-direct')
		expect(config.codexDirectEnabled).toBe(true)
		expect(config.codexDirectRollout).toBe('prefer-direct')
		expect(config.codexDirectAuthMode).toBe('oauth')
		expect(config.codexDirectAuthStateFile.endsWith('.codex/direct-auth.json')).toBe(true)
		expect(config.codexDirectBaseUrl).toBe('https://api.openai.example')
		expect(config.codexDirectRequestTimeoutMs).toBe(45000)
		restore()
	})

	test('keeps codex-app-server active until codex-direct rollout is explicitly prefer-direct', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: undefined,
			PROVIDER_ROUTING_JSON: undefined,
		})

		const config = loadConfig()

		expect(config.codexDirectEnabled).toBe(true)
		expect(config.codexDirectRollout).toBe('disabled')
		expect(config.activeProviderId).toBe('codex-app-server')
		expect(config.providerRouting.fallback).toBe('codex-app-server/gpt-5.4')
		restore()
	})

	test('parses openai-compatible env and leaves legacy backend default unchanged', () => {
		const restore = withEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: undefined,
			CODEX_DIRECT_ROLLOUT: undefined,
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
			OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS: '45000',
		})

		const config = loadConfig()

		expect(config.bridgeBackend).toBe('codex')
		expect(config.activeProviderId).toBe('codex-app-server')
		expect(config.openAiCompatibleBaseUrl).toBe('https://example.test')
		expect(config.openAiCompatibleApiKey).toBe('test-key')
		expect(config.openAiCompatibleRequestTimeoutMs).toBe(45000)
		restore()
	})
})
