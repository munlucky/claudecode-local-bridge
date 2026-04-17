import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { renderCanonicalStreamAsAnthropicSse } from '../bridge/anthropic/surface.js'
import { checkCodexAuthDependency, getCodexBridgeRuntimeSnapshot } from '../bridge/codex/index.js'
import { AnthropicRequestValidationError, validateAnthropicRequestSemantics } from '../bridge/anthropic/index.js'
import {
	anthropicRequestToCanonical,
	canonicalResponseToAnthropic,
} from '../bridge/canonical/anthropic.js'
import { CodexDirectProviderError } from '../bridge/provider/codex-direct.js'
import { getCodexDirectAuthHealth } from '../bridge/provider/codex-direct-auth.js'
import { OpenAiCompatibleProviderError } from '../bridge/provider/openai-compatible.js'
import { createProviderRegistry, getProviderRegistryEntry } from '../bridge/provider/registry.js'
import { resolveProviderTarget } from '../bridge/provider/selector.js'
import {
	buildRouterTraceContext,
	captureAnthropicRequest,
	captureRouterResponse,
	captureRouterStreamEvent,
	logRouterLine,
} from '../observability/index.js'
import { loadConfig } from './config.js'
import type { RouterConfig } from './config.js'
import {
	applyProviderModelToRequest,
	buildHealthPayload,
	buildDirectSkillResponse,
	createDirectSkillStream,
	detectDirectSkillInvocation,
	detectModelSelectionContext,
	extractConversationId,
	extractSessionId,
	formatRouterModelList,
	listVisibleModels,
	overrideResponseModel,
	pickUsageForCapture,
	summarizeToolInputForCapture,
	toErrorResponse,
	toStreamHeaders,
	validateProviderNonStreamCompatibility,
} from './app-support.js'
import type {
	AnthropicMessagesRequest,
	CodexPromptMetrics,
} from '../shared/index.js'

export const requestSchema = z.object({
	model: z.string().min(1, 'model is required'),
	max_tokens: z.number().int().positive(),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant', 'system']),
				content: z.union([
					z.string(),
					z.array(
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
								id: z.string().min(1),
								name: z.string().min(1),
								input: z.record(z.string(), z.unknown()),
							}),
							z.object({
								type: z.literal('tool_result'),
								tool_use_id: z.string().min(1),
								content: z.union([z.string(), z.array(z.unknown())]),
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
					),
				]),
			}),
		)
		.min(1, 'messages is required'),
	system: z.union([z.string(), z.array(z.unknown())]).optional(),
	stream: z.boolean().optional(),
	tools: z
		.array(
			z.object({
				name: z.string().min(1),
				description: z.string().optional(),
				input_schema: z.record(z.string(), z.unknown()),
			}),
		)
		.optional(),
	tool_choice: z
		.union([
			z.literal('auto'),
			z.literal('any'),
			z.literal('none'),
			z.object({
				type: z.union([z.literal('tool'), z.literal('none')]),
				name: z.string().optional(),
			}),
		])
		.optional(),
	thinking: z
		.union([
			z.object({
				type: z.literal('disabled'),
			}),
			z.object({
				type: z.literal('enabled'),
				budget_tokens: z.number().positive().int(),
			}),
			z.object({
				budget_tokens: z.number().positive().int(),
			}),
			z
				.object({
					type: z.string().optional(),
					budget_tokens: z.number().positive().int().optional(),
				})
				.passthrough(),
		])
		.optional(),
	temperature: z.number().min(0).max(2).optional(),
	top_p: z.number().min(0).max(1).optional(),
	top_k: z.number().int().positive().optional(),
})

type AppFactoryResult = {
	app: Hono
	config: RouterConfig
	hasCodexAuthFile: boolean
}

export function createApp(): AppFactoryResult {
	const config = loadConfig()
	const hasCodexAuthFile = config.codexAuthMode === 'local_auth_json' ? existsSync(config.codexAuthFile) : false
	const app = new Hono()
	const providerRegistry = createProviderRegistry(config)
	const activeProvider = getProviderRegistryEntry(providerRegistry, config.activeProviderId)
	const logRequests = config.logRequests

	app.get('/health', async (c) => {
		const startedAt = Date.now()
		let hasAuthDependency = true
		let healthReady = true
		let authMessage: string | null = null
		let codexSnapshot: ReturnType<typeof getCodexBridgeRuntimeSnapshot> = {
			activeSessionCount: 0,
			pendingSessionCreates: 0,
			queueDepth: 0,
			recentRetryableFailures: 0,
			recentNonRetryableFailures: 0,
			recentRetries: 0,
		}

		if (config.bridgeBackend === 'codex') {
			if (config.activeProviderId === 'codex-direct') {
				const directAuth = getCodexDirectAuthHealth(config)
				hasAuthDependency = directAuth.hasAuthDependency
				healthReady = directAuth.ready
				authMessage = directAuth.message
			} else {
				try {
					hasAuthDependency = await checkCodexAuthDependency(config)
					codexSnapshot = getCodexBridgeRuntimeSnapshot()
				} catch (error) {
					healthReady = false
					authMessage = error instanceof Error ? error.message : 'health check failed'
				}
			}
		}

		const status = healthReady ? 200 : 503
		if (config.captureResponses) {
			await captureRouterResponse(
				config,
				buildRouterTraceContext({
					method: 'GET',
					path: '/health',
					headers: c.req.raw.headers,
				}),
				{
					status,
					duration_ms: Date.now() - startedAt,
					error_type: healthReady ? undefined : 'auth_dependency_error',
					error_message: healthReady ? undefined : authMessage ?? 'health dependency check failed',
				},
			)
		}

		if (logRequests) {
			logRouterLine(
				`GET /health status=${status} backend=${config.bridgeBackend} auth_dependency=${hasAuthDependency} readiness=${healthReady ? 'ready' : 'degraded'}`,
				{ config, stage: 'health' },
			)
		}

		return c.json(buildHealthPayload(config, healthReady, hasAuthDependency, authMessage, codexSnapshot), status)
	})

	app.get('/v1/models', async (c) => {
		const startedAt = Date.now()
		const requestContext = buildRouterTraceContext({
			method: 'GET',
			path: '/v1/models',
			headers: c.req.raw.headers,
		})
		try {
			const models = await listVisibleModels(
				config,
				providerRegistry,
				activeProvider.id,
				c.req.raw.signal,
			)
			const responsePayload = formatRouterModelList(models)
			if (config.captureResponses) {
				await captureRouterResponse(config, requestContext, {
					status: 200,
					duration_ms: Date.now() - startedAt,
				})
			}
			if (logRequests) {
				logRouterLine(`GET /v1/models status=200 provider=${activeProvider.id}`, {
					config,
					context: requestContext,
					stage: 'models',
				})
			}
			return c.json(responsePayload)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'model list failed'
			if (config.captureResponses) {
				await captureRouterResponse(config, requestContext, {
					status: 502,
					duration_ms: Date.now() - startedAt,
					error_type: 'models_error',
					error_message: message,
				})
			}
			if (logRequests) {
				logRouterLine(`GET /v1/models status=502 error=${message}`, {
					config,
					context: requestContext,
					stage: 'models',
				})
			}
			return toErrorResponse(502, 'failed to load model list', message)
		}
	})

	app.post('/v1/messages', async (c) => {
		const startedAt = Date.now()
		const rawBody = await c.req.text()
		let parsedBody: unknown
		let parseError: string | null = null
		try {
			parsedBody = JSON.parse(rawBody || '{}')
		} catch (error) {
			parseError = error instanceof Error ? error.message : 'body parse failed'
			parsedBody = {}
		}

		const validated = requestSchema.safeParse(parsedBody)
		if (!validated.success || parseError) {
			const traceContext = buildRouterTraceContext({
				method: 'POST',
				path: '/v1/messages',
				headers: c.req.raw.headers,
			})
			await captureAnthropicRequest(config, {
				traceContext,
				rawBody,
				parseError: parseError ?? 'schema validation failed',
			})
			if (config.captureResponses) {
				await captureRouterResponse(config, traceContext, {
					status: 400,
					duration_ms: Date.now() - startedAt,
					error_type: parseError ? 'json_parse_error' : 'validation_error',
					error_message: parseError ? parseError : validated.success ? undefined : JSON.stringify(validated.error.format()),
				})
			}
			if (logRequests) {
				logRouterLine(`POST /v1/messages status=400 parse_error`, {
					config,
					context: traceContext,
					stage: 'messages-parse',
				})
			}
			return toErrorResponse(400, parseError ? 'invalid JSON body' : 'invalid request format')
		}

		const request = validated.data as unknown as AnthropicMessagesRequest
		const traceContext = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers: c.req.raw.headers,
			request,
		})

		await captureAnthropicRequest(config, {
			traceContext,
			rawBody,
			parsedRequest: request,
		})

		try {
			validateAnthropicRequestSemantics(request)
		} catch (error) {
			const status = error instanceof AnthropicRequestValidationError ? error.statusCode : 422
			const message = error instanceof Error ? error.message : 'invalid request body'
			if (config.captureResponses) {
				await captureRouterResponse(config, traceContext, {
					status,
					duration_ms: Date.now() - startedAt,
					error_type: 'validation_error',
					error_message: message,
				})
			}
			if (logRequests) {
				logRouterLine(`POST /v1/messages status=${status} validation_error`, {
					config,
					context: traceContext,
					stage: 'messages-validate',
				})
			}
			return toErrorResponse(status, message)
		}

		const requestContext = {
			sessionId: extractSessionId({ headers: traceContext.headers }) || null,
			routerRequestId: traceContext.router_request_id,
			userAgent: traceContext.headers.user_agent,
			abortSignal: c.req.raw.signal,
		}
		const stream = request.stream === true
		const directSkillInvocation = detectDirectSkillInvocation(request)
		const selectionContext = detectModelSelectionContext(request, directSkillInvocation)

		if (directSkillInvocation) {
			const toolInputSummary = summarizeToolInputForCapture({
				skill: directSkillInvocation.skill,
				...(directSkillInvocation.args ? { args: directSkillInvocation.args } : {}),
			})
			if (!stream) {
				const response = buildDirectSkillResponse(request, directSkillInvocation)
				await captureRouterResponse(config, traceContext, {
					status: 200,
					duration_ms: Date.now() - startedAt,
					stop_reason: response.stop_reason,
					codex_model: response.model,
					...pickUsageForCapture(response.usage),
					decision_kind: 'tool_use',
					tool_use_name: 'Skill',
					...toolInputSummary,
				})
				if (logRequests) {
					logRouterLine(
						`POST /v1/messages status=200 direct_skill_route skill=${directSkillInvocation.skill}`,
						{
							config,
							context: traceContext,
							stage: 'direct-skill',
						},
					)
				}
				return c.json(response, 200)
			}

			const streamResponse = createDirectSkillStream(request, directSkillInvocation, {
				onSessionReady: () => {
					void captureRouterStreamEvent(config, traceContext, {
						stream_phase: 'opened',
						duration_ms: Date.now() - startedAt,
						status: 200,
					})
					if (logRequests) {
						logRouterLine(
							`POST /v1/messages stream started direct_skill_route skill=${directSkillInvocation.skill}`,
							{
								config,
								context: traceContext,
								stage: 'direct-skill-stream',
							},
						)
					}
				},
				onComplete: () => {
					void captureRouterStreamEvent(config, traceContext, {
						stream_phase: 'completed',
						duration_ms: Date.now() - startedAt,
						status: 200,
						stream_end_reason: 'tool_use',
						codex_model: request.model,
						usage_input_tokens: 0,
						usage_output_tokens: 0,
						usage_cached_input_tokens: 0,
						usage_reasoning_output_tokens: 0,
						usage_total_tokens: 0,
						decision_kind: 'tool_use',
						tool_use_name: 'Skill',
						...toolInputSummary,
					})
				},
			})

			return new Response(streamResponse, {
				status: 200,
				headers: toStreamHeaders(),
			})
		}

		let selectedTarget: ReturnType<typeof resolveProviderTarget>
		let providerEntry: ReturnType<typeof getProviderRegistryEntry>
		let providerRequest: AnthropicMessagesRequest
		try {
			selectedTarget = resolveProviderTarget(config, {
				requestedModel: request.model,
				requestSource: selectionContext.requestSource,
				skillName: selectionContext.skillName,
				activeProviderId: config.activeProviderId,
			})
			providerEntry = getProviderRegistryEntry(providerRegistry, selectedTarget.providerId)
			providerRequest = applyProviderModelToRequest(request, selectedTarget.providerModel)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to resolve provider route'
			await captureRouterResponse(config, traceContext, {
				status: 502,
				duration_ms: Date.now() - startedAt,
				error_type: 'selector_error',
				error_message: message,
			})
			if (logRequests) {
				logRouterLine(`POST /v1/messages status=502 selector_error=${message}`, {
					config,
					context: traceContext,
					stage: 'messages-selector',
				})
			}
			return toErrorResponse(502, 'failed to resolve provider route', message)
		}

		if (!stream) {
			try {
				validateProviderNonStreamCompatibility(providerEntry, providerRequest)
			} catch (error) {
				const status = error instanceof AnthropicRequestValidationError ? error.statusCode : 422
				const message =
					error instanceof Error
						? error.message
						: 'request is incompatible with the selected provider'
				await captureRouterResponse(config, traceContext, {
					status,
					duration_ms: Date.now() - startedAt,
					error_type: 'provider_capability_error',
					error_message: message,
				})
				if (logRequests) {
					logRouterLine(
						`POST /v1/messages status=${status} provider_capability_error=${message}`,
						{
							config,
							context: traceContext,
							stage: 'messages-non-stream',
						},
					)
				}
				return toErrorResponse(status, message)
			}

			try {
				const canonicalRequest = anthropicRequestToCanonical(providerRequest, {
					source: selectionContext.requestSource,
					metadata: requestContext,
				})
				const result = await providerEntry.adapter.execute(config, canonicalRequest, requestContext)
				const response = overrideResponseModel(
					canonicalResponseToAnthropic(result),
					selectedTarget.exposedModel,
				)
				await captureRouterResponse(config, traceContext, {
					status: 200,
					duration_ms: Date.now() - startedAt,
					stop_reason: response.stop_reason,
					...pickUsageForCapture(response.usage),
					prompt_metrics: result.promptMetrics as CodexPromptMetrics | undefined,
					codex_model: response.model,
				})
				if (logRequests) {
					logRouterLine(`POST /v1/messages status=200 non-stream model=${response.model} provider=${providerEntry.id}`, {
						config,
						context: traceContext,
						stage: 'messages-non-stream',
					})
				}
				return c.json(response, 200)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'failed to execute message'
				const providerStatus =
					error instanceof OpenAiCompatibleProviderError || error instanceof CodexDirectProviderError
						? error.status
						: null
				const upstreamRequestId =
					error instanceof OpenAiCompatibleProviderError || error instanceof CodexDirectProviderError
						? error.requestId
						: null
				const upstreamErrorPreview =
					error instanceof OpenAiCompatibleProviderError || error instanceof CodexDirectProviderError
						? error.responseBodyPreview
						: null
				await captureRouterResponse(config, traceContext, {
					status: 502,
					duration_ms: Date.now() - startedAt,
					error_type: 'provider_error',
					error_message: message,
					provider_status: providerStatus,
					upstream_request_id: upstreamRequestId,
					upstream_error_preview: upstreamErrorPreview,
				})
				if (logRequests) {
					logRouterLine(`POST /v1/messages status=502 non-stream error=${message}`, {
						config,
						context: traceContext,
						stage: 'messages-non-stream',
					})
				}
				return toErrorResponse(502, 'failed to execute message', message)
			}
		}

		let onCompleteTriggered = false
		const canonicalRequest = anthropicRequestToCanonical(providerRequest, {
			source: selectionContext.requestSource,
			metadata: requestContext,
		})
		let canonicalStream: ReturnType<typeof providerEntry.adapter.stream>
		try {
			canonicalStream = providerEntry.adapter.stream(
				config,
				canonicalRequest,
				requestContext,
				{
				onSessionReady: (metadata) => {
					void captureRouterStreamEvent(
						config,
						traceContext,
						{
							stream_phase: 'opened',
							duration_ms: Date.now() - startedAt,
							status: 200,
							upstream_response_id: metadata.upstreamResponseId ?? null,
						},
					)
					if (logRequests) {
						logRouterLine(`POST /v1/messages stream started provider=${providerEntry.id}`, {
							config,
							context: traceContext,
							stage: 'messages-stream',
						})
					}
				},
				onComplete: (payload) => {
					if (onCompleteTriggered) {
						return
					}
					onCompleteTriggered = true
					const toolUseName =
						'decision' in payload && payload.decision?.kind === 'tool_use'
							? payload.decision.name
							: null
					const toolInputSummary =
						'decision' in payload && payload.decision?.kind === 'tool_use'
							? summarizeToolInputForCapture(payload.decision.input)
							: {
									tool_use_input_preview: null,
									tool_use_file_path: null,
									tool_use_path: null,
									tool_use_pattern: null,
								}
					void captureRouterStreamEvent(
						config,
						traceContext,
						{
							stream_phase: 'completed',
							duration_ms: Date.now() - startedAt,
							status: 200,
							upstream_response_id: payload.metadata?.upstreamResponseId ?? null,
							stream_end_reason: payload.stopReason,
							codex_model: payload.metadata?.model ?? null,
							...pickUsageForCapture(payload.usage),
							prompt_metrics: (payload as { promptMetrics?: CodexPromptMetrics }).promptMetrics,
							tool_use_name: toolUseName,
							...toolInputSummary,
							conversation_id: extractConversationId(payload.metadata),
						},
					)
				},
				onError: (payload) => {
					if (onCompleteTriggered) {
						return
					}
					onCompleteTriggered = true
					void captureRouterStreamEvent(
						config,
						traceContext,
						{
							stream_phase: 'failed',
							duration_ms: Date.now() - startedAt,
							status: 502,
							upstream_response_id: payload.metadata?.upstreamResponseId ?? null,
							stream_end_reason: null,
							error_message:
								payload.error instanceof Error ? payload.error.message : String(payload.error),
							codex_model: payload.metadata?.model ?? null,
						},
					)
				},
				onCancel: () => {
					void captureRouterStreamEvent(
						config,
						traceContext,
						{
							stream_phase: 'cancelled',
							duration_ms: Date.now() - startedAt,
							status: 499,
							stream_end_reason: 'client_cancelled',
						},
					)
				},
				},
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to start stream'
			await captureRouterResponse(config, traceContext, {
				status: 502,
				duration_ms: Date.now() - startedAt,
				error_type: 'provider_stream_setup_error',
				error_message: message,
			})
			if (logRequests) {
				logRouterLine(`POST /v1/messages status=502 stream_setup_error=${message}`, {
					config,
					context: traceContext,
					stage: 'messages-stream',
				})
			}
			return toErrorResponse(502, 'failed to start stream', message)
		}
		const clientStream = renderCanonicalStreamAsAnthropicSse(canonicalStream, {
			exposedModel: selectedTarget.exposedModel,
		})

		return new Response(clientStream, {
			status: 200,
			headers: toStreamHeaders(),
		})
	})

	return { app, config, hasCodexAuthFile }
}
