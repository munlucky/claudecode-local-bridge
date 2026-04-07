import { createHash } from 'node:crypto'
import type {
	AnthropicInputContentBlock,
	AnthropicMessage,
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
	AnthropicResponseContentBlock,
	CodexBridgeDecision,
	CodexPromptMetrics,
	CodexTurnResult,
	JsonObject,
} from '../../shared/index.js'
import type { RouterConfig } from '../../server/index.js'

export class AnthropicRequestValidationError extends Error {
	readonly statusCode: number

	constructor(message: string, statusCode = 422) {
		super(message)
		this.name = 'AnthropicRequestValidationError'
		this.statusCode = statusCode
	}
}

type ToolMappingRule = {
	match: (name: string) => boolean
	describe: (toolName: string) => string
}

export type ToolExecutionHint = {
	id: string
	name: string
	inputSummary: string
	resultSummary: string | null
	status: 'resolved' | 'pending'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const TOOL_MAPPING_RULES: ToolMappingRule[] = [
	{
		match: (name) =>
			name === 'read_file' ||
			name === 'read' ||
			name === 'open_file' ||
			name === 'view' ||
			name === 'cat',
		describe: (toolName) =>
			`'${toolName}' 는 파일 읽기 계열 도구다. 실제 실행은 Claude Code가 담당하므로, Codex는 이 도구가 필요할 때 정확한 입력만 포함한 tool_use 결정을 반환해야 한다.`,
	},
	{
		match: (name) =>
			name === 'glob' ||
			name === 'find_file' ||
			name === 'find_files' ||
			name === 'list_files',
		describe: (toolName) =>
			`'${toolName}' 는 파일 탐색 계열 도구다. Codex는 직접 실행하지 말고, 필요한 패턴과 경로를 담은 tool_use 결정을 반환해야 한다.`,
	},
	{
		match: (name) =>
			name === 'grep' ||
			name === 'search' ||
			name === 'search_code' ||
			name === 'ripgrep',
		describe: (toolName) =>
			`'${toolName}' 는 텍스트 검색 계열 도구다. Codex는 직접 실행하지 말고, 필요한 pattern/path 인자를 가진 tool_use 결정을 반환해야 한다.`,
	},
	{
		match: (name) =>
			name === 'list_dir' ||
			name === 'ls' ||
			name === 'dir' ||
			name === 'tree',
		describe: (toolName) =>
			`'${toolName}' 는 디렉터리 탐색 계열 도구다. 실제 실행은 Claude Code가 담당하므로, Codex는 tool_use 입력만 정확히 지정해야 한다.`,
	},
	{
		match: (name) =>
			name === 'write_file' ||
			name === 'write' ||
			name === 'edit' ||
			name === 'multi_edit' ||
			name === 'apply_patch',
		describe: (toolName) =>
			`'${toolName}' 는 편집/패치 계열 도구다. Codex는 직접 파일을 수정하지 말고, 필요한 편집 입력을 담은 tool_use 결정을 반환해야 한다.`,
	},
	{
		match: (name) =>
			name === 'bash' ||
			name === 'run_command' ||
			name === 'exec' ||
			name === 'shell',
		describe: (toolName) =>
			`'${toolName}' 는 쉘 실행 계열 도구다. Codex는 직접 명령을 실행하지 말고, 필요한 command 인자를 가진 tool_use 결정을 반환해야 한다.`,
	},
	{
		match: (name) => name === 'agent',
		describe: (toolName) =>
			`'${toolName}' 는 Claude 전용 하위 에이전트 진입점이다. 브리지 뒤에서는 실제 실행을 시도하지 말고, 필요할 때만 해당 이름의 tool_use 결정을 반환한다.`,
	},
	{
		match: (name) => name === 'skill',
		describe: (toolName) =>
			`'${toolName}' 는 Claude 스킬 호출 표면이다. 사용자가 명시적으로 스킬 경로나 슬래시 명령을 준 경우에는 그 지시를 문맥으로 해석하되, 실행은 Claude Code가 담당하도록 tool_use 결정만 반환한다.`,
	},
	{
		match: (name) => name === 'toolsearch',
		describe: (toolName) =>
			`'${toolName}' 는 지연 로드 도구 검색 표면이다. 브리지 뒤에서는 Codex가 직접 해결하지 말고, 필요 시 tool_use 결정을 통해 Claude Code 쪽 실행을 요청한다.`,
	},
]

function toolLoopEnabled(request: AnthropicMessagesRequest): boolean {
	return Boolean(request.tools?.length)
}

function buildToolLoopResponseContract(request: AnthropicMessagesRequest): string[] {
	if (!toolLoopEnabled(request)) {
		return []
	}

	const toolNames = (request.tools ?? []).map((tool) => tool.name)

	return [
		'External tool loop contract:',
		'- Do not execute tools directly inside Codex.',
		'- If a tool is needed, return exactly one JSON object and no surrounding prose: {"kind":"tool_use","name":"<tool name>","input":{...},"preamble":"optional short note"}',
		'- If no tool is needed, return exactly one JSON object and no surrounding prose: {"kind":"assistant","text":"final answer"}',
		'- Use at most one tool per turn.',
		`- Valid tool names for this turn: ${toolNames.join(', ')}`,
		'- Reuse prior tool_result blocks when they already contain the needed data.',
	]
}

function toContentBlocks(content: AnthropicMessage['content'] | AnthropicMessagesRequest['system']) {
	if (typeof content === 'string') {
		return [{ type: 'text', text: content }] satisfies AnthropicInputContentBlock[]
	}

	return (content ?? []) as AnthropicInputContentBlock[]
}

function estimateTokensFromText(text: string): number {
	if (!text) {
		return 0
	}

	return Math.max(1, Math.ceil(text.length / 4))
}

function flattenTextBlocks(blocks: AnthropicInputContentBlock[]): string {
	return blocks
		.filter(
			(block): block is Extract<AnthropicInputContentBlock, { type: 'text' }> =>
				block.type === 'text',
		)
		.map((block) => block.text)
		.join('\n\n')
}

function summarizeJsonValue(value: unknown, limit = 280): string {
	const raw =
		typeof value === 'string'
			? value
			: (() => {
					try {
						return JSON.stringify(value)
					} catch {
						return String(value)
					}
				})()

	return raw.length > limit ? `${raw.slice(0, limit - 3)}...` : raw
}

function normalizeInputSchemaToStrictObject(
	toolName: string,
	inputSchema: AnthropicMessagesRequest['tools'][number]['input_schema'],
): void {
	if (!isPlainObject(inputSchema)) {
		throw new AnthropicRequestValidationError(
			`tool '${toolName}' input_schema 는 object 여야 합니다.`,
			400,
		)
	}

	if (inputSchema.type !== 'object') {
		throw new AnthropicRequestValidationError(
			`tool '${toolName}' input_schema.type 은 'object' 여야 합니다.`,
			400,
		)
	}

	if (inputSchema.additionalProperties !== false) {
		inputSchema.additionalProperties = false
	}
}

function normalizeConversationSeedSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/routerreq_[a-f0-9-]+/g, 'routerreq')
		.replace(/toolu_[a-z0-9_-]+/g, 'toolu')
		.replace(/msg_[a-z0-9_-]+/g, 'msg')
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g, 'uuid')
		.replace(/\s+/g, ' ')
		.trim()
}

function collectContentSeedSegments(
	content: AnthropicMessage['content'] | AnthropicMessagesRequest['system'] | undefined,
): string[] {
	const segments: string[] = []

	if (!content) {
		return segments
	}

	if (typeof content === 'string') {
		const normalized = normalizeConversationSeedSegment(content)
		return normalized ? [normalized] : []
	}

	for (const block of content) {
		if (block.type === 'text') {
			const normalized = normalizeConversationSeedSegment(block.text)
			if (normalized) {
				segments.push(normalized)
			}
			continue
		}

		if (block.type === 'tool_use') {
			const normalizedName = normalizeConversationSeedSegment(block.name)
			const normalizedInput = normalizeConversationSeedSegment(summarizeJsonValue(block.input, 512))
			if (normalizedName) {
				segments.push(normalizedName)
			}
			if (normalizedInput) {
				segments.push(normalizedInput)
			}
			continue
		}

		if (block.type === 'tool_result') {
			const normalized = normalizeConversationSeedSegment(
				typeof block.content === 'string'
					? block.content
					: summarizeJsonValue(block.content, 512),
			)
			if (normalized) {
				segments.push(normalized)
			}
		}
	}

	return segments
}

export function buildAnonymousConversationSeed(
	request: AnthropicMessagesRequest,
): string | null {
	const firstUserMessage = request.messages.find((message) => message.role === 'user')
	const systemSegments = collectContentSeedSegments(request.system).slice(0, 2)
	const firstUserSegments = firstUserMessage
		? collectContentSeedSegments(firstUserMessage.content).slice(0, 4)
		: []
	const segments = [...systemSegments, ...firstUserSegments]
	const toolNames = (request.tools ?? []).map((tool) => tool.name.toLowerCase())
	const payload = JSON.stringify({
		system: systemSegments,
		first_user: firstUserSegments,
		tool_names: toolNames,
		first_user_has_tools: Boolean(
			firstUserMessage &&
				Array.isArray(firstUserMessage.content) &&
				firstUserMessage.content.some(
					(block) => block.type === 'tool_use' || block.type === 'tool_result',
				),
		),
	})

	if (!segments.length && !toolNames.length) {
		return null
	}

	return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

export function buildStableBridgeSessionId(
	userAgent: string | null,
	workspaceRoot: string,
	conversationSeed: string | null,
): string | null {
	if (!userAgent || !conversationSeed) {
		return null
	}

	return `bridge-session-${createHash('sha1')
		.update(userAgent.toLowerCase())
		.update('\n')
		.update(workspaceRoot)
		.update('\n')
		.update(conversationSeed)
		.digest('hex')
		.slice(0, 24)}`
}

function summarizeToolSurface(request: AnthropicMessagesRequest): string[] {
	return [...new Set((request.tools ?? []).map((tool) => tool.name.trim().toLowerCase()))].sort()
}

export function buildThreadInvariantInput(request: AnthropicMessagesRequest): string {
	return JSON.stringify({
		system: request.system ?? null,
		tool_names: summarizeToolSurface(request),
		toolLoop: Boolean(request.tools?.length),
	})
}

function serializeBlocks(blocks: AnthropicInputContentBlock[]): string {
	const lines: string[] = []

	for (const block of blocks) {
		switch (block.type) {
			case 'text':
				if (block.text.trim()) {
					lines.push(block.text)
				}
				break
			case 'thinking':
				if (block.thinking.trim()) {
					lines.push(`[thinking]\n${block.thinking}`)
				}
				break
			case 'tool_use':
				lines.push(
					`Tool request ${block.name} (${block.id}): ${JSON.stringify(block.input ?? {})}`,
				)
				break
			case 'tool_result':
				lines.push(
					`Tool result for ${block.tool_use_id}: ${
						typeof block.content === 'string'
							? block.content
							: JSON.stringify(block.content)
					}`,
				)
				break
			case 'image':
				lines.push(
					`[image media_type=${block.source.media_type} bytes=${block.source.data.length}]`,
				)
				break
		}
	}

	return lines.join('\n')
}

export function resolveModelAlias(config: RouterConfig, canonicalModel: string): string {
	const direct = config.modelAliases[canonicalModel]
	if (direct) {
		return direct
	}

	if (canonicalModel.startsWith('claude-opus')) {
		return config.modelAliases['claude-opus-4-1-20250805'] ?? 'gpt-5.4'
	}

	if (canonicalModel.startsWith('claude-sonnet')) {
		return config.modelAliases['claude-sonnet-4-5-20250929'] ?? 'gpt-5.4'
	}

	if (canonicalModel.startsWith('claude-haiku')) {
		return config.modelAliases['claude-haiku-4-5-20251001'] ?? 'gpt-5.4-mini'
	}

	return canonicalModel
}

function formatToolDefinitions(request: AnthropicMessagesRequest): string {
	if (!request.tools?.length) {
		return '없음'
	}

	return request.tools
		.map((tool) =>
			JSON.stringify(
				{
					name: tool.name,
					description: tool.description ?? '',
					input_schema: tool.input_schema,
				},
				null,
				2,
			),
		)
		.join('\n\n')
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase()
}

export function buildToolMappingGuidance(request: AnthropicMessagesRequest): string[] {
	const seen = new Set<string>()
	const guidance: string[] = []

	for (const tool of request.tools ?? []) {
		const normalizedName = normalizeToolName(tool.name)
		if (seen.has(normalizedName)) {
			continue
		}
		seen.add(normalizedName)

		const rule = TOOL_MAPPING_RULES.find((candidate) => candidate.match(normalizedName))
		if (rule) {
			guidance.push(rule.describe(tool.name))
		}
	}

	return guidance
}

export function extractToolExecutionHints(
	request: AnthropicMessagesRequest,
): ToolExecutionHint[] {
	const pendingById = new Map<string, ToolExecutionHint>()
	const ordered: ToolExecutionHint[] = []

	for (const message of request.messages) {
		const blocks = toContentBlocks(message.content)
		for (const block of blocks) {
			if (block.type === 'tool_use') {
				const hint: ToolExecutionHint = {
					id: block.id,
					name: block.name,
					inputSummary: summarizeJsonValue(block.input),
					resultSummary: null,
					status: 'pending',
				}
				pendingById.set(block.id, hint)
				ordered.push(hint)
				continue
			}

			if (block.type === 'tool_result') {
				const matched = pendingById.get(block.tool_use_id)
				if (!matched) {
					continue
				}

				matched.status = 'resolved'
				matched.resultSummary =
					typeof block.content === 'string'
						? summarizeJsonValue(block.content)
						: summarizeJsonValue(block.content)
			}
		}
	}

	return ordered
}

export function buildCodexDeveloperInstructions(
	request: AnthropicMessagesRequest,
): string {
	const lines = [
		'You are an Anthropic-compatible backend bridged through Codex local auth.',
		'Behave like a coding agent when the caller asks for code, file inspection, repository analysis, planning, or implementation.',
		toolLoopEnabled(request)
			? 'When Anthropic tools are available, do not execute tools directly. Return a structured tool_use decision so the caller can run the tool.'
			: 'Use Codex built-in tools when needed to inspect files, search the workspace, run safe commands, edit code, and verify results.',
		'Match the caller intent precisely: answer directly for read-only questions, and make file changes only when the caller is asking for implementation work.',
		'Do not mention bridge internals unless the caller explicitly asks about them.',
	]

	const systemText = flattenTextBlocks(toContentBlocks(request.system))
	if (systemText) {
		lines.push('', 'Caller system instructions:', systemText)
	}

	const toolGuidance = buildToolMappingGuidance(request)
	if (toolGuidance.length) {
		lines.push('', 'Tool equivalence guidance:')
		for (const guidance of toolGuidance) {
			lines.push(`- ${guidance}`)
		}
	}

	const toolLoopContract = buildToolLoopResponseContract(request)
	if (toolLoopContract.length) {
		lines.push('', ...toolLoopContract)
	}

	const executionHints = extractToolExecutionHints(request)
	if (executionHints.length) {
		lines.push('', 'Tool execution handoff:')
		for (const hint of executionHints) {
			if (hint.status === 'resolved') {
				lines.push(
					`- Resolved tool call '${hint.name}' id=${hint.id} input=${hint.inputSummary} result=${hint.resultSummary ?? '[empty]'}. Reuse this result unless the caller explicitly asks to rerun or verify it.`,
				)
			} else {
				lines.push(
					`- Pending tool intent '${hint.name}' id=${hint.id} input=${hint.inputSummary}. Continue with the Codex-equivalent action if that work is still needed.`,
				)
			}
		}
	}

	lines.push(
		'If prior transcript already contains tool_result blocks, treat them as authoritative outputs from earlier tool executions unless the user asks to rerun or verify them.',
	)

	return lines.join('\n')
}

function serializeAnthropicMessages(
	messages: AnthropicMessage[],
): string[] {
	const lines: string[] = []

	for (const message of messages) {
		const blocks = toContentBlocks(message.content)
		lines.push(`## ${message.role}`)
		lines.push(serializeBlocks(blocks) || '[empty]')
		lines.push('')
	}

	return lines
}

export function serializeAnthropicRequestToCodexPrompt(
	request: AnthropicMessagesRequest,
	options?: {
		mode?: 'full' | 'delta'
		replayFromMessageIndex?: number
	},
): string {
	const promptMode = options?.mode ?? 'full'
	const replayFromMessageIndex = Math.max(0, options?.replayFromMessageIndex ?? 0)
	const replayMessages =
		promptMode === 'delta' ? request.messages.slice(replayFromMessageIndex) : request.messages
	const lines = [
		promptMode === 'delta'
			? 'Anthropic-compatible transcript delta follows.'
			: 'Anthropic-compatible transcript follows.',
		'Respond as the assistant for the final turn.',
		toolLoopEnabled(request)
			? 'Do not execute caller tools directly. Choose the next tool request or final answer and return it as strict JSON.'
			: 'You may use Codex built-in tools to inspect referenced files, analyze repositories, and perform requested coding work.',
		'If the transcript references absolute file paths or directories, treat them as authoritative targets to inspect.',
		`Requested max_tokens: ${request.max_tokens}`,
		`Requested tool_choice: ${
			request.tool_choice ? JSON.stringify(request.tool_choice) : 'auto'
		}`,
		'',
		'Tools:',
		formatToolDefinitions(request),
		'',
		promptMode === 'delta'
			? `Conversation delta (messages ${replayFromMessageIndex + 1}-${request.messages.length}):`
			: 'Conversation:',
	]

	lines.push(...serializeAnthropicMessages(replayMessages))

	const toolGuidance = buildToolMappingGuidance(request)
	if (toolGuidance.length) {
		lines.push('Tool mapping hints:')
		for (const guidance of toolGuidance) {
			lines.push(`- ${guidance}`)
		}
		lines.push('')
	}

	const toolLoopContract = buildToolLoopResponseContract(request)
	if (toolLoopContract.length) {
		lines.push(...toolLoopContract)
		lines.push('')
	}

	const executionHints = extractToolExecutionHints(request)
	if (executionHints.length) {
		lines.push('Tool execution handoff:')
		for (const hint of executionHints) {
			if (hint.status === 'resolved') {
				lines.push(
					`- resolved ${hint.name} (${hint.id}) input=${hint.inputSummary} result=${hint.resultSummary ?? '[empty]'}; reuse instead of rerunning unless verification is requested.`,
				)
			} else {
				lines.push(
					`- pending ${hint.name} (${hint.id}) input=${hint.inputSummary}; perform the equivalent Codex action if the task still depends on it.`,
				)
			}
		}
		lines.push('')
	}

	return lines.join('\n')
}

export function buildCodexPromptMetrics(
	request: AnthropicMessagesRequest,
	developerInstructions: string,
	promptText: string,
	options?: {
		promptMode?: 'full' | 'delta'
		replayFromMessageIndex?: number
	},
): CodexPromptMetrics {
	const promptMode = options?.promptMode ?? 'full'
	const replayFromMessageIndex = Math.max(0, options?.replayFromMessageIndex ?? 0)
	const replayMessages =
		promptMode === 'delta' ? request.messages.slice(replayFromMessageIndex) : request.messages
	const userMessages = request.messages.filter((message) => message.role === 'user')
	const systemText = flattenTextBlocks(toContentBlocks(request.system))
	const toolPayload = JSON.stringify(
		(request.tools ?? []).map((tool) => ({
			name: tool.name,
			description: tool.description ?? '',
			input_schema: tool.input_schema,
		})),
	)
	const userVisibleText = [
		systemText,
		...userMessages.map((message) =>
			typeof message.content === 'string'
				? message.content
				: serializeBlocks(toContentBlocks(message.content)),
		),
	]
		.filter(Boolean)
		.join('\n\n')

	return {
		userMessageCount: userMessages.length,
		totalMessageCount: request.messages.length,
		newMessageCount: replayMessages.length,
		systemCharCount: systemText.length,
		toolCount: request.tools?.length ?? 0,
		toolNames: (request.tools ?? []).map((tool) => tool.name),
		toolSchemaCharCount: toolPayload.length,
		developerInstructionCharCount: developerInstructions.length,
		promptCharCount: promptText.length,
		userVisibleCharCount: userVisibleText.length,
		estimatedPromptTokens: estimateTokensFromText(promptText),
		estimatedUserVisibleTokens: estimateTokensFromText(userVisibleText),
		promptMode,
		replayFromMessageIndex,
	}
}

export function collectRequestTextSegments(request: AnthropicMessagesRequest): string[] {
	const segments: string[] = []

	const pushContent = (
		content: AnthropicMessage['content'] | AnthropicMessagesRequest['system'] | undefined,
	) => {
		if (!content) {
			return
		}

		if (typeof content === 'string') {
			if (content.trim()) {
				segments.push(content)
			}
			return
		}

		for (const block of content) {
			if (block.type === 'text' && block.text.trim()) {
				segments.push(block.text)
				continue
			}

			if (block.type === 'tool_use') {
				segments.push(block.name)
				segments.push(summarizeJsonValue(block.input, 2000))
				continue
			}

			if (block.type === 'tool_result') {
				segments.push(block.tool_use_id)
				segments.push(
					typeof block.content === 'string'
						? block.content
						: summarizeJsonValue(block.content, 2000),
				)
			}
		}
	}

	pushContent(request.system)
	for (const message of request.messages) {
		pushContent(message.content)
	}

	return segments
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw) as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

function extractJsonObjectCandidate(text: string): Record<string, unknown> | null {
	const trimmed = text.trim()
	if (!trimmed) {
		return null
	}

	const direct = tryParseJsonObject(trimmed)
	if (direct) {
		return direct
	}

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
	if (fenced?.[1]) {
		return tryParseJsonObject(fenced[1].trim())
	}

	const start = trimmed.indexOf('{')
	const end = trimmed.lastIndexOf('}')
	if (start >= 0 && end > start) {
		return tryParseJsonObject(trimmed.slice(start, end + 1))
	}

	return null
}

function normalizeDecisionKind(value: unknown): 'assistant' | 'tool_use' | null {
	if (value === 'assistant' || value === 'tool_use') {
		return value
	}

	return null
}

export function parseCodexBridgeDecision(
	text: string,
	request: AnthropicMessagesRequest,
): CodexBridgeDecision | null {
	if (!toolLoopEnabled(request)) {
		return null
	}

	const candidate = extractJsonObjectCandidate(text)
	if (!candidate) {
		return null
	}

	const kind = normalizeDecisionKind(candidate.kind ?? candidate.type)
	if (kind === 'assistant' && typeof candidate.text === 'string') {
		return {
			kind: 'assistant',
			text: candidate.text,
		}
	}

	if (kind !== 'tool_use' || typeof candidate.name !== 'string') {
		return null
	}

	const toolNames = new Set((request.tools ?? []).map((tool) => tool.name))
	if (!toolNames.has(candidate.name)) {
		return null
	}

	const input = candidate.input
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return null
	}

	const decision: CodexBridgeDecision = {
		kind: 'tool_use',
		name: candidate.name,
		input: input as JsonObject,
	}

	if (typeof candidate.preamble === 'string' && candidate.preamble.trim()) {
		decision.preamble = candidate.preamble
	}

	return decision
}

export function mapCodexResultToAnthropic(
	response: CodexTurnResult,
	requestedModel: string,
): AnthropicMessagesResponse {
	const usage = {
		input_tokens: response.usage.inputTokens,
		output_tokens: response.usage.outputTokens,
		cache_read_input_tokens: response.usage.cachedInputTokens,
		reasoning_output_tokens: response.usage.reasoningOutputTokens,
		total_tokens: response.usage.totalTokens,
	}

	if (response.decision?.kind === 'tool_use') {
		const content: AnthropicResponseContentBlock[] = []
		if (response.decision.preamble?.trim()) {
			content.push({
				type: 'text',
				text: response.decision.preamble,
			})
		}

		content.push({
			type: 'tool_use',
			id: `toolu_${crypto.randomUUID()}`,
			name: response.decision.name,
			input: response.decision.input,
		})

		return {
			id: response.id,
			type: 'message',
			role: 'assistant',
			model: response.model || requestedModel,
			content,
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage,
		}
	}

	if (response.decision?.kind === 'assistant') {
		return {
			id: response.id,
			type: 'message',
			role: 'assistant',
			model: response.model || requestedModel,
			content: [
				{
					type: 'text',
					text: response.decision.text,
				} satisfies AnthropicResponseContentBlock,
			],
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage,
		}
	}

	return {
		id: response.id,
		type: 'message',
		role: 'assistant',
		model: response.model || requestedModel,
		content: [
			{
				type: 'text',
				text: response.text,
			} satisfies AnthropicResponseContentBlock,
		],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage,
	}
}

function isToolSchemaStrict(schema: unknown): boolean {
	const object = schema && typeof schema === 'object' && !Array.isArray(schema)
		? (schema as Record<string, unknown>)
		: null
	if (!object) {
		return false
	}

	return object.type === 'object' && object.additionalProperties === false
}

export function validateAnthropicRequestSemantics(request: AnthropicMessagesRequest): void {
	const seenToolIds = new Set<string>()
	const availableTools = new Set((request.tools ?? []).map((tool) => tool.name))
	const pendingToolIds = new Set<string>()

	for (const tool of request.tools ?? []) {
		if (!tool.name.trim()) {
			throw new AnthropicRequestValidationError('tool.name 은 비어 있을 수 없습니다.', 400)
		}
		normalizeInputSchemaToStrictObject(tool.name, tool.input_schema)
		if (!isToolSchemaStrict(tool.input_schema)) {
			throw new AnthropicRequestValidationError(
				`tool '${tool.name}' input_schema 는 strict object schema(type=object, additionalProperties=false)여야 합니다.`,
				400,
			)
		}
	}

	for (const block of toContentBlocks(request.system)) {
		if (block.type === 'tool_use' || block.type === 'tool_result') {
			throw new AnthropicRequestValidationError(
				'system 블록에는 tool_use/tool_result를 포함할 수 없습니다.',
				422,
			)
		}
	}

	for (const message of request.messages) {
		const blocks = toContentBlocks(message.content)
		for (const block of blocks) {
			if (block.type === 'tool_use') {
				if (message.role !== 'assistant') {
					throw new AnthropicRequestValidationError(
						'tool_use 블록은 assistant 메시지에서만 허용됩니다.',
						422,
					)
				}
				if (!availableTools.has(block.name)) {
					throw new AnthropicRequestValidationError(
						`정의되지 않은 tool_use 이름입니다: ${block.name}`,
						422,
					)
				}
				if (seenToolIds.has(block.id)) {
					throw new AnthropicRequestValidationError(
						`중복된 tool_use id 입니다: ${block.id}`,
						422,
					)
				}
				seenToolIds.add(block.id)
				pendingToolIds.add(block.id)
				continue
			}

			if (block.type === 'tool_result') {
				if (message.role !== 'user') {
					throw new AnthropicRequestValidationError(
						'tool_result 블록은 user 메시지에서만 허용됩니다.',
						422,
					)
				}
				if (!pendingToolIds.has(block.tool_use_id)) {
					throw new AnthropicRequestValidationError(
						`선행 tool_use 없이 tool_result 가 전달되었습니다: ${block.tool_use_id}`,
						422,
					)
				}
				pendingToolIds.delete(block.tool_use_id)
			}
		}
	}
}
