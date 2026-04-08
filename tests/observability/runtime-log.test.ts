import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRuntimeLog, ensureRuntimeLogSession, getRuntimeLogInfo } from '../../src/observability/runtime-log.js'
import { loadConfig } from '../../src/server/index.js'

describe('runtime-log', () => {
	let rootDir = ''
	let restoreRoot: string | undefined
	let restoreEnabled: string | undefined

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), 'bridge-runtime-log-'))
		restoreRoot = process.env.ROUTER_RUNTIME_LOGS_ROOT
		restoreEnabled = process.env.ROUTER_RUNTIME_LOGS
		process.env.ROUTER_RUNTIME_LOGS_ROOT = rootDir
		process.env.ROUTER_RUNTIME_LOGS = '1'
	})

	afterEach(() => {
		if (restoreRoot === undefined) {
			delete process.env.ROUTER_RUNTIME_LOGS_ROOT
		} else {
			process.env.ROUTER_RUNTIME_LOGS_ROOT = restoreRoot
		}
		if (restoreEnabled === undefined) {
			delete process.env.ROUTER_RUNTIME_LOGS
		} else {
			process.env.ROUTER_RUNTIME_LOGS = restoreEnabled
		}
	})

	test('creates run and latest directories and mirrors request scoped records', async () => {
		const config = loadConfig()
		const info = getRuntimeLogInfo(config)
		expect(info).not.toBeNull()

		await ensureRuntimeLogSession(config)
		await appendRuntimeLog(config, {
			channel: '03-anthropic-responses',
			routerRequestId: 'routerreq_test_123',
			payload: {
				type: 'stream',
				stream_phase: 'failed',
				status: 502,
				error_message: 'timeout',
			},
		})

		const latestResponses = await readFile(join(info!.latestDir, '03-anthropic-responses.jsonl'), 'utf8')
		const requestTrace = await readFile(join(info!.runDir, 'requests', 'routerreq_test_123.jsonl'), 'utf8')
		const latestPointer = await readFile(join(info!.rootDir, 'latest-run.txt'), 'utf8')

		expect(latestResponses).toContain('"stream_phase":"failed"')
		expect(requestTrace).toContain('"router_request_id":"routerreq_test_123"')
		expect(requestTrace).toContain('"_channel":"03-anthropic-responses"')
		expect(latestPointer.trim()).toBe(info!.runDir)
	})

	test('writes backend-specific session metadata only for the active backend', async () => {
		const restoreBackend = process.env.BRIDGE_BACKEND
		const restoreOllamaBaseUrl = process.env.OLLAMA_BASE_URL
		const restoreOllamaModel = process.env.OLLAMA_MODEL

		process.env.BRIDGE_BACKEND = 'ollama'
		process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
		process.env.OLLAMA_MODEL = 'qwen3.5:27b'

		const ollamaConfig = loadConfig()
		const ollamaInfo = getRuntimeLogInfo(ollamaConfig)
		await ensureRuntimeLogSession(ollamaConfig)
		const ollamaSession = await readFile(join(ollamaInfo!.runDir, '00-session.json'), 'utf8')

		expect(ollamaSession).toContain('"backend": "ollama"')
		expect(ollamaSession).toContain('"ollama_base_url": "http://127.0.0.1:11434"')
		expect(ollamaSession).not.toContain('"codex_auth_file"')
		expect(ollamaSession).not.toContain('"codex_runtime_cwd"')

		if (restoreBackend === undefined) {
			delete process.env.BRIDGE_BACKEND
		} else {
			process.env.BRIDGE_BACKEND = restoreBackend
		}
		if (restoreOllamaBaseUrl === undefined) {
			delete process.env.OLLAMA_BASE_URL
		} else {
			process.env.OLLAMA_BASE_URL = restoreOllamaBaseUrl
		}
		if (restoreOllamaModel === undefined) {
			delete process.env.OLLAMA_MODEL
		} else {
			process.env.OLLAMA_MODEL = restoreOllamaModel
		}
	})

	test('gracefully disables runtime logging when initialization fails', async () => {
		const blockedPath = join(rootDir, 'blocked-root')
		await writeFile(blockedPath, 'not a directory', 'utf8')
		process.env.ROUTER_RUNTIME_LOGS_ROOT = blockedPath

		const config = loadConfig()

		await expect(ensureRuntimeLogSession(config)).resolves.toBeNull()
		await expect(
			appendRuntimeLog(config, {
				channel: '01-router-events',
				payload: { message: 'should not throw' },
			}),
		).resolves.toBeUndefined()
	})
})
