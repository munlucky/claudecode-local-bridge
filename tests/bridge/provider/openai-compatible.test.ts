import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAiCompatibleAdapter } from '../../../src/bridge/provider/openai-compatible.js'
import type { RouterConfig } from '../../../src/server/config.js'
import type { CanonicalBridgeRequest } from '../../../src/bridge/canonical/types.js'

type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const baseConfig: RouterConfig = {
	listenHost: '127.0.0.1',
	listenPort: 3000,
	bridgeBackend: 'codex',
	activeProviderId: 'codex-app-server',
	codexCommand: 'codex',
	codexAuthMode: 'local_auth_json',
	codexAuthFile: '/tmp/auth.json',
	codexOpenAiApiKey: null,
	codexRuntimeCwd: '/tmp/runtime',
	codexSandboxMode: 'workspace-write',
	codexInitTimeoutMs: 15000,
	codexTurnTimeoutMs: 180000,
	codexTurnRequestTimeoutMs: 180000,
	serverIdleTimeoutSec: 185,
	userAgent: 'test-agent',
	logRequests: false,
	runtimeLogsEnabled: false,
	runtimeLogsRootPath: '.bridge-logs',
	captureRequests: false,
	captureRequestsPath: '.history/anthropic-requests.jsonl',
	captureResponses: false,
	captureResponsesPath: '.history/anthropic-responses.jsonl',
	captureMaxFileBytes: 1024,
	captureRetentionDays: 7,
	heartbeatIntervalSec: 30,
	modelAliases: {
		'claude-sonnet-4-5-20250929': 'gpt-5.4',
	},
	ollamaModelAliases: {},
	ollamaBaseUrl: 'http://127.0.0.1:11434',
	ollamaModel: 'qwen3.5:27b',
	ollamaApiKey: null,
	ollamaRequestTimeoutMs: 120000,
	ollamaShowThinking: false,
	openAiCompatibleBaseUrl: 'https://example.test',
	openAiCompatibleApiKey: 'test-key',
	openAiCompatibleRequestTimeoutMs: 45000,
	providerRouting: {
		aliases: {},
		skillPolicies: {},
		familyPolicies: {},
		providerDefaults: {
			'codex-app-server': 'gpt-5.4',
			'ollama-chat': 'qwen3.5:27b',
			'openai-compatible': 'gpt-5.4-mini',
		},
		fallback: 'codex-app-server/gpt-5.4',
	},
}

const baseRequest: CanonicalBridgeRequest = {
	model: 'gpt-5.4-mini',
	stream: false,
	source: 'anthropic-route',
	system: [],
	messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
	tools: [],
	sampling: {
		maxTokens: 128,
	},
	metadata: {
		sessionId: null,
		routerRequestId: 'routerreq_test',
		userAgent: 'test-agent',
	},
}

describe('openai-compatible adapter', () => {
	const originalFetch = global.fetch

	afterEach(() => {
		global.fetch = originalFetch
	})

	const restoreFetch = (handler: MockFetch) => {
		global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			handler(input, init)) as typeof globalThis.fetch
	}

	test('serializes tool results into ordered user/tool messages', async () => {
		const adapter = createOpenAiCompatibleAdapter()
		let capturedBody: Record<string, unknown> | null = null

		restoreFetch(async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
			return Response.json({
				id: 'chatcmpl_1',
				model: 'gpt-5.4-mini',
				choices: [
					{
						finish_reason: 'stop',
						message: {
							content: 'done',
						},
					},
				],
				usage: {
					prompt_tokens: 12,
					completion_tokens: 4,
					total_tokens: 16,
				},
			})
		})

		await adapter.execute(baseConfig, {
			...baseRequest,
			tools: [
				{
					name: 'Read',
					description: 'Read a file',
					input_schema: {
						type: 'object',
						properties: {
							file_path: { type: 'string' },
						},
						required: ['file_path'],
						additionalProperties: false,
					},
				},
			],
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_1',
							name: 'Read',
							input: { file_path: '/tmp/demo.txt' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'before' },
						{ type: 'tool_result', toolUseId: 'toolu_1', content: 'tool output' },
						{ type: 'text', text: 'after' },
					],
				},
			],
		})

		expect(capturedBody?.messages).toEqual([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'toolu_1',
						type: 'function',
						function: {
							name: 'Read',
							arguments: '{"file_path":"/tmp/demo.txt"}',
						},
					},
				],
			},
			{
				role: 'user',
				content: 'before',
			},
			{
				role: 'tool',
				tool_call_id: 'toolu_1',
				content: 'tool output',
			},
			{
				role: 'user',
				content: 'after',
			},
		])
	})

	test('includes upstream error previews in adapter failures', async () => {
		const adapter = createOpenAiCompatibleAdapter()

		restoreFetch(async () =>
			Response.json(
				{
					error: {
						message: 'provider rejected the request payload',
					},
				},
				{
					status: 400,
					headers: {
						'x-request-id': 'req_openai_compat_123',
					},
				},
			),
		)

		await expect(adapter.execute(baseConfig, baseRequest)).rejects.toMatchObject({
			message: expect.stringContaining('provider rejected the request payload'),
			status: 400,
			requestId: 'req_openai_compat_123',
			responseBodyPreview: 'provider rejected the request payload',
		})
	})

	test('rejects malformed successful responses without choices[0]', async () => {
		const adapter = createOpenAiCompatibleAdapter()

		restoreFetch(async () =>
			Response.json({
				id: 'chatcmpl_bad',
				model: 'gpt-5.4-mini',
				choices: [],
			}),
		)

		await expect(adapter.execute(baseConfig, baseRequest)).rejects.toMatchObject({
			message: 'openai-compatible response is missing choices[0]',
		})
	})
})
