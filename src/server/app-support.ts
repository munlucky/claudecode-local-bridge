import { existsSync } from 'node:fs'
import { formatAnthropicSse } from '../bridge/anthropic/surface.js'
import { AnthropicRequestValidationError } from '../bridge/anthropic/index.js'
import { getCodexDirectAuthHealth } from '../bridge/provider/codex-direct-auth.js'
import { getProviderRegistryEntry } from '../bridge/provider/registry.js'
import type { ProviderRegistryEntry } from '../bridge/provider/registry.js'
import { logRouterLine } from '../observability/index.js'
import type { RouterTraceContext } from '../observability/index.js'
import type { RouterConfig } from './config.js'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicToolUseBlock,
	RouterHealthResponse,
} from '../shared/index.js'

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

type HeadersInit = Headers | [string, string][] | Record<string, string>

type DirectSkillInvocation = {
	skill: string
	args?: string
	rawCommand: string
}

export function toErrorResponse(status: number, message: string, rawMessage?: string) {
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

export function formatRouterModelList(models: Array<{ exposedModel: string; displayName: string }>) {
	return {
		data: models.map((entry) => ({
			type: 'model',
			id: entry.exposedModel,
			name: entry.displayName,
		})),
		object: 'list',
	}
}

export async function listVisibleModels(
	config: RouterConfig,
	providerRegistry: Map<ProviderRegistryEntry['id'], ProviderRegistryEntry>,
	activeProviderId: ProviderRegistryEntry['id'],
	abortSignal?: AbortSignal | null,
) {
	const activeProvider = getProviderRegistryEntry(providerRegistry, activeProviderId)
	const optionalProviders = Array.from(providerRegistry.values()).filter(
		(entry) => entry.id !== activeProviderId && entry.enabled && entry.capabilities.modelListing,
	)

	const visibleModels = new Map<string, { exposedModel: string; displayName: string }>()
	const activeModels = await activeProvider.adapter.listModels(config, abortSignal)
	for (const model of activeModels) {
		visibleModels.set(model.exposedModel, {
			exposedModel: model.exposedModel,
			displayName: model.displayName,
		})
	}

	for (const provider of optionalProviders) {
		try {
			const models = await provider.adapter.listModels(config, abortSignal)
			for (const model of models) {
				if (!visibleModels.has(model.exposedModel)) {
					visibleModels.set(model.exposedModel, {
						exposedModel: model.exposedModel,
						displayName: model.displayName,
					})
				}
			}
		} catch (error) {
			if (config.logRequests) {
				logRouterLine(
					`GET /v1/models optional_provider_error provider=${provider.id} error=${
						error instanceof Error ? error.message : String(error)
					}`,
					{ config, stage: 'models' },
				)
			}
		}
	}

	return Array.from(visibleModels.values())
}

export function toStreamHeaders(): HeadersInit {
	return {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	}
}

export function pickUsageForCapture(usage: UsageForCapture) {
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

export function summarizeToolInputForCapture(input: unknown) {
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

export function detectDirectSkillInvocation(
	request: AnthropicMessagesRequest,
): DirectSkillInvocation | null {
	if (!(request.tools ?? []).some((tool) => tool.name === 'Skill')) {
		return null
	}

	if (hasPriorSkillToolUse(request)) {
		return null
	}

	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index]
		if (!message || message.role !== 'user') {
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

function extractActiveSkillName(request: AnthropicMessagesRequest): string | null {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index]
		if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
			continue
		}

		for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
			const block = message.content[blockIndex]
			if (
				!block ||
				typeof block !== 'object' ||
				block.type !== 'tool_use' ||
				block.name !== 'Skill' ||
				!block.input ||
				typeof block.input !== 'object' ||
				Array.isArray(block.input)
			) {
				continue
			}

			const skill = (block.input as Record<string, unknown>).skill
			if (typeof skill === 'string' && skill.trim()) {
				return skill.trim()
			}
		}
	}

	return null
}

export function detectModelSelectionContext(
	request: AnthropicMessagesRequest,
	directSkillInvocation: DirectSkillInvocation | null,
) {
	if (directSkillInvocation) {
		return {
			requestSource: 'direct-skill' as const,
			skillName: directSkillInvocation.skill,
		}
	}

	if (request.model.trim().startsWith('skill:')) {
		return {
			requestSource: 'direct-skill' as const,
			skillName: request.model.trim().slice('skill:'.length).trim() || null,
		}
	}

	const priorSkill = extractActiveSkillName(request)
	if (priorSkill) {
		return {
			requestSource: 'tool-loop' as const,
			skillName: priorSkill,
		}
	}

	return {
		requestSource: 'anthropic-route' as const,
		skillName: null,
	}
}

export function applyProviderModelToRequest(
	request: AnthropicMessagesRequest,
	providerModel: string,
): AnthropicMessagesRequest {
	if (request.model === providerModel) {
		return request
	}

	return {
		...request,
		model: providerModel,
	}
}

export function overrideResponseModel(
	response: AnthropicMessagesResponse,
	exposedModel: string,
): AnthropicMessagesResponse {
	if (response.model === exposedModel) {
		return response
	}

	return {
		...response,
		model: exposedModel,
	}
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

function contentContainsImage(
	content: AnthropicMessagesRequest['messages'][number]['content'] | AnthropicMessagesRequest['system'],
): boolean {
	if (!Array.isArray(content)) {
		return false
	}

	return content.some(
		(block) => block && typeof block === 'object' && block.type === 'image',
	)
}

function requestContainsImageBlocks(request: AnthropicMessagesRequest): boolean {
	if (contentContainsImage(request.system)) {
		return true
	}

	return request.messages.some((message) => contentContainsImage(message.content))
}

function isThinkingEnabled(thinking: AnthropicMessagesRequest['thinking']): boolean {
	if (!thinking) {
		return false
	}

	return thinking.type !== 'disabled'
}

export function validateProviderNonStreamCompatibility(
	providerEntry: ProviderRegistryEntry,
	request: AnthropicMessagesRequest,
) {
	if (providerEntry.capabilities.thinking === false && isThinkingEnabled(request.thinking)) {
		throw new AnthropicRequestValidationError(
			`provider '${providerEntry.id}' does not support Anthropic thinking on non-stream /v1/messages yet`,
			422,
		)
	}

	if (providerEntry.capabilities.inputImages === false && requestContainsImageBlocks(request)) {
		throw new AnthropicRequestValidationError(
			`provider '${providerEntry.id}' does not support image content on non-stream /v1/messages yet`,
			422,
		)
	}
}

export function buildDirectSkillResponse(
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

export function createDirectSkillStream(
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
				formatAnthropicSse('message_start', {
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
				formatAnthropicSse('content_block_start', {
					type: 'content_block_start',
					index: 0,
					content_block: block,
				}),
			)
			controller.enqueue(
				formatAnthropicSse('content_block_delta', {
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'input_json_delta',
						partial_json: JSON.stringify(input),
					},
				}),
			)
			controller.enqueue(
				formatAnthropicSse('content_block_stop', {
					type: 'content_block_stop',
					index: 0,
				}),
			)
			controller.enqueue(
				formatAnthropicSse('message_delta', {
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
				formatAnthropicSse('message_stop', {
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

export function buildHealthPayload(
	config: RouterConfig,
	healthReady: boolean,
	hasAuthDependency: boolean,
	authDependencyMessage: string | null,
	codexSnapshot: {
		activeSessionCount: number
		pendingSessionCreates: number
		queueDepth: number
		recentRetryableFailures: number
		recentNonRetryableFailures: number
		recentRetries: number
	},
): RouterHealthResponse {
	if (config.activeProviderId === 'codex-direct') {
		const directAuth = getCodexDirectAuthHealth(config)
		return {
			status: 'ok',
			backend: 'codex_direct_api',
			auth_mode: config.codexDirectAuthMode,
			has_auth_mode_dependency: directAuth.hasAuthDependency,
			live: true,
			readiness: directAuth.ready && healthReady ? 'ready' : 'degraded',
			codex_direct_auth_state_file: config.codexDirectAuthStateFile,
			has_codex_direct_auth_state: directAuth.hasStoredState,
			codex_direct_auth_state: directAuth.state,
			codex_direct_base_url: config.codexDirectBaseUrl,
			codex_direct_rollout: config.codexDirectRollout,
			codex_model: config.providerRouting.providerDefaults['codex-direct'] ?? null,
			auth_message: authDependencyMessage ?? directAuth.message,
		}
	}

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

export function extractSessionId(context: { headers: RouterTraceContext['headers'] }) {
	return context.headers.resolved_session_id
}

export function extractConversationId(metadata: unknown) {
	if (!metadata || typeof metadata !== 'object') {
		return null
	}

	const typed = metadata as { threadId?: unknown }
	return typeof typed.threadId === 'string' ? typed.threadId : null
}
