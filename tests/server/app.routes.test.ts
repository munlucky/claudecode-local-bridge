import { afterEach, describe, expect, test } from 'bun:test'
import { createApp } from '../../src/server/index.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJsonFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ollama', name), 'utf8')) as T
}

type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function createMockReadableStream(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(lines.join('\n')))
			controller.close()
		},
	})
}

describe('Ollama router integration', () => {
	const originalFetch = global.fetch
	const restoreEnv = (values: Record<string, string | undefined>) => {
		const previous = Object.fromEntries(
			Object.keys(values).map((key) => [key, process.env[key]]),
		) as Record<string, string | undefined>

		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = value
			}
		}

		return () => {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) {
					delete process.env[key]
				} else {
					process.env[key] = value
				}
			}
		}
	}

	afterEach(() => {
		global.fetch = originalFetch
	})

	const restoreFetch = (handler: MockFetch) => {
		global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			handler(input, init)) as typeof globalThis.fetch
	}

	test('returns ollama metadata in /health', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})
		try {
			const { app } = createApp()
			const response = await app.fetch(new Request('http://127.0.0.1:3000/health'))
			const payload = (await response.json()) as {
				backend: string
				ollama_base_url?: string
				ollama_model?: string
			}

			expect(response.status).toBe(200)
			expect(payload.backend).toBe('ollama_api')
			expect(payload.ollama_base_url).toBe('http://127.0.0.1:11434')
			expect(payload.ollama_model).toBe('qwen3.5:27b')
			expect(payload).not.toHaveProperty('auth_mode')
			expect(payload).not.toHaveProperty('has_auth_mode_dependency')
			expect(payload).not.toHaveProperty('codex_auth_file')
			expect(payload).not.toHaveProperty('codex_runtime_cwd')
		} finally {
			restore()
		}
	})

	test('proxies /v1/models to ollama /api/tags', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
		})
		try {
			const tagsFixture = readJsonFixture<{
				models: Array<{ model: string; name?: string }>
			}>('01-api-tags.json')
			restoreFetch(async (input) => {
				if (String(input).includes('/api/tags')) {
					return Response.json(tagsFixture)
				}
				throw new Error('unexpected endpoint')
			})

			const { app } = createApp()
			const response = await app.fetch(new Request('http://127.0.0.1:3000/v1/models'))
			const payload = (await response.json()) as {
				data: Array<{ id: string; name: string; type: string }>
			}

			expect(response.status).toBe(200)
			expect(payload.data).toEqual(
				expect.arrayContaining([
					{
						type: 'model',
						id: 'qwen3.5:27b',
						name: 'qwen3.5:27b',
					},
				]),
			)
		} finally {
			restore()
		}
	})

	test('handles /v1/messages non-stream via ollama route and maps tool_calls', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})

		try {
			const toolResponse = readJsonFixture<{
				model: string
				message: {
					content: string
					tool_calls: Array<{ id: string; function: { name: string; arguments: Record<string, unknown> } }>
				}
			}>('05-tool-chat-response.json')

			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					return Response.json(toolResponse)
				}
				throw new Error('unexpected endpoint')
			})

			const { app } = createApp()
			const requestBody = {
				model: 'qwen3.5:27b',
				max_tokens: 256,
				messages: [{ role: 'user', content: '서울 날씨 알려줘' }],
			tools: [
				{
					name: 'get_weather',
					description: 'Get current weather for a city',
					input_schema: {
						type: 'object',
						additionalProperties: false,
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			],
		}
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify(requestBody),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
				content: Array<{ type: string; name?: string }>
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('tool_use')
			expect(payload.content).toEqual([
				{
					type: 'tool_use',
					id: 'call_c9j2d4de',
					name: 'get_weather',
					input: {
						city: '서울',
					},
				},
			])
		} finally {
			restore()
		}
	})

	test('routes explicit slash command to Skill tool without provider call', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			restoreFetch(async () => {
				throw new Error('provider should not be called for direct skill routing')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						messages: [{ role: 'user', content: '/moonshot-phase-runner docs/implementation/ --prepare-only' }],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
				content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('tool_use')
			expect(payload.content).toEqual([
				{
					type: 'tool_use',
					id: expect.stringMatching(/^toolu_/),
					name: 'Skill',
					input: {
						skill: 'moonshot-phase-runner',
						args: 'docs/implementation/ --prepare-only',
					},
				},
			])
		} finally {
			restore()
		}
	})

	test('routes explicit provider-qualified model ids to the selected provider', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})

		try {
			const chatResponse = readJsonFixture<{
				model: string
				message: { content: string }
				prompt_eval_count?: number
				eval_count?: number
			}>('03-chat-response.json')

			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					return Response.json(chatResponse)
				}
				throw new Error('unexpected endpoint')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'ollama/qwen3.5:27b',
						max_tokens: 128,
						messages: [{ role: 'user', content: '짧게 자기소개' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				model: string
				content: Array<{ type: string; text?: string }>
			}

			expect(response.status).toBe(200)
			expect(payload.model).toBe('ollama/qwen3.5:27b')
			expect(payload.content[0]?.type).toBe('text')
		} finally {
			restore()
		}
	})

		test('routes a prior skill flow through the configured skill policy', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			PROVIDER_ROUTING_JSON: JSON.stringify({
				skillPolicies: {
					'local-reasoning': 'ollama/qwen3.5:27b',
				},
			}),
		})

		try {
			const chatResponse = readJsonFixture<{
				model: string
				message: { content: string }
				prompt_eval_count?: number
				eval_count?: number
			}>('03-chat-response.json')

			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					return Response.json(chatResponse)
				}
				throw new Error('unexpected endpoint')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-5-20250929',
						max_tokens: 128,
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
									},
									required: ['skill'],
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
										id: 'toolu_skill',
										name: 'Skill',
										input: {
											skill: 'local-reasoning',
										},
									},
								],
							},
							{
								role: 'user',
								content: '이어서 한 줄만 답해줘',
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				model: string
				content: Array<{ type: string; text?: string }>
			}

			expect(response.status).toBe(200)
			expect(payload.model).toBe('claude-sonnet-4-5-20250929')
			expect(payload.content[0]?.type).toBe('text')
			} finally {
				restore()
			}
		})

		test('includes enabled openai-compatible models in /v1/models with provider-qualified ids', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
				OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
				OPENAI_COMPATIBLE_API_KEY: 'test-key',
			})

			try {
				restoreFetch(async (input) => {
					if (String(input) === 'https://example.test/v1/models') {
						return Response.json({
							data: [{ id: 'gpt-5.4-mini' }],
						})
					}
					throw new Error(`unexpected endpoint: ${String(input)}`)
				})

				const { app } = createApp()
				const response = await app.fetch(new Request('http://127.0.0.1:3000/v1/models'))
				const payload = (await response.json()) as {
					data: Array<{ id: string; name: string }>
				}

				expect(response.status).toBe(200)
				expect(payload.data).toEqual(
					expect.arrayContaining([
						{
							id: 'claude-sonnet-4-5-20250929',
							name: 'claude-sonnet-4-5-20250929',
							type: 'model',
						},
						{
							id: 'openai-compatible/gpt-5.4-mini',
							name: 'openai-compatible/gpt-5.4-mini',
							type: 'model',
						},
					]),
				)
			} finally {
				restore()
			}
		})

		test('prefixes non-active legacy provider models in /v1/models', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
				OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			})

			try {
				restoreFetch(async (input) => {
					if (String(input).includes('/api/tags')) {
						return Response.json({
							models: [{ model: 'qwen3.5:27b' }],
						})
					}
					throw new Error(`unexpected endpoint: ${String(input)}`)
				})

				const { app } = createApp()
				const response = await app.fetch(new Request('http://127.0.0.1:3000/v1/models'))
				const payload = (await response.json()) as {
					data: Array<{ id: string; name: string; type: string }>
				}

				expect(response.status).toBe(200)
				expect(payload.data).toEqual(
					expect.arrayContaining([
						{
							id: 'ollama/qwen3.5:27b',
							name: 'ollama/qwen3.5:27b',
							type: 'model',
						},
					]),
				)
			} finally {
				restore()
			}
		})

		test('routes explicit openai-compatible model ids when configured', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input) === 'https://example.test/v1/chat/completions') {
					return Response.json({
						id: 'chatcmpl-openai-compatible-1',
						model: 'gpt-5.4-mini',
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'openai-compatible 경로 응답입니다.',
								},
							},
						],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 7,
							total_tokens: 19,
						},
					})
				}
				throw new Error(`unexpected endpoint: ${String(input)}`)
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'openai-compatible/gpt-5.4-mini',
						max_tokens: 128,
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				model: string
				content: Array<{ type: string; text?: string }>
			}

			expect(response.status).toBe(200)
			expect(payload.model).toBe('openai-compatible/gpt-5.4-mini')
			expect(payload.content[0]).toEqual({
				type: 'text',
				text: 'openai-compatible 경로 응답입니다.',
			})
			} finally {
				restore()
			}
		})

		test('preserves text and tool_result ordering when building openai-compatible request messages', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
				OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
				OPENAI_COMPATIBLE_API_KEY: 'test-key',
			})

			try {
				let capturedBody: Record<string, unknown> | null = null
				restoreFetch(async (input, init) => {
					if (String(input) === 'https://example.test/v1/chat/completions') {
						capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
						return Response.json({
							id: 'chatcmpl-openai-compatible-ordered',
							model: 'gpt-5.4-mini',
							choices: [
								{
									finish_reason: 'stop',
									message: {
										content: 'ordered',
									},
								},
							],
							usage: {
								prompt_tokens: 12,
								completion_tokens: 4,
								total_tokens: 16,
							},
						})
					}
					throw new Error(`unexpected endpoint: ${String(input)}`)
				})

				const { app } = createApp()
				const response = await app.fetch(
					new Request('http://127.0.0.1:3000/v1/messages', {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							model: 'openai-compatible/gpt-5.4-mini',
							max_tokens: 128,
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
										{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool output' },
										{ type: 'text', text: 'after' },
									],
								},
							],
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
						}),
					}),
				)

				expect(response.status).toBe(200)
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
			} finally {
				restore()
			}
		})

		test('routes skill policy to openai-compatible without changing legacy defaults', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
			PROVIDER_ROUTING_JSON: JSON.stringify({
				skillPolicies: {
					review: 'openai-compatible/gpt-5.4-mini',
				},
			}),
		})

		try {
			let callCount = 0
			restoreFetch(async (input) => {
				if (String(input) === 'https://example.test/v1/chat/completions') {
					callCount += 1
					return Response.json({
						id: 'chatcmpl-openai-compatible-2',
						model: 'gpt-5.4-mini',
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'skill policy가 openai-compatible로 라우팅되었습니다.',
								},
							},
						],
						usage: {
							prompt_tokens: 9,
							completion_tokens: 8,
							total_tokens: 17,
						},
					})
				}
				throw new Error(`unexpected endpoint: ${String(input)}`)
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-5-20250929',
						max_tokens: 128,
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
									},
									required: ['skill'],
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
										id: 'toolu_skill_review',
										name: 'Skill',
										input: {
											skill: 'review',
										},
									},
								],
							},
							{
								role: 'user',
								content: '이어서 답해줘',
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				model: string
				content: Array<{ type: string; text?: string }>
			}

			expect(response.status).toBe(200)
			expect(callCount).toBe(1)
			expect(payload.model).toBe('claude-sonnet-4-5-20250929')
			expect(payload.content[0]?.text).toBe(
				'skill policy가 openai-compatible로 라우팅되었습니다.',
			)
			} finally {
				restore()
			}
		})

		test('returns a controlled 502 when openai-compatible returns malformed tool arguments', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
				OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
				OPENAI_COMPATIBLE_API_KEY: 'test-key',
			})

			try {
				restoreFetch(async (input) => {
					if (String(input) === 'https://example.test/v1/chat/completions') {
						return Response.json({
							id: 'chatcmpl-openai-compatible-bad-tool-args',
							model: 'gpt-5.4-mini',
							choices: [
								{
									finish_reason: 'tool_calls',
									message: {
										tool_calls: [
											{
												id: 'call_bad_args',
												type: 'function',
												function: {
													name: 'Read',
													arguments: '{"file_path":',
												},
											},
										],
									},
								},
							],
						})
					}
					throw new Error(`unexpected endpoint: ${String(input)}`)
				})

				const { app } = createApp()
				const response = await app.fetch(
					new Request('http://127.0.0.1:3000/v1/messages', {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							model: 'openai-compatible/gpt-5.4-mini',
							max_tokens: 128,
							messages: [{ role: 'user', content: 'read this file' }],
						}),
					}),
				)
				const payload = (await response.json()) as {
					error?: { message?: string; raw_message?: string | null }
				}

				expect(response.status).toBe(502)
				expect(payload.error?.message).toBe('failed to execute message')
				expect(payload.error?.raw_message).toContain('invalid JSON arguments')
			} finally {
				restore()
			}
		})

		test('applies OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS to openai-compatible fetches', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
				OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
				OPENAI_COMPATIBLE_API_KEY: 'test-key',
				OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS: '1000',
			})

			try {
				restoreFetch(async (_input, init) => {
					const signal = init?.signal
					return await new Promise<Response>((_resolve, reject) => {
						if (!(signal instanceof AbortSignal)) {
							reject(new Error('missing abort signal'))
							return
						}
						if (signal.aborted) {
							reject(signal.reason)
							return
						}
						signal.addEventListener(
							'abort',
							() => reject(signal.reason),
							{ once: true },
						)
					})
				})

				const { app } = createApp()
				const response = await app.fetch(
					new Request('http://127.0.0.1:3000/v1/messages', {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							model: 'openai-compatible/gpt-5.4-mini',
							max_tokens: 128,
							messages: [{ role: 'user', content: '짧게 답해줘' }],
						}),
					}),
				)
				const payload = (await response.json()) as {
					error?: { message?: string; raw_message?: string | null }
				}

				expect(response.status).toBe(502)
				expect(payload.error?.message).toBe('failed to execute message')
				expect(payload.error?.raw_message).toContain('1000ms')
			} finally {
				restore()
			}
		})

		test('returns a controlled 502 when openai-compatible streaming is requested', async () => {
			const restore = restoreEnv({
				BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async () => {
				throw new Error('stream setup should fail before any upstream fetch')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'openai-compatible/gpt-5.4-mini',
						max_tokens: 128,
						stream: true,
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				error?: { message?: string; raw_message?: string | null }
			}

			expect(response.status).toBe(502)
			expect(payload.error?.message).toBe('failed to start stream')
			expect(payload.error?.raw_message).toContain(
				'openai-compatible streaming is not implemented yet',
			)
		} finally {
			restore()
		}
	})

	test('returns a provider routing error when the resolved provider is unavailable', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			PROVIDER_ROUTING_JSON: JSON.stringify({
				aliases: {
					fast: 'openai-compatible/gpt-5.4-mini',
				},
			}),
		})

		try {
			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'fast',
						max_tokens: 128,
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				error?: { message?: string; raw_message?: string | null }
			}

			expect(response.status).toBe(502)
			expect(payload.error?.message).toBe('failed to resolve provider route')
			expect(payload.error?.raw_message).toContain("provider 'openai-compatible' is not available")
		} finally {
			restore()
		}
	})

	test('does not re-route after a prior Skill tool_use already exists in the conversation', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			let providerCalls = 0
			restoreFetch(async () => {
				providerCalls += 1
				return Response.json(readJsonFixture('08-openai-chat-response.json'))
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						messages: [
							{
								role: 'assistant',
								content: [
									{
										type: 'tool_use',
										id: 'toolu_existing',
										name: 'Skill',
										input: {
											skill: 'moonshot-phase-runner',
											args: 'docs/implementation/00-master-plan-v1.md 개발 진행',
										},
									},
								],
							},
							{
								role: 'user',
								content:
									'Base directory for this skill: /tmp/skill\n\n# Moonshot Phase Runner\n\n## Usage\n/moonshot-phase-runner docs/implementation/00-master-plan-v1.md 개발 진행',
							},
						],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('end_turn')
			expect(providerCalls).toBe(1)
		} finally {
			restore()
		}
	})

	test('does not treat loaded skill body text as a fresh slash command', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			let providerCalls = 0
			restoreFetch(async () => {
				providerCalls += 1
				return Response.json(readJsonFixture('08-openai-chat-response.json'))
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						messages: [
							{
								role: 'user',
								content:
									'Base directory for this skill: /tmp/skill\n\n# Moonshot Phase Runner\n\n## Usage\n/moonshot-phase-runner [<plan-dir>] [--autonomous] [--execution-mode <mode>] [--prepare-only]',
							},
						],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('end_turn')
			expect(providerCalls).toBe(1)
		} finally {
			restore()
		}
	})

	test('streams ollama events without thinking output', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					const chunkLines = [
						'{"model":"qwen3.5:27b","message":{"content":"안녕하세요","thinking":"internal"},"done":false}',
						'{"model":"qwen3.5:27b","message":{"content":"!","thinking":"next"},"done":true,"done_reason":"stop"}',
					]
					return new Response(createMockReadableStream(chunkLines), {
						headers: {
							'content-type': 'application/json',
						},
					})
				}
				throw new Error('unexpected endpoint')
			})

			const { app, config } = createApp()
			const requestBody = {
				model: 'qwen3.5:27b',
				max_tokens: 128,
				stream: true,
				messages: [{ role: 'user', content: '인사말만' }],
			}
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify(requestBody),
				}),
			)
			const payload = await response.text()

			expect(config.bridgeBackend).toBe('ollama')
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('text/event-stream')
			expect(payload).toContain('event: message_start')
			expect(payload).toContain('event: content_block_start')
			expect(payload).toContain('event: content_block_delta')
			expect(payload).toContain('안녕하세요')
			expect(payload).toContain('!')
			expect(payload).toContain('event: message_delta')
			expect(payload).toContain('event: message_stop')
			expect(payload).not.toContain('internal')
			expect(payload).not.toContain('next')
		} finally {
			restore()
		}
	})

	test('streams explicit slash command as Skill tool_use without provider call', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			restoreFetch(async () => {
				throw new Error('provider should not be called for direct skill routing')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						stream: true,
						messages: [{ role: 'user', content: '/moonshot-phase-runner docs/implementation/ 개발 진행' }],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = await response.text()

			expect(response.status).toBe(200)
			expect(payload).toContain('event: content_block_start')
			expect(payload).toContain('"type":"tool_use"')
			expect(payload).toContain('"name":"Skill"')
			expect(payload).toContain('"skill":"moonshot-phase-runner"')
			expect(payload).toContain('docs/implementation/ 개발 진행')
			expect(payload).toContain('"stop_reason":"tool_use"')
		} finally {
			restore()
		}
	})

	test('routes slash command embedded later in a user message to Skill tool', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			restoreFetch(async () => {
				throw new Error('provider should not be called for embedded slash-command routing')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						messages: [
							{
								role: 'user',
								content:
									'<system-reminder>skill already loaded</system-reminder>\n/moonshot-phase-runner docs/implementation/00-master-plan-v1.md 개발 진행',
							},
						],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
				content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('tool_use')
			expect(payload.content[0]).toMatchObject({
				type: 'tool_use',
				name: 'Skill',
				input: {
					skill: 'moonshot-phase-runner',
					args: 'docs/implementation/00-master-plan-v1.md 개발 진행',
				},
			})
		} finally {
			restore()
		}
	})

	test('routes command-name tag to Skill tool when slash line is absent', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
		})

		try {
			restoreFetch(async () => {
				throw new Error('provider should not be called for command-name routing')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'claude-sonnet-4-6',
						max_tokens: 256,
						messages: [
							{
								role: 'user',
								content:
									'<command-name>moonshot-phase-runner</command-name>\nMoonshot Phase Runner skill instructions...',
							},
						],
						tools: [
							{
								name: 'Skill',
								description: 'Execute a skill',
								input_schema: {
									type: 'object',
									properties: {
										skill: { type: 'string' },
										args: { type: 'string' },
									},
									required: ['skill'],
									additionalProperties: false,
								},
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				stop_reason: string
				content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
			}

			expect(response.status).toBe(200)
			expect(payload.stop_reason).toBe('tool_use')
			expect(payload.content[0]).toMatchObject({
				type: 'tool_use',
				name: 'Skill',
				input: {
					skill: 'moonshot-phase-runner',
				},
			})
		} finally {
			restore()
		}
	})

	test('streams SSE-wrapped OpenAI events via ollama route', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					const chunkLines = [
						'event: message',
						'data: {"id":"chatcmpl-04","object":"chat.completion.chunk","created":1770000004,"model":"qwen3.5:27b","choices":[{"index":0,"delta":{"content":"하나"},"finish_reason":null}]}',
						'',
						'data: {"id":"chatcmpl-04","object":"chat.completion.chunk","created":1770000004,"model":"qwen3.5:27b","choices":[{"index":0,"delta":{"content":" 둘"},"finish_reason":"stop"}]}',
						'',
						'data: [DONE]',
					]
					return new Response(createMockReadableStream(chunkLines), {
						headers: {
							'content-type': 'text/event-stream',
						},
					})
				}
				throw new Error('unexpected endpoint')
			})

			const { app, config } = createApp()
			const requestBody = {
				model: 'qwen3.5:27b',
				max_tokens: 128,
				stream: true,
				messages: [{ role: 'user', content: '두 단어만' }],
			}
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify(requestBody),
				}),
			)
			const payload = await response.text()

			expect(config.bridgeBackend).toBe('ollama')
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('text/event-stream')
			expect(payload).toContain('event: content_block_start')
			expect(payload).toContain('하나')
			expect(payload).toContain(' 둘')
			expect(payload).toContain('event: message_delta')
			expect(payload).toContain('event: message_stop')
		} finally {
			restore()
		}
	})

	test('keeps exposed model id in streamed message_start when provider-qualified routing is used', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'ollama',
			OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
			OLLAMA_MODEL: 'qwen3.5:27b',
			OLLAMA_SHOW_THINKING: 'false',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input).includes('/api/chat')) {
					const chunkLines = [
						'{"model":"qwen3.5:27b","message":{"content":"안녕하세요"},"done":false}',
						'{"model":"qwen3.5:27b","message":{"content":"!"},"done":true,"done_reason":"stop"}',
					]
					return new Response(createMockReadableStream(chunkLines), {
						headers: {
							'content-type': 'application/json',
						},
					})
				}
				throw new Error('unexpected endpoint')
			})

			const { app } = createApp()
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'ollama/qwen3.5:27b',
						max_tokens: 128,
						stream: true,
						messages: [{ role: 'user', content: '인사말만' }],
					}),
				}),
			)
			const payload = await response.text()

			expect(response.status).toBe(200)
			expect(payload).toContain('"model":"ollama/qwen3.5:27b"')
			expect(payload).not.toContain('"model":"qwen3.5:27b","content"')
		} finally {
			restore()
		}
	})
})
