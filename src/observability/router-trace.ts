import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RouterConfig } from '../server/index.js'
import type {
	AnthropicMessagesRequest,
	CodexPromptMetrics,
	CodexBridgeDecision,
	CodexThreadMode,
	CodexThreadReuseReason,
} from '../shared/index.js'
import { redactSensitiveValue } from './request-capture.js'
import { appendRuntimeLog } from './runtime-log.js'

export interface RouterTraceContext {
	router_request_id: string
	method: string
	path: string
	started_at: string
	header_names: string[]
	headers: {
		user_agent: string | null
		anthropic_beta: string | null
		x_claude_code_session_id: string | null
		x_bridge_session_id: string | null
		authorization_bridge_session_id: string | null
		resolved_session_id: string | null
		x_request_id: string | null
		x_app: string | null
		x_stainless_arch: string | null
		x_stainless_lang: string | null
		x_stainless_os: string | null
		x_stainless_package_version: string | null
		x_stainless_retry_count: string | null
		x_stainless_runtime: string | null
		x_stainless_runtime_version: string | null
		x_stainless_timeout: string | null
	}
	model: string | null
	stream: boolean | null
	message_count: number | null
	tool_count: number
	tool_names: string[]
}

export interface RouterResponseTrace {
	status: number
	duration_ms: number
	stop_reason?: string | null
	error_type?: string
	error_message?: string
	provider_status?: number | null
	upstream_request_id?: string | null
	upstream_response_id?: string | null
	upstream_error_preview?: string | null
	codex_model?: string | null
	usage_output_tokens?: number | null
	usage_input_tokens?: number | null
	usage_cached_input_tokens?: number | null
	usage_reasoning_output_tokens?: number | null
	usage_total_tokens?: number | null
	prompt_metrics?: CodexPromptMetrics
	conversation_id?: string | null
	workspace_root?: string | null
	thread_mode?: CodexThreadMode | null
	thread_reuse_reason?: CodexThreadReuseReason | null
	thread_cache_key?: string | null
	stream_end_reason?: string | null
	decision_kind?: CodexBridgeDecision['kind'] | null
	tool_use_name?: string | null
	tool_use_input_preview?: string | null
	tool_use_file_path?: string | null
	tool_use_path?: string | null
	tool_use_pattern?: string | null
}

function getHeader(headers: Headers, key: string): string | null {
	const value = headers.get(key)
	return value && value.trim() ? value.trim() : null
}

function parseAuthorizationBridgeSessionId(value: string | null): string | null {
	if (!value) {
		return null
	}

	const [scheme, token] = value.split(/\s+/, 2)
	if (scheme?.toLowerCase() !== 'bearer' || !token) {
		return null
	}

	const marker = '__bridge_session__'
	const index = token.lastIndexOf(marker)
	if (index < 0) {
		return null
	}

	const sessionId = token.slice(index + marker.length).trim()
	return sessionId || null
}

export function buildRouterTraceContext(input: {
	method: string
	path: string
	headers: Headers
	request?: AnthropicMessagesRequest
	routerRequestId?: string
}): RouterTraceContext {
	const request = input.request
	const tools = Array.isArray(request?.tools) ? request.tools : []
	const upstreamRequestId = getHeader(input.headers, 'x-request-id')
	const claudeCodeSessionId = getHeader(input.headers, 'x-claude-code-session-id')
	const bridgeSessionId = getHeader(input.headers, 'x-bridge-session-id')
	const authorizationBridgeSessionId = parseAuthorizationBridgeSessionId(
		getHeader(input.headers, 'authorization'),
	)

	return {
		router_request_id:
			input.routerRequestId || upstreamRequestId || `routerreq_${crypto.randomUUID()}`,
		method: input.method,
		path: input.path,
		started_at: new Date().toISOString(),
		header_names: [...input.headers.keys()].sort(),
		headers: {
			user_agent: getHeader(input.headers, 'user-agent'),
			anthropic_beta: getHeader(input.headers, 'anthropic-beta'),
			x_claude_code_session_id: claudeCodeSessionId,
			x_bridge_session_id: bridgeSessionId,
			authorization_bridge_session_id: authorizationBridgeSessionId,
			resolved_session_id:
				claudeCodeSessionId ?? bridgeSessionId ?? authorizationBridgeSessionId,
			x_request_id: upstreamRequestId,
			x_app: getHeader(input.headers, 'x-app'),
			x_stainless_arch: getHeader(input.headers, 'x-stainless-arch'),
			x_stainless_lang: getHeader(input.headers, 'x-stainless-lang'),
			x_stainless_os: getHeader(input.headers, 'x-stainless-os'),
			x_stainless_package_version: getHeader(
				input.headers,
				'x-stainless-package-version',
			),
			x_stainless_retry_count: getHeader(input.headers, 'x-stainless-retry-count'),
			x_stainless_runtime: getHeader(input.headers, 'x-stainless-runtime'),
			x_stainless_runtime_version: getHeader(
				input.headers,
				'x-stainless-runtime-version',
			),
			x_stainless_timeout: getHeader(input.headers, 'x-stainless-timeout'),
		},
		model: typeof request?.model === 'string' ? request.model : null,
		stream: typeof request?.stream === 'boolean' ? request.stream : null,
		message_count: Array.isArray(request?.messages) ? request.messages.length : null,
		tool_count: tools.length,
		tool_names: tools
			.map((tool) => (typeof tool?.name === 'string' ? tool.name : null))
			.filter((name): name is string => Boolean(name)),
	}
}

async function appendJsonLine(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true })
	await appendFile(path, `${JSON.stringify(redactSensitiveValue(value))}\n`, 'utf8')
}

export function logRouterLine(
	message: string,
	options?: {
		config?: RouterConfig
		context?: RouterTraceContext
		stage?: string
	}
) {
	process.stdout.write(`[router] ${new Date().toISOString()} ${message}\n`)
	if (options?.config) {
		void appendRuntimeLog(options.config, {
			channel: '01-router-events',
			routerRequestId: options.context?.router_request_id ?? null,
			payload: {
				level: 'info',
				stage: options.stage ?? 'router',
				message,
				...(options.context
					? {
							method: options.context.method,
							path: options.context.path,
							router_request_id: options.context.router_request_id,
						}
					: {}),
			},
		})
	}
}

export async function captureRouterResponse(
	config: RouterConfig,
	context: RouterTraceContext,
	response: RouterResponseTrace,
) {
	if (!config.captureResponses) {
		return
	}

	await appendJsonLine(config.captureResponsesPath, {
		timestamp: new Date().toISOString(),
		type: 'response',
		...context,
		...response,
	})
	await appendRuntimeLog(config, {
		channel: '03-anthropic-responses',
		routerRequestId: context.router_request_id,
		payload: {
			type: 'response',
			...context,
			...response,
		},
	})
}

export async function captureRouterStreamEvent(
	config: RouterConfig,
	context: RouterTraceContext,
	event: {
		stream_phase: 'opened' | 'completed' | 'failed' | 'cancelled'
		duration_ms: number
		status: number
		stream_end_reason?: string | null
		error_message?: string
		upstream_response_id?: string | null
		codex_model?: string | null
		conversation_id?: string | null
		workspace_root?: string | null
		thread_mode?: CodexThreadMode | null
		thread_reuse_reason?: CodexThreadReuseReason | null
		thread_cache_key?: string | null
		usage_input_tokens?: number | null
		usage_cached_input_tokens?: number | null
		usage_reasoning_output_tokens?: number | null
		usage_total_tokens?: number | null
		prompt_metrics?: CodexPromptMetrics
		usage_output_tokens?: number | null
		decision_kind?: CodexBridgeDecision['kind'] | null
		tool_use_name?: string | null
		tool_use_input_preview?: string | null
		tool_use_file_path?: string | null
		tool_use_path?: string | null
		tool_use_pattern?: string | null
	},
) {
	if (!config.captureResponses) {
		return
	}

	await appendJsonLine(config.captureResponsesPath, {
		timestamp: new Date().toISOString(),
		type: 'stream',
		...context,
		...event,
	})
	await appendRuntimeLog(config, {
		channel: '03-anthropic-responses',
		routerRequestId: context.router_request_id,
		payload: {
			type: 'stream',
			...context,
			...event,
		},
	})
}
