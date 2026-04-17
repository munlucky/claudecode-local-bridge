import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexDirectAdapter } from '../../../src/bridge/provider/codex-direct.js'
import { getCodexDirectAuthHealth } from '../../../src/bridge/provider/codex-direct-auth.js'
import type { CanonicalBridgeRequest } from '../../../src/bridge/canonical/types.js'
import type { RouterConfig } from '../../../src/server/config.js'

type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const tempRoot = mkdtempSync(join(tmpdir(), 'codex-direct-test-'))
const authStateFile = join(tempRoot, 'auth-direct.json')

const baseConfig: RouterConfig = {
	listenHost: '127.0.0.1',
	listenPort: 3000,
	bridgeBackend: 'codex',
	activeProviderId: 'codex-app-server',
	codexCommand: 'codex',
	codexAuthMode: 'local_auth_json',
	codexAuthFile: '/tmp/auth.json',
	codexOpenAiApiKey: null,
	codexDirectEnabled: true,
	codexDirectRollout: 'shadow',
	codexDirectAuthMode: 'oauth',
	codexDirectAuthStateFile: authStateFile,
	codexDirectBaseUrl: 'https://example.test/backend-api/codex',
	codexDirectRequestTimeoutMs: 45000,
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
	openAiCompatibleBaseUrl: null,
	openAiCompatibleApiKey: null,
	openAiCompatibleRequestTimeoutMs: 45000,
	providerRouting: {
		aliases: {},
		skillPolicies: {},
		familyPolicies: {},
		providerDefaults: {
			'codex-app-server': 'gpt-5.4',
			'codex-direct': 'gpt-5.4',
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

async function collectCanonicalStream(stream: ReadableStream<unknown>) {
	const reader = stream.getReader()
	const events: unknown[] = []
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			events.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	return events
}

function createDeferred() {
	let resolve!: () => void
	let reject!: (error?: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('codex-direct adapter', () => {
	const originalFetch = global.fetch

	afterEach(() => {
		global.fetch = originalFetch
		rmSync(authStateFile, { force: true })
	})

	const restoreFetch = (handler: MockFetch) => {
		global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			handler(input, init)) as typeof globalThis.fetch
	}

	test('lists provider-qualified models when codex-direct is not active', async () => {
		const adapter = createCodexDirectAdapter()

		await expect(adapter.listModels(baseConfig)).resolves.toEqual([
			{
				exposedModel: 'codex-direct/claude-sonnet-4-5-20250929',
				displayName: 'codex-direct/claude-sonnet-4-5-20250929',
				providerId: 'codex-direct',
				providerModel: 'gpt-5.4',
			},
		])
	})

test('refreshes expired oauth state and forwards account headers on execute', async () => {
		const adapter = createCodexDirectAdapter()
		writeFileSync(
			authStateFile,
			JSON.stringify({
				authType: 'oauth',
				accessToken: 'expired-token',
				refreshToken: 'refresh-token',
				expiresAt: '2000-01-01T00:00:00.000Z',
				accountId: 'acct_before',
			}),
		)

		let seenRefresh = false
		let capturedHeaders: Headers | null = null
		let capturedBody: Record<string, unknown> | null = null

		restoreFetch(async (input, init) => {
			if (String(input) === 'https://auth.openai.com/oauth/token') {
				seenRefresh = true
				return Response.json({
					access_token: 'fresh-token',
					refresh_token: 'fresh-refresh-token',
					expires_in: 3600,
					id_token: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2FmdGVyIn0.signature',
				})
			}

			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				capturedHeaders = new Headers(init?.headers)
				capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
				return Response.json({
					id: 'resp_direct_1',
					model: 'gpt-5.4-mini',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'direct response' }],
						},
					],
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
					},
				})
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const response = await adapter.execute(baseConfig, baseRequest)
		const persisted = JSON.parse(readFileSync(authStateFile, 'utf8')) as {
			accessToken: string
			refreshToken: string
			accountId: string
		}

		expect(seenRefresh).toBe(true)
		expect(capturedHeaders?.get('authorization')).toBe('Bearer fresh-token')
		expect(capturedHeaders?.get('chatgpt-account-id')).toBe('acct_after')
		expect(capturedBody?.model).toBe('gpt-5.4-mini')
		expect('max_tokens' in (capturedBody ?? {})).toBe(false)
		expect('max_output_tokens' in (capturedBody ?? {})).toBe(false)
		expect(capturedBody?.store).toBe(false)
		expect(capturedBody?.stream).toBe(true)
		expect(typeof capturedBody?.instructions).toBe('string')
		expect(String(capturedBody?.instructions)).toContain('Anthropic-compatible backend')
		expect(Array.isArray(capturedBody?.input)).toBe(true)
		expect(response.provider.id).toBe('codex-direct')
		expect(response.content).toEqual([{ type: 'text', text: 'direct response' }])
		expect(persisted.accessToken).toBe('fresh-token')
		expect(persisted.refreshToken).toBe('fresh-refresh-token')
		expect(persisted.accountId).toBe('acct_after')
		expect(statSync(authStateFile).mode & 0o777).toBe(0o600)
	})

	test('treats refreshable oauth state as ready for health checks', () => {
		writeFileSync(
			authStateFile,
			JSON.stringify({
				authType: 'oauth',
				accessToken: 'expired-token',
				refreshToken: 'refresh-token',
				expiresAt: '2000-01-01T00:00:00.000Z',
			}),
		)

		expect(getCodexDirectAuthHealth(baseConfig)).toEqual({
			hasAuthDependency: true,
			ready: true,
			message:
				'codex-direct OAuth access token is expired but can be refreshed on the next request',
			state: 'refreshable',
			hasStoredState: true,
		})
	})

	test('moves caller system content into codex-direct instructions instead of input messages', async () => {
		const adapter = createCodexDirectAdapter()
		let capturedBody: Record<string, unknown> | null = null

		restoreFetch(async (input, init) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
				return Response.json({
					id: 'resp_direct_2',
					model: 'gpt-5.4-mini',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'ok' }],
						},
					],
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
					},
				})
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			{
				...baseRequest,
				system: [{ type: 'text', text: 'You are terse.' }],
			},
		)

		expect(String(capturedBody?.instructions)).toContain('Caller system instructions')
		expect(String(capturedBody?.instructions)).toContain('You are terse.')
		expect('max_tokens' in (capturedBody ?? {})).toBe(false)
		expect('max_output_tokens' in (capturedBody ?? {})).toBe(false)
		expect(capturedBody?.store).toBe(false)
		expect(capturedBody?.stream).toBe(true)
		expect(capturedBody?.input).toEqual([
			{
				role: 'user',
				content: 'hello',
			},
		])
	})

	test('maps non-stream function_call output into canonical tool_use content', async () => {
		const adapter = createCodexDirectAdapter()
		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return Response.json({
					id: 'resp_direct_tool_1',
					model: 'gpt-5.4-mini',
					output: [
						{
							type: 'function_call',
							call_id: 'call_123',
							name: 'Read',
							arguments: '{"file_path":"/tmp/demo.txt"}',
						},
					],
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
					},
				})
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const response = await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			{
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
			},
		)

		expect(response.stopReason).toBe('tool_use')
		expect(response.content).toEqual([
			{
				type: 'tool_use',
				id: 'call_123',
				name: 'Read',
				input: {
					file_path: '/tmp/demo.txt',
				},
			},
		])
	})

	test('preserves assistant tool_use and user tool_result ordering in codex-direct input messages', async () => {
		const adapter = createCodexDirectAdapter()
		let capturedBody: Record<string, unknown> | null = null

		restoreFetch(async (input, init) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
				return Response.json({
					id: 'resp_direct_order_1',
					model: 'gpt-5.4-mini',
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'ordered' }],
						},
					],
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
					},
				})
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			{
				...baseRequest,
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
			},
		)

		expect(capturedBody?.input).toEqual([
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

	test('aggregates SSE responses from the codex direct backend', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_sse_1","model":"gpt-5.4-mini","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"streamed response"}]}],"usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const response = await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			baseRequest,
		)

		expect(response.content).toEqual([{ type: 'text', text: 'streamed response' }])
		expect(response.usage.totalTokens).toBe(12)
	})

	test('parses SSE responses even when the backend omits the event-stream content-type', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					[
						'event: response.completed',
						'data: {"type":"response.completed","response":{"id":"resp_sse_2","model":"gpt-5.4-mini","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"headerless stream"}]}],"usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}}',
						'',
						'data: [DONE]',
						'',
					].join('\n'),
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const response = await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			baseRequest,
		)

		expect(response.content).toEqual([{ type: 'text', text: 'headerless stream' }])
		expect(response.usage.totalTokens).toBe(12)
	})

	test('merges output_text deltas when response.completed omits assistant content', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta',
										'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"merged text"}',
										'',
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_sse_3","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const response = await adapter.execute(
			{
				...baseConfig,
				codexDirectAuthMode: 'api_key',
				codexOpenAiApiKey: 'test-key',
			},
			baseRequest,
		)

		expect(response.content).toEqual([{ type: 'text', text: 'merged text' }])
		expect(response.usage.totalTokens).toBe(9)
	})

	test('streams a codex-direct SSE response as canonical events', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.created',
										'data: {"type":"response.created","response":{"id":"resp_stream_1","model":"gpt-5.4-mini"}}',
										'',
										'event: response.output_text.delta',
										'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}',
										'',
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const events = await collectCanonicalStream(
			adapter.stream(
				{
					...baseConfig,
					codexDirectAuthMode: 'api_key',
					codexOpenAiApiKey: 'test-key',
				},
				{
					...baseRequest,
					stream: true,
				},
			),
		)

		expect(events).toEqual([
			{
				type: 'message_start',
				messageId: 'resp_stream_1',
				model: 'gpt-5.4-mini',
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
				},
			},
			{
				type: 'content_block_start',
				index: 0,
				contentBlock: {
					type: 'text',
					text: '',
				},
			},
			{
				type: 'content_block_delta',
				index: 0,
				delta: {
					type: 'text_delta',
					text: 'hello',
				},
			},
			{
				type: 'content_block_stop',
				index: 0,
			},
			{
				type: 'message_delta',
				stopReason: 'end_turn',
				stopSequence: null,
				usage: {
					inputTokens: 4,
					outputTokens: 2,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 6,
				},
			},
			{
				type: 'message_stop',
			},
		])
	})

	test('streams codex-direct function_call output as canonical tool_use events', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.created',
										'data: {"type":"response.created","response":{"id":"resp_stream_2","model":"gpt-5.4-mini"}}',
										'',
										'event: response.output_item.added',
										'data: {"type":"response.output_item.added","item_id":"fc_1","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_456","name":"Read","arguments":""}}',
										'',
										'event: response.function_call_arguments.delta',
										'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"file_path\\":\\"/tmp/a.txt\\"}"}',
										'',
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_stream_2","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const events = await collectCanonicalStream(
			adapter.stream(
				{
					...baseConfig,
					codexDirectAuthMode: 'api_key',
					codexOpenAiApiKey: 'test-key',
				},
				{
					...baseRequest,
					stream: true,
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
				},
			),
		)

		expect(events).toEqual([
			{
				type: 'message_start',
				messageId: 'resp_stream_2',
				model: 'gpt-5.4-mini',
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
				},
			},
			{
				type: 'content_block_start',
				index: 0,
				contentBlock: {
					type: 'tool_use',
					id: 'call_456',
					name: 'Read',
					input: {},
				},
			},
			{
				type: 'content_block_delta',
				index: 0,
				delta: {
					type: 'input_json_delta',
					partialJson: '{"file_path":"/tmp/a.txt"}',
				},
			},
			{
				type: 'content_block_stop',
				index: 0,
			},
			{
				type: 'message_delta',
				stopReason: 'tool_use',
				stopSequence: null,
				usage: {
					inputTokens: 5,
					outputTokens: 3,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 8,
				},
			},
			{
				type: 'message_stop',
			},
		])
	})

	test('emits canonical stream events before response.completed arrives', async () => {
		const adapter = createCodexDirectAdapter()
		const allowCompletion = createDeferred()
		let completionReleased = false

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						async start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.created',
										'data: {"type":"response.created","response":{"id":"resp_stream_live_1","model":"gpt-5.4-mini"}}',
										'',
										'',
									].join('\n'),
								),
							)
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta',
										'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hello"}',
										'',
										'',
									].join('\n'),
								),
							)
							await allowCompletion.promise
							completionReleased = true
							controller.enqueue(
								encoder.encode(
									[
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_stream_live_1","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const reader = adapter
			.stream(
				{
					...baseConfig,
					codexDirectAuthMode: 'api_key',
					codexOpenAiApiKey: 'test-key',
				},
				{
					...baseRequest,
					stream: true,
				},
			)
			.getReader()

		try {
			const first = await reader.read()
			const second = await reader.read()
			const third = await reader.read()

			expect(first).toEqual({
				done: false,
				value: {
					type: 'message_start',
					messageId: 'resp_stream_live_1',
					model: 'gpt-5.4-mini',
					usage: {
						inputTokens: 0,
						outputTokens: 0,
						cachedInputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 0,
					},
				},
			})
			expect(second).toEqual({
				done: false,
				value: {
					type: 'content_block_start',
					index: 0,
					contentBlock: {
						type: 'text',
						text: '',
					},
				},
			})
			expect(third).toEqual({
				done: false,
				value: {
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'text_delta',
						text: 'hello',
					},
				},
			})
			expect(completionReleased).toBe(false)

			allowCompletion.resolve()
			const remaining: unknown[] = []
			while (true) {
				const next = await reader.read()
				if (next.done) {
					break
				}
				remaining.push(next.value)
			}

			expect(remaining).toEqual([
				{
					type: 'content_block_stop',
					index: 0,
				},
				{
					type: 'message_delta',
					stopReason: 'end_turn',
					stopSequence: null,
					usage: {
						inputTokens: 4,
						outputTokens: 2,
						cachedInputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 6,
					},
				},
				{
					type: 'message_stop',
				},
			])
		} finally {
			allowCompletion.resolve()
			reader.releaseLock()
		}
	})

	test('uses the upstream response id when response.created arrives shortly after the first delta', async () => {
		const adapter = createCodexDirectAdapter()

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta',
										'data: {"type":"response.output_text.delta","item_id":"msg_buffer_1","output_index":0,"delta":"hello"}',
										'',
										'event: response.created',
										'data: {"type":"response.created","response":{"id":"resp_buffered_1","model":"gpt-5.4-mini"}}',
										'',
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_buffered_1","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const events = await collectCanonicalStream(
			adapter.stream(
				{
					...baseConfig,
					codexDirectAuthMode: 'api_key',
					codexOpenAiApiKey: 'test-key',
				},
				{
					...baseRequest,
					stream: true,
				},
			),
		)

		expect(events[0]).toEqual({
			type: 'message_start',
			messageId: 'resp_buffered_1',
			model: 'gpt-5.4-mini',
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
			},
		})
	})

	test('records a deterministic provisional id and preserves the final upstream id in metadata when response.created is missing', async () => {
		const adapter = createCodexDirectAdapter()
		const completionPayloads: Array<{
			model: string
			messageId?: string | null
			upstreamResponseId?: string | null
			provisionalMessageId?: boolean
		}> = []

		restoreFetch(async (input) => {
			if (String(input) === 'https://example.test/backend-api/codex/responses') {
				return new Response(
					new ReadableStream({
						async start(controller) {
							const encoder = new TextEncoder()
							controller.enqueue(
								encoder.encode(
									[
										'event: response.output_text.delta',
										'data: {"type":"response.output_text.delta","item_id":"msg_missing_created","output_index":0,"delta":"hello"}',
										'',
										'',
									].join('\n'),
								),
							)
							await new Promise((resolve) => setTimeout(resolve, 70))
							controller.enqueue(
								encoder.encode(
									[
										'event: response.completed',
										'data: {"type":"response.completed","response":{"id":"resp_missing_created_1","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
										'',
										'data: [DONE]',
										'',
									].join('\n'),
								),
							)
							controller.close()
						},
					}),
					{
						headers: {
							'content-type': 'text/event-stream',
						},
					},
				)
			}

			throw new Error(`unexpected endpoint: ${String(input)}`)
		})

		const events = await collectCanonicalStream(
			adapter.stream(
				{
					...baseConfig,
					codexDirectAuthMode: 'api_key',
					codexOpenAiApiKey: 'test-key',
				},
				{
					...baseRequest,
					stream: true,
				},
				undefined,
				{
					onComplete(payload) {
						completionPayloads.push(payload.metadata)
					},
				},
			),
		)

		expect(events[0]).toEqual({
			type: 'message_start',
			messageId: 'msg_provisional_routerreq_test_msg_missing_created_0',
			model: 'gpt-5.4-mini',
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
			},
		})
		expect(completionPayloads).toEqual([
			{
				model: 'gpt-5.4-mini',
				messageId: 'msg_provisional_routerreq_test_msg_missing_created_0',
				upstreamResponseId: 'resp_missing_created_1',
				provisionalMessageId: true,
			},
		])
	})
})
