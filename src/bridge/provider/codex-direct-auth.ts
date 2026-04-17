import { existsSync, readFileSync } from 'node:fs'
import type { RouterConfig } from '../../server/config.js'

export interface CodexDirectAuthState {
	authType: 'oauth' | 'api_key'
	accessToken?: string | null
	refreshToken?: string | null
	expiresAt?: string | null
	accountId?: string | null
}

export interface CodexDirectAuthHealth {
	hasAuthDependency: boolean
	ready: boolean
	message: string | null
	state: 'ready' | 'refreshable' | 'expired' | 'missing'
	hasStoredState: boolean
}

function parseAuthState(raw: string): CodexDirectAuthState | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const authType = parsed.authType
		if (authType !== 'oauth' && authType !== 'api_key') {
			return null
		}

		return {
			authType,
			accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : null,
			refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
			expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
			accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null,
		}
	} catch {
		return null
	}
}

export function readCodexDirectAuthState(config: RouterConfig): CodexDirectAuthState | null {
	if (!existsSync(config.codexDirectAuthStateFile)) {
		return null
	}

	return parseAuthState(readFileSync(config.codexDirectAuthStateFile, 'utf8'))
}

function isExpired(expiresAt: string | null | undefined): boolean {
	if (!expiresAt) {
		return false
	}

	const expiresAtMs = Date.parse(expiresAt)
	return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()
}

export function getCodexDirectAuthHealth(config: RouterConfig): CodexDirectAuthHealth {
	if (!config.codexDirectEnabled) {
		return {
			hasAuthDependency: false,
			ready: false,
			message: 'codex-direct is disabled',
			state: 'missing',
			hasStoredState: false,
		}
	}

	if (config.codexDirectAuthMode === 'disabled') {
		return {
			hasAuthDependency: false,
			ready: false,
			message: 'codex-direct auth mode is disabled',
			state: 'missing',
			hasStoredState: false,
		}
	}

	if (config.codexDirectAuthMode === 'api_key') {
		const hasApiKey = Boolean(config.codexOpenAiApiKey)
		return {
			hasAuthDependency: true,
			ready: hasApiKey,
			message: hasApiKey ? null : 'CODEX_OPENAI_API_KEY is required for codex-direct api_key mode',
			state: hasApiKey ? 'ready' : 'missing',
			hasStoredState: false,
		}
	}

	const authState = readCodexDirectAuthState(config)
	if (!authState) {
		if (config.codexDirectAuthMode === 'oauth') {
			return {
				hasAuthDependency: true,
				ready: false,
				message: 'codex-direct OAuth state file is missing or invalid',
				state: 'missing',
				hasStoredState: false,
			}
		}

		const hasApiKey = Boolean(config.codexOpenAiApiKey)
		return {
			hasAuthDependency: true,
			ready: hasApiKey,
			message: hasApiKey
				? 'using CODEX_OPENAI_API_KEY fallback because codex-direct OAuth state is missing'
				: 'codex-direct requires OAuth state or CODEX_OPENAI_API_KEY',
			state: hasApiKey ? 'ready' : 'missing',
			hasStoredState: false,
		}
	}

	if (!authState.accessToken) {
		return {
			hasAuthDependency: true,
			ready: false,
			message: 'codex-direct OAuth state does not contain an access token',
			state: 'missing',
			hasStoredState: true,
		}
	}

	if (!isExpired(authState.expiresAt)) {
		return {
			hasAuthDependency: true,
			ready: true,
			message: null,
			state: 'ready',
			hasStoredState: true,
		}
	}

	if (authState.refreshToken) {
		return {
			hasAuthDependency: true,
			ready: true,
			message: 'codex-direct OAuth access token is expired but can be refreshed on the next request',
			state: 'refreshable',
			hasStoredState: true,
		}
	}

	return {
		hasAuthDependency: true,
		ready: false,
		message: 'codex-direct OAuth access token is expired',
		state: 'expired',
		hasStoredState: true,
	}
}
