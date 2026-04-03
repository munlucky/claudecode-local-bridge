import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from './config.js'
import { mapCodexResultToAnthropic } from '../bridge/anthropic/index.js'
import { AuthConfigurationError, checkCodexAuthDependency, executeCodexTurn } from '../bridge/codex/index.js'
import {
	captureAnthropicRequest,
	buildRouterTraceContext,
	captureRouterResponse,
	captureRouterStreamEvent,
	logRouterLine,
} from '../observability/index.js'
import { createAnthropicStream } from './streaming.js'
import type {
	AnthropicMessagesRequest,
	RouterHealthResponse,
} from '../shared/index.js'

const contentBlockSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.object({
			type: z.literal('text'),
			text: z.string(),
		}),
		z.object({
			type: z.literal('thinking'),
			thinking: z.string(),
			signature: z.string().optional(),
		}),
		z.object({
			type: z.literal('tool_use'),
			id: z.string(),
			name: z.string(),
			input: z.unknown(),
		}),
		z.object({
			type: z.literal('tool_result'),
			tool_use_id: z.string(),
			content: z.union([z.string(), z.array(contentBlockSchema)]),
		}),
		z.object({
			type: z.literal('image'),
			source: z.object({
				type: z.literal('base64'),
				media_type: z.string(),
				data: z.string(),
			}),
		}),
	]),
)

const thinkingSchema = z
	.union([
		z
			.object({
				type: z.literal('enabled'),
				budget_tokens: z.number().int().nonnegative().optional(),
			})
			.passthrough(),
		z
			.object({
				type: z.string().optional(),
				budget_tokens: z.number().int().nonnegative().optional(),
			})
			.passthrough(),
	])
	.optional()

export const requestSchema = z.object({
	model: z.string().min(1),
	max_tokens: z.number().int().positive(),
	messages: z.array(
		z.object({
			role: z.enum(['user', 'assistant']),
			content: z.union([z.string(), z.array(contentBlockSchema)]),
		}),
	),
	system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
	stream: z.boolean().optional(),
	tools: z
		.array(
			z.object({
				name: z.string(),
				description: z.string().optional(),
				input_schema: z.record(z.string(), z.unknown()),
			}),
		)
		.optional(),
	tool_choice: z.unknown().optional(),
	thinking: thinkingSchema,
	temperature: z.number().min(0).max(2).optional(),
	top_p: z.number().min(0).max(1).optional(),
	top_k: z.number().int().positive().optional(),
})

function mapErrorType(statusCode: number): string {
	if (statusCode === 400) {
		return 'invalid_request_error'
	}

	if (statusCode === 401 || statusCode === 403) {
		return 'authentication_error'
	}

	if (statusCode === 429) {
		return 'rate_limit_error'
	}

	return 'api_error'
}

function buildErrorResponse(message: string, statusCode: number, routerRequestId?: string) {
	return Response.json(
		{
			error: {
				type: mapErrorType(statusCode),
				message,
			},
		},
		{
			status: statusCode,
			headers: routerRequestId
				? {
						'X-Router-Request-Id': routerRequestId,
					}
				: undefined,
		},
	)
}

export function createApp() {
	const config = loadConfig()
	const app = new Hono()
	const AUTH_MODE_DEPENDENCY_TTL_MS = 30 * 1000
	const AUTH_MODE_DEPENDENCY_TIMEOUT_MS = 1500
	const authModeDependencyCache = {
		value: true,
		checkedAt: 0,
		inflight: null as Promise<boolean> | null,
	}

	function getAuthModeDependencyState(
		config: RouterConfig,
	): RouterHealthResponse['has_auth_mode_dependency'] | Promise<RouterHealthResponse['has_auth_mode_dependency']> {
		switch (config.codexAuthMode) {
			case 'api_key':
				return Boolean(config.codexOpenAiApiKey)
			case 'local_auth_json':
				return existsSync(config.codexAuthFile)
			case 'account':
				if (
					authModeDependencyCache.checkedAt > 0 &&
					Date.now() - authModeDependencyCache.checkedAt <= AUTH_MODE_DEPENDENCY_TTL_MS &&
					!authModeDependencyCache.inflight
				) {
					return authModeDependencyCache.value
				}

				if (!authModeDependencyCache.inflight) {
					authModeDependencyCache.inflight = checkCodexAuthDependency(
						config,
						AUTH_MODE_DEPENDENCY_TIMEOUT_MS,
					)
						.then((result) => {
							authModeDependencyCache.value = result
							authModeDependencyCache.checkedAt = Date.now()
							return result
						})
						.catch(() => {
							authModeDependencyCache.value = false
							authModeDependencyCache.checkedAt = Date.now()
							return false
						})
						.finally(() => {
							authModeDependencyCache.inflight = null
						})
				}

				return authModeDependencyCache.inflight
			default:
				return true
		}
	}

	if (config.logRequests) {
		app.use('*', async (c, next) => {
			const startedAt = Date.now()
			logRouterLine(`request ${c.req.method} ${c.req.path}`)
			await next()
			logRouterLine(
				`response ${c.req.method} ${c.req.path} status=${c.res.status} duration_ms=${Date.now() - startedAt}`,
			)
		})
	}

	app.get('/', (c) => c.redirect('/health'))

	app.get('/health', async (c) => {
		const hasLocalAuthFile = existsSync(config.codexAuthFile)
		const hasAuthModeDependency = await getAuthModeDependencyState(config)
		const body: RouterHealthResponse = {
			status: 'ok',
			backend: 'codex_app_server',
			auth_mode: config.codexAuthMode,
			codex_command: config.codexCommand,
			codex_runtime_cwd: config.codexRuntimeCwd,
			codex_auth_file: config.codexAuthFile,
			has_local_auth_file: hasLocalAuthFile,
			has_auth_mode_dependency: hasAuthModeDependency,
		}

		const isHealthy = Boolean(hasAuthModeDependency)
		if (!isHealthy) {
			if (config.codexAuthMode === 'local_auth_json' && !hasLocalAuthFile) {
				logRouterLine(
					`health auth dependency check failed: local_auth_json missing auth file path=${config.codexAuthFile}`,
				)
			} else if (config.codexAuthMode === 'account') {
				logRouterLine('health auth dependency check failed: account auth probe returned false')
			}
		}

		return c.json(body, isHealthy ? 200 : 503)
	})

	app.get('/v1/models', (c) => {
		const modelIds = Object.keys(config.modelAliases)
		return c.json({
			data: modelIds.map((id) => ({
				type: 'model',
				id,
				display_name: id,
			})),
			has_more: false,
			first_id: modelIds[0] ?? null,
			last_id: modelIds.at(-1) ?? null,
		})
	})

	app.post('/v1/messages', async (c) => {
		const startedAt = Date.now()
		let traceContext = buildRouterTraceContext({
			method: c.req.method,
			path: c.req.path,
			headers: c.req.raw.headers,
		})
		const rawBody = await c.req.text()
		let requestBody: AnthropicMessagesRequest
		logRouterLine(
			`messages begin request_id=${traceContext.router_request_id} session_id=${traceContext.headers.resolved_session_id ?? 'none'} method=${traceContext.method} path=${traceContext.path}`,
		)
		try {
			requestBody = requestSchema.parse(JSON.parse(rawBody)) as AnthropicMessagesRequest
			traceContext = buildRouterTraceContext({
				method: c.req.method,
				path: c.req.path,
				headers: c.req.raw.headers,
				request: requestBody,
				routerRequestId: traceContext.router_request_id,
			})
			await captureAnthropicRequest(config, {
				traceContext,
				rawBody,
				parsedRequest: requestBody,
			})
		} catch (error) {
			await captureAnthropicRequest(config, {
				traceContext,
				rawBody,
				parseError: error instanceof Error ? error.message : 'request parse failed',
			})
			const message =
				error instanceof z.ZodError
					? error.issues.map((issue) => issue.message).join(', ')
					: error instanceof Error
						? error.message
						: '잘못된 요청입니다.'
			await captureRouterResponse(config, traceContext, {
				status: 400,
				duration_ms: Date.now() - startedAt,
				error_type: mapErrorType(400),
				error_message: message,
			})
			logRouterLine(
				`messages failed request_id=${traceContext.router_request_id} status=400 duration_ms=${Date.now() - startedAt} error=${JSON.stringify(message)}`,
			)
			return buildErrorResponse(message, 400, traceContext.router_request_id)
		}

		try {
			if (requestBody.stream) {
				await captureRouterStreamEvent(config, traceContext, {
					stream_phase: 'opened',
					status: 200,
					duration_ms: Date.now() - startedAt,
				})
				const codexContext = {
					sessionId: traceContext.headers.resolved_session_id,
					routerRequestId: traceContext.router_request_id,
					userAgent: traceContext.headers.user_agent,
				}
				const stream = createAnthropicStream(config, requestBody, codexContext, {
					onSessionReady: async (metadata) => {
						logRouterLine(
							`stream session_ready request_id=${traceContext.router_request_id} conversation_id=${metadata.threadId} model=${metadata.model} workspace_root=${JSON.stringify(metadata.workspaceRoot)} thread_mode=${metadata.threadMode} thread_reuse_reason=${metadata.threadReuseReason} thread_cache_key=${metadata.threadCacheKey ?? 'none'}`,
						)
					},
					onComplete: async ({ stopReason, usage, promptMetrics, decision, metadata }) => {
						await captureRouterStreamEvent(config, traceContext, {
							stream_phase: 'completed',
							status: 200,
							duration_ms: Date.now() - startedAt,
							stream_end_reason: stopReason,
							codex_model: metadata.model,
							conversation_id: metadata.threadId,
							workspace_root: metadata.workspaceRoot,
							thread_mode: metadata.threadMode,
							thread_reuse_reason: metadata.threadReuseReason,
							thread_cache_key: metadata.threadCacheKey,
							usage_output_tokens: usage.outputTokens,
							usage_input_tokens: usage.inputTokens,
							usage_cached_input_tokens: usage.cachedInputTokens,
							usage_reasoning_output_tokens: usage.reasoningOutputTokens,
							usage_total_tokens: usage.totalTokens,
							prompt_metrics: promptMetrics,
							decision_kind: decision?.kind ?? null,
							tool_use_name:
								decision?.kind === 'tool_use' ? decision.name : null,
						})
						logRouterLine(
							`stream completed request_id=${traceContext.router_request_id} conversation_id=${metadata.threadId} end_reason=${stopReason} tool=${decision?.kind === 'tool_use' ? decision.name : 'none'} output_tokens=${usage.outputTokens} thread_mode=${metadata.threadMode} thread_reuse_reason=${metadata.threadReuseReason}`,
						)
					},
					onError: async ({ error, metadata }) => {
						const message = error instanceof Error ? error.message : String(error)
						await captureRouterStreamEvent(config, traceContext, {
							stream_phase: 'failed',
							status: 200,
							duration_ms: Date.now() - startedAt,
							stream_end_reason: 'error',
							error_message: message,
							codex_model: metadata?.model ?? null,
							conversation_id: metadata?.threadId ?? null,
							workspace_root: metadata?.workspaceRoot ?? null,
							thread_mode: metadata?.threadMode ?? null,
							thread_reuse_reason: metadata?.threadReuseReason ?? null,
							thread_cache_key: metadata?.threadCacheKey ?? null,
						})
						logRouterLine(
							`stream failed request_id=${traceContext.router_request_id} conversation_id=${metadata?.threadId ?? 'none'} error=${JSON.stringify(message)} thread_mode=${metadata?.threadMode ?? 'none'} thread_reuse_reason=${metadata?.threadReuseReason ?? 'none'}`,
						)
					},
					onCancel: async ({ metadata }) => {
						await captureRouterStreamEvent(config, traceContext, {
							stream_phase: 'cancelled',
							status: 499,
							duration_ms: Date.now() - startedAt,
							stream_end_reason: 'cancelled',
							codex_model: metadata?.model ?? null,
							conversation_id: metadata?.threadId ?? null,
							workspace_root: metadata?.workspaceRoot ?? null,
							thread_mode: metadata?.threadMode ?? null,
							thread_reuse_reason: metadata?.threadReuseReason ?? null,
							thread_cache_key: metadata?.threadCacheKey ?? null,
						})
						logRouterLine(
							`stream cancelled request_id=${traceContext.router_request_id} conversation_id=${metadata?.threadId ?? 'none'} thread_mode=${metadata?.threadMode ?? 'none'} thread_reuse_reason=${metadata?.threadReuseReason ?? 'none'}`,
						)
					},
				})
				return new Response(stream, {
					status: 200,
					headers: {
						'Content-Type': 'text/event-stream; charset=utf-8',
						'Cache-Control': 'no-cache, no-transform',
						Connection: 'keep-alive',
						'X-Router-Request-Id': traceContext.router_request_id,
					},
				})
			}

			const result = await executeCodexTurn(config, requestBody, {
				sessionId: traceContext.headers.resolved_session_id,
				routerRequestId: traceContext.router_request_id,
				userAgent: traceContext.headers.user_agent,
			})
			const anthropicResponse = mapCodexResultToAnthropic(result, requestBody.model)
			c.header('X-Router-Request-Id', traceContext.router_request_id)
			await captureRouterResponse(config, traceContext, {
				status: 200,
				duration_ms: Date.now() - startedAt,
				stop_reason: anthropicResponse.stop_reason,
				codex_model: result.model,
				conversation_id: result.metadata?.threadId ?? null,
				workspace_root: result.metadata?.workspaceRoot ?? null,
				thread_mode: result.metadata?.threadMode ?? null,
				thread_reuse_reason: result.metadata?.threadReuseReason ?? null,
				thread_cache_key: result.metadata?.threadCacheKey ?? null,
				usage_output_tokens: result.usage.outputTokens,
				usage_input_tokens: result.usage.inputTokens,
				usage_cached_input_tokens: result.usage.cachedInputTokens,
				usage_reasoning_output_tokens: result.usage.reasoningOutputTokens,
				usage_total_tokens: result.usage.totalTokens,
				prompt_metrics: result.promptMetrics,
				decision_kind: result.decision?.kind ?? null,
				tool_use_name:
					result.decision?.kind === 'tool_use' ? result.decision.name : null,
			})
			logRouterLine(
				`messages completed request_id=${traceContext.router_request_id} status=200 stop_reason=${anthropicResponse.stop_reason ?? 'null'} duration_ms=${Date.now() - startedAt} conversation_id=${result.metadata?.threadId ?? 'none'} thread_mode=${result.metadata?.threadMode ?? 'none'} thread_reuse_reason=${result.metadata?.threadReuseReason ?? 'none'}`,
			)
			return c.json(anthropicResponse)
		} catch (error) {
			if (error instanceof AuthConfigurationError) {
				await captureRouterResponse(config, traceContext, {
					status: 500,
					duration_ms: Date.now() - startedAt,
					error_type: mapErrorType(500),
					error_message: error.message,
				})
				logRouterLine(
					`messages failed request_id=${traceContext.router_request_id} status=500 duration_ms=${Date.now() - startedAt} error=${JSON.stringify(error.message)}`,
				)
				return buildErrorResponse(error.message, 500, traceContext.router_request_id)
			}

			const message = error instanceof Error ? error.message : '내부 서버 오류'
			await captureRouterResponse(config, traceContext, {
				status: 500,
				duration_ms: Date.now() - startedAt,
				error_type: mapErrorType(500),
				error_message: message,
			})
			logRouterLine(
				`messages failed request_id=${traceContext.router_request_id} status=500 duration_ms=${Date.now() - startedAt} error=${JSON.stringify(message)}`,
			)
			return buildErrorResponse(message, 500, traceContext.router_request_id)
		}
	})

	return {
		app,
		config,
		hasCodexAuthFile: existsSync(config.codexAuthFile),
	}
}
