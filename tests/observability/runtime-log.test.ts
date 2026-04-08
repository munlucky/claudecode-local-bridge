import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
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
})
