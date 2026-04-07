import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
	AnthropicMessagesRequest,
	AnthropicToolDefinition,
} from '../../shared/types.js'

export interface AnthropicToolBridgeSession {
	workspaceRoot: string
	tools: AnthropicToolDefinition[]
	maxConcurrentCalls: number
	maxResponseBytes: number
	defaultTimeoutMs: number
}

export interface AnthropicToolBridgeHandle {
	configOverride: Record<string, unknown>
	serverName: string
	cleanup: () => Promise<void>
}

const TOOL_SERVER_NAME = 'anthropic_bridge'
const TOOL_SERVER_SCRIPT_PATH = fileURLToPath(
	new URL('./tool-server.ts', import.meta.url),
)
const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_CONCURRENT_CALLS = 2
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeToolInputSchema(toolName: string, inputSchema: AnthropicToolDefinition['input_schema']): void {
	if (!isPlainObject(inputSchema)) {
		throw new Error(`tool '${toolName}' input_schema 는 object 여야 합니다.`)
	}

	if (inputSchema.type !== 'object') {
		throw new Error(`tool '${toolName}' input_schema.type 은 'object' 여야 합니다.`)
	}

	if (inputSchema.additionalProperties !== false) {
		inputSchema.additionalProperties = false
	}
}

export function validateAnthropicToolDefinitions(tools: AnthropicToolDefinition[]): void {
	const seenNames = new Set<string>()
	for (const tool of tools) {
		const normalizedName = tool.name.trim().toLowerCase()
		if (!normalizedName) {
			throw new Error('tool.name 은 비어 있을 수 없습니다.')
		}
		if (seenNames.has(normalizedName)) {
			throw new Error(`중복된 tool 이름입니다: ${tool.name}`)
		}
		seenNames.add(normalizedName)
		normalizeToolInputSchema(tool.name, tool.input_schema)
	}
}

export async function createAnthropicToolBridge(
	request: AnthropicMessagesRequest,
	workspaceRoot: string,
): Promise<AnthropicToolBridgeHandle | null> {
	if (!request.tools?.length) {
		return null
	}

	validateAnthropicToolDefinitions(request.tools)

	const sessionDir = await mkdtemp(join(tmpdir(), 'anthropic-tools-'))
	const sessionFilePath = join(sessionDir, 'session.json')
	const bunCommand = Bun.which('bun') ?? 'bun'
	const session: AnthropicToolBridgeSession = {
		workspaceRoot,
		tools: request.tools,
		maxConcurrentCalls: DEFAULT_MAX_CONCURRENT_CALLS,
		maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
		defaultTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
	}

	await writeFile(sessionFilePath, JSON.stringify(session, null, 2), 'utf8')

	return {
		serverName: TOOL_SERVER_NAME,
		configOverride: {
			mcp_servers: {
				[TOOL_SERVER_NAME]: {
					command: bunCommand,
					args: ['run', TOOL_SERVER_SCRIPT_PATH, sessionFilePath],
				},
			},
		},
		cleanup: async () => {
			await rm(sessionDir, { recursive: true, force: true })
		},
	}
}
