import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { checkCodexAuthDependency, getCodexBridgeRuntimeSnapshot } from '../bridge/codex/index.js'
import { createBackendProvider } from '../bridge/backend-provider.js'
import { AnthropicRequestValidationError, validateAnthropicRequestSemantics } from '../bridge/anthropic/index.js'
import {
	RouterTraceContext,
	buildRouterTraceContext,
	captureAnthropicRequest,
	captureRouterResponse,
	captureRouterStreamEvent,
	logRouterLine,
} from '../observability/index.js'
import { loadConfig } from './config.js'
import type { RouterConfig } from './config.js'
import type {
	AnthropicMessagesResponse,
	AnthropicMessagesRequest,
	AnthropicToolUseBlock,
	CodexPromptMetrics,
	RouterHealthResponse,
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

type UsageForCapture = Partial<{
	input_tokens: number
	output_tokens: number
	cache_read_input_tokens: number
	reasoning_output_tokens: number
	total_tokens: number
	inputTokens: number
	outputTokens: number
	cachedInputTokens: number
	reasoningOutputTokens: number
	totalTokens: number
}>

function toErrorResponse(status: number, message: string, rawMessage?: string) {
	return Response.json(
		{
			type: 'error',
			error: {
				type: 'invalid_request_error',
				message,
				raw_message: rawMessage ?? null,
			},
		},
		{ status },
	)
}

function formatRouterModelList(models: { id: string; display_name: string }[]) {
	return {
		data: models.map((entry) => ({
			type: 'model',
			id: entry.id,
			name: entry.display_name,
		})),
		object: 'list',
	}
}

function toStreamHeaders(): HeadersInit {
	return {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	}
}

type HeadersInit = Headers | [string, string][] | Record<string, string>

type DirectSkillInvocation = {
	skill: string
	args?: string
	rawCommand: string
}

function pickUsageForCapture(usage: UsageForCapture) {
	return {
		usage_input_tokens: usage?.input_tokens ?? usage?.inputTokens ?? null,
		usage_output_tokens: usage?.output_tokens ?? usage?.outputTokens ?? null,
		usage_cached_input_tokens:
			usage?.cache_read_input_tokens ?? usage?.cachedInputTokens ?? null,
		usage_reasoning_output_tokens:
			usage?.reasoning_output_tokens ?? usage?.reasoningOutputTokens ?? null,
		usage_total_tokens: usage?.total_tokens ?? usage?.totalTokens ?? null,
	}
}

function summarizeToolInputForCapture(input: unknown) {
	const normalized =
		input && typeof input === 'object' && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {}

	let preview: string
	try {
		preview = JSON.stringify(normalized)
	} catch {
		preview = String(normalized)
	}

	return {
		tool_use_input_preview: preview.length > 240 ? `${preview.slice(0, 237)}...` : preview,
		tool_use_file_path:
			typeof normalized.file_path === 'string' ? normalized.file_path : null,
		tool_use_path: typeof normalized.path === 'string' ? normalized.path : null,
		tool_use_pattern:
			typeof normalized.pattern === 'string' ? normalized.pattern : null,
	}
}

function extractTextFromContent(content: AnthropicMessagesRequest['messages'][number]['content']) {
	if (typeof content === 'string') {
		return content
	}

	if (!Array.isArray(content)) {
		return ''
	}

	return content
		.map((block) => {
			if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
				return block.text
			}
			return ''
		})
		.filter(Boolean)
		.join('\n')
}

function parseSlashCommand(text: string): DirectSkillInvocation | null {
	const commandLineMatches = Array.from(
		text.matchAll(/(?:^|\n)\s*\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?:\s+([^\n]+))?(?=$|\n)/g),
	)
	const commandLineMatch = commandLineMatches.at(-1)
	if (commandLineMatch) {
		const [, skill, args] = commandLineMatch
		if (skill) {
			const rawCommand = commandLineMatch[0].trim()
			return {
				skill,
				args: typeof args === 'string' && args.trim() ? args.trim() : undefined,
				rawCommand,
			}
		}
	}

	const tagMatches = Array.from(
		text.matchAll(/<command-name>\s*([A-Za-z0-9][A-Za-z0-9:_-]*)\s*<\/command-name>/g),
	)
	const tagMatch = tagMatches.at(-1)
	if (!tagMatch?.[1]) {
		return null
	}

	return {
		skill: tagMatch[1],
		rawCommand: `<command-name>${tagMatch[1]}</command-name>`,
	}
}

function contentContainsLoadedSkillBody(
	content: AnthropicMessagesRequest['messages'][number]['content'],
): boolean {
	const text = extractTextFromContent(content)
	if (!text) {
		return false
	}

	return text.includes('Base directory for this skill:')
}

function hasPriorSkillToolUse(request: AnthropicMessagesRequest): boolean {
	return request.messages.some((message) => {
		if (message.role !== 'assistant' || !Array.isArray(message.content)) {
			return false
		}

		return message.content.some(
			(block) =>
				block &&
				typeof block === 'object' &&
				block.type === 'tool_use' &&
				block.name === 'Skill',
		)
	})
}

function detectDirectSkillInvocation(request: AnthropicMessagesRequest): DirectSkillInvocation | null {
	if (!(request.tools ?? []).some((tool) => tool.name === 'Skill')) {
		return null
	}

	if (hasPriorSkillToolUse(request)) {
		return null
	}

	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index]
		if (!message) {
			continue
		}
		if (message.role !== 'user') {
			continue
		}

		if (contentContainsLoadedSkillBody(message.content)) {
			return null
		}

		const text = extractTextFromContent(message.content)
		if (!text.trim()) {
			continue
		}

		return parseSlashCommand(text)
	}

	return null
}

function buildDirectSkillToolUse(invocation: DirectSkillInvocation): AnthropicToolUseBlock {
	return {
		type: 'tool_use',
		id: `toolu_${crypto.randomUUID()}`,
		name: 'Skill',
		input: {
			skill: invocation.skill,
			...(invocation.args ? { args: invocation.args } : {}),
		},
	}
}

function buildDirectSkillResponse(
	request: AnthropicMessagesRequest,
	invocation: DirectSkillInvocation,
): AnthropicMessagesResponse {
	return {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		model: request.model,
		content: [buildDirectSkillToolUse(invocation)],
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
		},
	}
}

function formatSyntheticSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function createDirectSkillStream(
	request: AnthropicMessagesRequest,
	invocation: DirectSkillInvocation,
	logger?: {
		onSessionReady?: (metadata: { model: string; threadId?: string }) => void | Promise<void>
		onComplete?: (payload: {
			stopReason: 'tool_use'
			usage: {
				input_tokens: number
				output_tokens: number
				cache_read_input_tokens: number
				reasoning_output_tokens: number
				total_tokens: number
			}
			decision: {
				kind: 'tool_use'
				name: string
				input: Record<string, unknown>
				preamble: null
			}
			metadata: { model: string }
		}) => void | Promise<void>
	},
): ReadableStream<Uint8Array> {
	const response = buildDirectSkillResponse(request, invocation)
	const block = response.content[0] as AnthropicToolUseBlock
	const input = block.input as Record<string, unknown>

	return new ReadableStream<Uint8Array>({
		start(controller) {
			void logger?.onSessionReady?.({ model: request.model })

			controller.enqueue(
				formatSyntheticSse('message_start', {
					type: 'message_start',
					message: {
						id: response.id,
						type: 'message',
						role: 'assistant',
						model: response.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: response.usage,
					},
				}),
			)
			controller.enqueue(
				formatSyntheticSse('content_block_start', {
					type: 'content_block_start',
					index: 0,
					content_block: block,
				}),
			)
			controller.enqueue(
				formatSyntheticSse('content_block_delta', {
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'input_json_delta',
						partial_json: JSON.stringify(input),
					},
				}),
			)
			controller.enqueue(
				formatSyntheticSse('content_block_stop', {
					type: 'content_block_stop',
					index: 0,
				}),
			)
			controller.enqueue(
				formatSyntheticSse('message_delta', {
					type: 'message_delta',
					delta: {
						stop_reason: 'tool_use',
						stop_sequence: null,
					},
					usage: {
						output_tokens: 0,
					},
				}),
			)
			controller.enqueue(
				formatSyntheticSse('message_stop', {
					type: 'message_stop',
				}),
			)
			controller.close()

			void logger?.onComplete?.({
				stopReason: 'tool_use',
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					reasoning_output_tokens: 0,
					total_tokens: 0,
				},
				decision: {
					kind: 'tool_use',
					name: 'Skill',
					input,
					preamble: null,
				},
				metadata: {
					model: request.model,
				},
			})
		},
	})
}

function buildHealthPayload(
	config: RouterConfig,
	healthReady: boolean,
	hasAuthDependency: boolean,
	authDependencyMessage: string | null,
	codexSnapshot: ReturnType<typeof getCodexBridgeRuntimeSnapshot>,
): RouterHealthResponse {
	if (config.bridgeBackend === 'codex') {
		return {
			status: 'ok',
			backend: 'codex_app_server',
			auth_mode: config.codexAuthMode,
			has_auth_mode_dependency: hasAuthDependency,
			live: true,
			readiness: healthReady ? 'ready' : 'degraded',
			codex_command: config.codexCommand,
			codex_runtime_cwd: config.codexRuntimeCwd,
			codex_auth_file: config.codexAuthFile,
			has_local_auth_file: existsSync(config.codexAuthFile),
			queue_depth: codexSnapshot.queueDepth,
			active_session_count: codexSnapshot.activeSessionCount,
			pending_session_creates: codexSnapshot.pendingSessionCreates,
			recent_retryable_failures: codexSnapshot.recentRetryableFailures,
			recent_non_retryable_failures: codexSnapshot.recentNonRetryableFailures,
			recent_retries: codexSnapshot.recentRetries,
			codex_model: config.modelAliases?.['claude-sonnet-4-5-20250929'],
			auth_message: authDependencyMessage,
		}
	}

	return {
		status: 'ok',
		backend: 'ollama_api',
		live: true,
		readiness: healthReady ? 'ready' : 'degraded',
		ollama_base_url: config.ollamaBaseUrl,
		ollama_model: config.ollamaModel,
		has_ollama_api_key: Boolean(config.ollamaApiKey),
		auth_message: authDependencyMessage,
	}
}

function extractSessionId(context: { headers: RouterTraceContext['headers'] }) {
	return context.headers.resolved_session_id
}

function extractConversationId(metadata: unknown) {
	if (!metadata || typeof metadata !== 'object') {
		return null
	}

	const typed = metadata as { threadId?: unknown }
	return typeof typed.threadId === 'string' ? typed.threadId : null
}

export function createApp(): AppFactoryResult {
	const config = loadConfig()
	const hasCodexAuthFile = config.codexAuthMode === 'local_auth_json' ? existsSync(config.codexAuthFile) : false
	const app = new Hono()
	const provider = createBackendProvider(config)
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
			try {
				hasAuthDependency = await checkCodexAuthDependency(config)
				codexSnapshot = getCodexBridgeRuntimeSnapshot()
			} catch (error) {
				healthReady = false
				authMessage = error instanceof Error ? error.message : 'health check failed'
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
			const models = await provider.listModels(config, c.req.raw.signal)
			const responsePayload = formatRouterModelList(models)
			if (config.captureResponses) {
				await captureRouterResponse(config, requestContext, {
					status: 200,
					duration_ms: Date.now() - startedAt,
				})
			}
			if (logRequests) {
				logRouterLine(`GET /v1/models status=200 provider=${config.bridgeBackend}`, {
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

		if (!stream) {
			try {
				const result = await provider.executeNonStream(config, request, requestContext)
				await captureRouterResponse(config, traceContext, {
					status: 200,
					duration_ms: Date.now() - startedAt,
					stop_reason: result.response.stop_reason,
					...pickUsageForCapture(result.response.usage),
					prompt_metrics: result.promptMetrics,
					codex_model: result.response.model,
				})
				if (logRequests) {
					logRouterLine(`POST /v1/messages status=200 non-stream model=${result.response.model}`, {
						config,
						context: traceContext,
						stage: 'messages-non-stream',
					})
				}
				return c.json(result.response, 200)
			} catch (error) {
				const message = error instanceof Error ? error.message : 'failed to execute message'
				await captureRouterResponse(config, traceContext, {
					status: 502,
					duration_ms: Date.now() - startedAt,
					error_type: 'provider_error',
					error_message: message,
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
		const streamResponse = provider.createStream(
			config,
			request,
			requestContext,
			{
				onSessionReady: () => {
					void captureRouterStreamEvent(
						config,
						traceContext,
						{
							stream_phase: 'opened',
							duration_ms: Date.now() - startedAt,
							status: 200,
						},
					)
					if (logRequests) {
						logRouterLine(`POST /v1/messages stream started provider=${config.bridgeBackend}`, {
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

		return new Response(streamResponse, {
			status: 200,
			headers: toStreamHeaders(),
		})
	})

	return { app, config, hasCodexAuthFile }
}
