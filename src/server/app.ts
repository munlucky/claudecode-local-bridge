import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from './config.js'
import { mapCodexResultToAnthropic } from '../bridge/anthropic/index.js'
import { AuthConfigurationError, executeCodexTurn } from '../bridge/codex/index.js'
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

	app.get('/health', (c) => {
		const body: RouterHealthResponse = {
			status: 'ok',
			backend: 'codex_app_server',
			auth_mode: config.codexAuthMode,
			codex_command: config.codexCommand,
			codex_runtime_cwd: config.codexRuntimeCwd,
			codex_auth_file: config.codexAuthFile,
			has_local_auth_file: existsSync(config.codexAuthFile),
		}

		return c.json(body)
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
			`messages begin request_id=${traceContext.router_request_id} session_id=${traceContext.headers.x_claude_code_session_id ?? 'none'} method=${traceContext.method} path=${traceContext.path}`,
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
				const stream = createAnthropicStream(config, requestBody, {
					onSessionReady: async (metadata) => {
						logRouterLine(
							`stream session_ready request_id=${traceContext.router_request_id} conversation_id=${metadata.threadId} model=${metadata.model}`,
						)
					},
					onComplete: async ({ stopReason, usage, decision, metadata }) => {
						await captureRouterStreamEvent(config, traceContext, {
							stream_phase: 'completed',
							status: 200,
							duration_ms: Date.now() - startedAt,
							stream_end_reason: stopReason,
							codex_model: metadata.model,
							conversation_id: metadata.threadId,
							usage_output_tokens: usage.outputTokens,
							decision_kind: decision?.kind ?? null,
							tool_use_name:
								decision?.kind === 'tool_use' ? decision.name : null,
						})
						logRouterLine(
							`stream completed request_id=${traceContext.router_request_id} conversation_id=${metadata.threadId} end_reason=${stopReason} tool=${decision?.kind === 'tool_use' ? decision.name : 'none'} output_tokens=${usage.outputTokens}`,
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
						})
						logRouterLine(
							`stream failed request_id=${traceContext.router_request_id} conversation_id=${metadata?.threadId ?? 'none'} error=${JSON.stringify(message)}`,
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
						})
						logRouterLine(
							`stream cancelled request_id=${traceContext.router_request_id} conversation_id=${metadata?.threadId ?? 'none'}`,
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

			const result = await executeCodexTurn(config, requestBody)
			const anthropicResponse = mapCodexResultToAnthropic(result, requestBody.model)
			c.header('X-Router-Request-Id', traceContext.router_request_id)
			await captureRouterResponse(config, traceContext, {
				status: 200,
				duration_ms: Date.now() - startedAt,
				stop_reason: anthropicResponse.stop_reason,
				codex_model: result.model,
				usage_output_tokens: result.usage.outputTokens,
				decision_kind: result.decision?.kind ?? null,
				tool_use_name:
					result.decision?.kind === 'tool_use' ? result.decision.name : null,
			})
			logRouterLine(
				`messages completed request_id=${traceContext.router_request_id} status=200 stop_reason=${anthropicResponse.stop_reason ?? 'null'} duration_ms=${Date.now() - startedAt}`,
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
