import { appendFile, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RouterConfig } from '../server/index.js'
import { redactSensitiveValue } from './request-capture.js'

type RuntimeLogChannel =
	| '00-session'
	| '01-router-events'
	| '02-anthropic-requests'
	| '03-anthropic-responses'
	| '04-ollama-raw'
	| '05-ollama-raw-lines'

type RuntimeLogState = {
	runId: string
	rootDir: string
	runDir: string
	latestDir: string
	initialized: boolean
	disabled: boolean
}

const RUNTIME_LOG_CHANNELS: RuntimeLogChannel[] = [
	'00-session',
	'01-router-events',
	'02-anthropic-requests',
	'03-anthropic-responses',
	'04-ollama-raw',
	'05-ollama-raw-lines',
]

let runtimeLogState: RuntimeLogState | null = null

function buildRunId() {
	const now = new Date()
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z')
	return `${stamp.toLowerCase()}-pid${process.pid}`
}

function getRuntimeLogState(config: RouterConfig): RuntimeLogState {
	if (runtimeLogState && runtimeLogState.rootDir !== config.runtimeLogsRootPath) {
		runtimeLogState = null
	}

	if (runtimeLogState) {
		return runtimeLogState
	}

	const rootDir = config.runtimeLogsRootPath
	const runId = buildRunId()
	runtimeLogState = {
		runId,
		rootDir,
		runDir: join(rootDir, 'runs', runId),
		latestDir: join(rootDir, 'latest'),
		initialized: false,
		disabled: false,
	}
	return runtimeLogState
}

async function resetLatestFiles(latestDir: string) {
	await mkdir(latestDir, { recursive: true })
	await Promise.all(
		RUNTIME_LOG_CHANNELS.map(async (channel) => {
			const path = join(latestDir, `${channel}.jsonl`)
			await unlink(path).catch(() => undefined)
		}),
	)
}

export async function ensureRuntimeLogSession(config: RouterConfig) {
	if (!config.runtimeLogsEnabled) {
		return null
	}

	const state = getRuntimeLogState(config)
	if (state.initialized) {
		return state
	}
	if (state.disabled) {
		return null
	}

	try {
		await mkdir(join(state.runDir, 'requests'), { recursive: true })
		await resetLatestFiles(state.latestDir)

		const session = redactSensitiveValue({
			timestamp: new Date().toISOString(),
			run_id: state.runId,
			pid: process.pid,
			cwd: process.cwd(),
			listen_host: config.listenHost,
			listen_port: config.listenPort,
			backend: config.bridgeBackend,
			...(config.bridgeBackend === 'codex'
				? {
						codex_command: config.codexCommand,
						codex_auth_mode: config.codexAuthMode,
						codex_auth_file: config.codexAuthFile,
						codex_runtime_cwd: config.codexRuntimeCwd,
					}
				: {
						ollama_base_url: config.ollamaBaseUrl,
						ollama_model: config.ollamaModel,
						ollama_request_timeout_ms: config.ollamaRequestTimeoutMs,
					}),
			capture_requests_path: config.captureRequestsPath,
			capture_responses_path: config.captureResponsesPath,
			root_dir: state.rootDir,
			run_dir: state.runDir,
			latest_dir: state.latestDir,
		})

		await writeFile(join(state.runDir, '00-session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8')
		await writeFile(join(state.latestDir, '00-session.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8')
		await writeFile(join(state.rootDir, 'latest-run.txt'), `${state.runDir}\n`, 'utf8')
		state.initialized = true
		return state
	} catch (error) {
		state.disabled = true
		console.warn(
			`[runtime-log] disabled: failed to initialize runtime log session at ${state.rootDir}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
		return null
	}
}

async function appendJsonLine(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(redactSensitiveValue(value))}\n`, 'utf8')
}

export function getRuntimeLogInfo(config: RouterConfig) {
	if (!config.runtimeLogsEnabled) {
		return null
	}

	const state = getRuntimeLogState(config)
	return {
		runId: state.runId,
		rootDir: state.rootDir,
		runDir: state.runDir,
		latestDir: state.latestDir,
		latestRunPointerPath: join(state.rootDir, 'latest-run.txt'),
	}
}

export async function appendRuntimeLog(
	config: RouterConfig,
	input: {
		channel: RuntimeLogChannel
		payload: Record<string, unknown>
		routerRequestId?: string | null
	},
) {
	if (!config.runtimeLogsEnabled) {
		return
	}

	const state = await ensureRuntimeLogSession(config)
	if (!state) {
		return
	}

	const record = {
		timestamp: new Date().toISOString(),
		run_id: state.runId,
		...(input.routerRequestId ? { router_request_id: input.routerRequestId } : {}),
		...input.payload,
	}
	await Promise.all([
		appendJsonLine(join(state.runDir, `${input.channel}.jsonl`), record),
		appendJsonLine(join(state.latestDir, `${input.channel}.jsonl`), record),
	])

	if (input.routerRequestId) {
		await appendJsonLine(join(state.runDir, 'requests', `${input.routerRequestId}.jsonl`), {
			_channel: input.channel,
			...record,
		})
	}
}
