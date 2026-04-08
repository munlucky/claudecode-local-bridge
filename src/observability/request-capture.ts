import { buildAnonymousConversationSeed } from '../bridge/anthropic/index.js'
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { RouterConfig } from '../server/index.js'
import type { AnthropicMessagesRequest } from '../shared/index.js'
import type { RouterTraceContext } from './router-trace.js'
import { appendRuntimeLog } from './runtime-log.js'

type CapturedToolUsePreview = {
	role: 'user' | 'assistant' | 'system'
	id: string
	name: string
	input_keys: string[]
	input_preview: string
	file_path?: string | null
	path?: string | null
	pattern?: string | null
}

type CapturedAnthropicRequest = {
	timestamp: string
	router_request_id: string
	method: string
	path: string
	started_at: string
	header_names: string[]
	headers: RouterTraceContext['headers']
	model: string | null
	stream: boolean | null
	message_count: number | null
	tool_count: number
	tool_names: string[]
	tool_choice: unknown
	tools: unknown
	anonymous_conversation_seed: string | null
	recent_tool_uses: CapturedToolUsePreview[]
	last_user_message_preview: string | null
	last_user_message_is_slash_command: boolean
	last_user_message_slash_command: string | null
	body_parse_error?: string
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|authorization|password|secret|cookie)/i
const ABSOLUTE_PATH_PATTERN =
	/([A-Za-z]:\\[^"'`\s]+|\/(?:Users|home|tmp|var|opt|etc|mnt|srv)\/[^"'`\s]+)/g
const SAFE_TOKEN_METRIC_KEYS = new Set([
	'input_tokens',
	'output_tokens',
	'total_tokens',
	'cache_read_input_tokens',
	'reasoning_output_tokens',
	'usage_input_tokens',
	'usage_output_tokens',
	'usage_cached_input_tokens',
	'usage_reasoning_output_tokens',
	'usage_total_tokens',
	'prompt_tokens',
	'completion_tokens',
])

function shouldRedactKey(key: string) {
	return SECRET_KEY_PATTERN.test(key) && !SAFE_TOKEN_METRIC_KEYS.has(key)
}

function toWorkspaceRelativePath(value: string): string {
	const cwd = process.cwd()
	if (value === cwd) {
		return '.'
	}

	if (value.startsWith(`${cwd}/`)) {
		return relative(cwd, value) || '.'
	}

	return value
}

function normalizeToolInputValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return toWorkspaceRelativePath(value)
	}

	if (Array.isArray(value)) {
		return value.map((entry) => normalizeToolInputValue(entry))
	}

	if (!value || typeof value !== 'object') {
		return value
	}

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
			key,
			normalizeToolInputValue(entryValue),
		]),
	)
}

function summarizeJsonValue(value: unknown, limit = 240): string {
	let raw: string
	try {
		raw = typeof value === 'string' ? value : JSON.stringify(value)
	} catch {
		raw = String(value)
	}

	return raw.length > limit ? `${raw.slice(0, limit - 3)}...` : raw
}

function flattenMessageContentToText(content: AnthropicMessagesRequest['messages'][number]['content']): string {
	if (typeof content === 'string') {
		return content
	}

	if (!Array.isArray(content)) {
		return ''
	}

	return content
		.map((block) => {
			if (!block || typeof block !== 'object') {
				return ''
			}

			if (block.type === 'text' && typeof block.text === 'string') {
				return block.text
			}

			if (block.type === 'thinking' && typeof block.thinking === 'string') {
				return block.thinking
			}

			return ''
		})
		.filter(Boolean)
		.join('\n')
}

export function collectLastUserMessageSummary(request: AnthropicMessagesRequest | null): {
	last_user_message_preview: string | null
	last_user_message_is_slash_command: boolean
	last_user_message_slash_command: string | null
} {
	if (!request) {
		return {
			last_user_message_preview: null,
			last_user_message_is_slash_command: false,
			last_user_message_slash_command: null,
		}
	}

	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index]
		if (!message || message.role !== 'user') {
			continue
		}

		const text = flattenMessageContentToText(message.content).trim()
		if (!text) {
			continue
		}

		const preview = summarizeJsonValue(text, 240)
		const slashMatch = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)\b/.exec(text)
		return {
			last_user_message_preview: preview,
			last_user_message_is_slash_command: Boolean(slashMatch),
			last_user_message_slash_command: slashMatch?.[1] ?? null,
		}
	}

	return {
		last_user_message_preview: null,
		last_user_message_is_slash_command: false,
		last_user_message_slash_command: null,
	}
}

function collectRecentToolUses(
	request: AnthropicMessagesRequest | null,
	limit = 12,
): CapturedToolUsePreview[] {
	if (!request) {
		return []
	}

	const previews: CapturedToolUsePreview[] = []
	for (const message of request.messages) {
		const content = Array.isArray(message.content) ? message.content : []
		for (const block of content) {
			if (block.type !== 'tool_use') {
				continue
			}

			const normalizedInput =
				block.input && typeof block.input === 'object' && !Array.isArray(block.input)
					? (normalizeToolInputValue(block.input) as Record<string, unknown>)
					: {}
			previews.push({
				role: message.role,
				id: block.id,
				name: block.name,
				input_keys: Object.keys(normalizedInput).sort(),
				input_preview: summarizeJsonValue(normalizedInput),
				file_path:
					typeof normalizedInput.file_path === 'string' ? normalizedInput.file_path : null,
				path: typeof normalizedInput.path === 'string' ? normalizedInput.path : null,
				pattern: typeof normalizedInput.pattern === 'string' ? normalizedInput.pattern : null,
			})
		}
	}

	return previews.slice(-limit)
}

export function redactSensitiveValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value
			.replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_TOKEN]')
			.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED_TOKEN]')
			.replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]')
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveValue(item))
	}

	if (!value || typeof value !== 'object') {
		return value
	}

	const object = value as Record<string, unknown>
	return Object.fromEntries(
		Object.entries(object).map(([key, entryValue]) => [
			key,
			shouldRedactKey(key) ? '[REDACTED]' : redactSensitiveValue(entryValue),
		]),
	)
}

async function enforceCapturePolicy(path: string, maxFileBytes: number, retentionDays: number) {
	await mkdir(dirname(path), { recursive: true })
	const existing = await stat(path).catch(() => null)
	if (existing && maxFileBytes > 0 && existing.size >= maxFileBytes) {
		const rotatedPath = join(
			dirname(path),
			`${basename(path, '.jsonl')}.${Date.now()}.jsonl`,
		)
		await rename(path, rotatedPath).catch(() => undefined)
	}

	if (retentionDays <= 0) {
		return
	}

	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
	const directoryEntries = await readdir(dirname(path), { withFileTypes: true }).catch(() => [])
	for (const entry of directoryEntries) {
		if (!entry.isFile() || !entry.name.startsWith(basename(path, '.jsonl'))) {
			continue
		}

		const entryPath = join(dirname(path), entry.name)
		const entryStat = await stat(entryPath).catch(() => null)
		if (entryStat && entryStat.mtimeMs < cutoffMs) {
			await unlink(entryPath).catch(() => undefined)
		}
	}
}

function toCapturedRecord(
	context: RouterTraceContext,
	body: unknown,
	parseError?: string,
): CapturedAnthropicRequest {
	const payload =
		body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: {}

	const tools = Array.isArray(payload.tools) ? payload.tools : []
	const typedRequest =
		body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(payload.messages)
			? (body as AnthropicMessagesRequest)
			: null
	const toolNames = tools
		.map((tool) =>
			tool && typeof tool === 'object' && !Array.isArray(tool) && typeof tool.name === 'string'
				? tool.name
				: null,
		)
		.filter((name): name is string => Boolean(name))

	return {
		timestamp: new Date().toISOString(),
		router_request_id: context.router_request_id,
		method: context.method,
		path: context.path,
		started_at: context.started_at,
		header_names: context.header_names,
		headers: redactSensitiveValue(context.headers) as RouterTraceContext['headers'],
		model: context.model,
		stream: context.stream,
		message_count: context.message_count,
		tool_count: context.tool_count,
		tool_names: toolNames.length ? toolNames : context.tool_names,
		tool_choice: redactSensitiveValue(payload.tool_choice ?? null),
		tools: redactSensitiveValue(tools),
		anonymous_conversation_seed: typedRequest
			? buildAnonymousConversationSeed(typedRequest)
			: null,
		recent_tool_uses: collectRecentToolUses(typedRequest),
		...collectLastUserMessageSummary(typedRequest),
		...(parseError ? { body_parse_error: parseError } : {}),
	}
}

export async function captureAnthropicRequest(
	config: RouterConfig,
	input: {
		traceContext: RouterTraceContext
		rawBody: string
		parsedRequest?: AnthropicMessagesRequest
		parseError?: string
	},
) {
	if (!config.captureRequests) {
		return
	}

	let body: unknown = input.parsedRequest
	let parseError = input.parseError

	if (!body) {
		try {
			body = JSON.parse(input.rawBody) as unknown
		} catch (error) {
			parseError =
				parseError ?? (error instanceof Error ? error.message : 'JSON parse failed')
			body = {}
		}
	}

	const record = toCapturedRecord(input.traceContext, body, parseError)
	await enforceCapturePolicy(
		config.captureRequestsPath,
		config.captureMaxFileBytes,
		config.captureRetentionDays,
	)
	await appendFile(
		config.captureRequestsPath,
		`${JSON.stringify(redactSensitiveValue(record))}\n`,
		'utf8',
	)
	await appendRuntimeLog(config, {
		channel: '02-anthropic-requests',
		routerRequestId: record.router_request_id,
		payload: record as unknown as Record<string, unknown>,
	})

	if ((body as { tools?: unknown[] }).tools?.length) {
		process.stdout.write(
			`[router] ${new Date().toISOString()} captured request_id=${record.router_request_id} tools=${JSON.stringify(record.tool_names)} path=${config.captureRequestsPath}\n`,
		)
	}
}
