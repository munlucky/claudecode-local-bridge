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
})
