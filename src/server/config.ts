import { resolve } from 'node:path'
import { homedir } from 'node:os'

export interface RouterConfig {
	listenHost: string
	listenPort: number
	codexCommand: string
	codexAuthMode: 'disabled' | 'local_auth_json' | 'account' | 'api_key'
	codexAuthFile: string
	codexOpenAiApiKey: string | null
	codexRuntimeCwd: string
	codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
	codexInitTimeoutMs: number
	codexTurnTimeoutMs: number
	codexTurnRequestTimeoutMs: number
	serverIdleTimeoutSec: number
	userAgent: string
	logRequests: boolean
	captureRequests: boolean
	captureRequestsPath: string
	captureResponses: boolean
	captureResponsesPath: string
	heartbeatIntervalSec: number
	modelAliases: Record<string, string>
}

function trimToNull(value: string | undefined): string | null {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

function expandHomePath(value: string): string {
	if (value === '~') {
		return homedir()
	}

	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return resolve(homedir(), value.slice(2))
	}

	return resolve(value)
}

function parsePort(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseTimeout(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	const normalized = value?.trim().toLowerCase()
	if (normalized === undefined || normalized === '') {
		return fallback
	}

	return !['0', 'false', 'no', 'off'].includes(normalized)
}

function parseHeartbeatSeconds(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function deriveIdleTimeoutSec(globalTimeoutMs: number): number {
	return Math.min(255, Math.max(120, Math.ceil(globalTimeoutMs / 1000) + 5))
}

function parseSandboxMode(
	value: string | undefined,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
	switch (value?.trim()) {
		case 'read-only':
			return 'read-only'
		case 'workspace-write':
			return 'workspace-write'
		case 'danger-full-access':
			return 'danger-full-access'
		default:
			return 'workspace-write'
	}
}

function parseCodexAuthMode(
	value: string | undefined,
): 'disabled' | 'local_auth_json' | 'account' | 'api_key' {
	switch (value?.trim()) {
		case 'disabled':
			return 'disabled'
		case 'local_auth_json':
			return 'local_auth_json'
		case 'account':
		case 'chatgpt':
			return 'account'
		case 'api_key':
		case 'apikey':
		case 'openai_api_key':
			return 'api_key'
		default:
			return 'local_auth_json'
	}
}

function parseModelAliases(): Record<string, string> {
	const aliases: Record<string, string> = {
		'claude-opus-4-1-20250805': process.env.CODEX_MODEL_OPUS?.trim() || 'gpt-5.4',
		'claude-sonnet-4-5-20250929': process.env.CODEX_MODEL_SONNET?.trim() || 'gpt-5.4',
		'claude-haiku-4-5-20251001': process.env.CODEX_MODEL_HAIKU?.trim() || 'gpt-5.4-mini',
	}

	const raw = trimToNull(process.env.MODEL_ALIASES_JSON)
	if (!raw) {
		return aliases
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string' && value.trim()) {
				aliases[key] = value.trim()
			}
		}
	} catch (error) {
		throw new Error(
			`MODEL_ALIASES_JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	return aliases
}

export function loadConfig(): RouterConfig {
	const apiTimeoutMs = parseTimeout(process.env.API_TIMEOUT_MS, 180000)
	const codexOpenAiApiKey =
		trimToNull(process.env.CODEX_OPENAI_API_KEY) ?? trimToNull(process.env.OPENAI_API_KEY)
	const codexTurnTimeoutMs = parseTimeout(process.env.CODEX_TURN_TIMEOUT_MS, apiTimeoutMs)

	return {
		listenHost: process.env.ROUTER_LISTEN_HOST?.trim() || '127.0.0.1',
		listenPort: parsePort(process.env.ROUTER_LISTEN_PORT, 3000),
		codexCommand: process.env.CODEX_COMMAND?.trim() || 'codex',
		codexAuthMode: parseCodexAuthMode(process.env.CODEX_AUTH_MODE),
		codexAuthFile: expandHomePath(process.env.CODEX_AUTH_FILE?.trim() || '~/.codex/auth.json'),
		codexOpenAiApiKey,
		codexRuntimeCwd: expandHomePath(
			process.env.CODEX_RUNTIME_CWD?.trim() || '~/.codex/bridge-runtime',
		),
		codexSandboxMode: parseSandboxMode(process.env.CODEX_SANDBOX_MODE),
		codexInitTimeoutMs: parseTimeout(process.env.CODEX_INIT_TIMEOUT_MS, 15000),
		codexTurnTimeoutMs,
		codexTurnRequestTimeoutMs: parseTimeout(
			process.env.CODEX_TURN_REQUEST_TIMEOUT_MS,
			codexTurnTimeoutMs,
		),
		serverIdleTimeoutSec: parseHeartbeatSeconds(
			process.env.ROUTER_IDLE_TIMEOUT_SEC,
			deriveIdleTimeoutSec(apiTimeoutMs),
		),
		userAgent: process.env.ROUTER_USER_AGENT?.trim() || 'claudecode-codex-local-bridge/2.0',
		logRequests: parseBoolean(process.env.ROUTER_LOG_REQUESTS, true),
		captureRequests: parseBoolean(process.env.ROUTER_CAPTURE_REQUESTS, true),
		captureRequestsPath: expandHomePath(
			process.env.ROUTER_CAPTURE_REQUESTS_PATH?.trim() ||
				'.history/anthropic-requests.jsonl',
		),
		captureResponses: parseBoolean(process.env.ROUTER_CAPTURE_RESPONSES, true),
		captureResponsesPath: expandHomePath(
			process.env.ROUTER_CAPTURE_RESPONSES_PATH?.trim() ||
				'.history/anthropic-responses.jsonl',
		),
		heartbeatIntervalSec: parseHeartbeatSeconds(
			process.env.ROUTER_HEARTBEAT_INTERVAL_SEC,
			30,
		),
		modelAliases: parseModelAliases(),
	}
}
