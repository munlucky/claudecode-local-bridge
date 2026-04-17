import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import './app.routes.providers.test.js'
import './app.routes.streaming.test.js'
import {
	createRouteTestHarness,
	readJsonFixture,
} from './app.routes.helpers.js'

const {
	createApp,
	restoreEnv,
	restoreFetch,
	restoreOriginalFetch,
} = createRouteTestHarness()

describe('Ollama router integration', () => {
	afterEach(() => {
		restoreOriginalFetch()
	})

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
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
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
					}),
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

	test('includes enabled codex-direct models in /v1/models with provider-qualified ids', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
			CODEX_DIRECT_AUTH_MODE: 'api_key',
			CODEX_OPENAI_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async () => {
				throw new Error('codex-direct model listing should not call the upstream backend')
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
						id: 'codex-direct/claude-sonnet-4-5-20250929',
						name: 'codex-direct/claude-sonnet-4-5-20250929',
						type: 'model',
					},
				]),
			)
		} finally {
			restore()
		}
	})

	test('keeps /health on codex-app-server while codex-direct remains in shadow rollout', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
			CODEX_AUTH_MODE: 'disabled',
		})

		try {
			const { app } = createApp()
			const response = await app.fetch(new Request('http://127.0.0.1:3000/health'))
			const payload = (await response.json()) as {
				backend: string
				auth_mode: string
				readiness: string
				codex_direct_rollout?: string
			}

			expect(response.status).toBe(200)
			expect(payload.backend).toBe('codex_app_server')
			expect(payload.auth_mode).toBe('disabled')
			expect(payload.readiness).toBe('ready')
			expect(payload).not.toHaveProperty('codex_direct_rollout')
		} finally {
			restore()
		}
	})

	test('returns codex-direct health metadata when prefer-direct rollout is active', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'prefer-direct',
			CODEX_DIRECT_AUTH_MODE: 'api_key',
			CODEX_OPENAI_API_KEY: 'test-key',
			CODEX_DIRECT_BASE_URL: 'https://example.test/v1',
		})

		try {
			const { app } = createApp()
			const response = await app.fetch(new Request('http://127.0.0.1:3000/health'))
			const payload = (await response.json()) as {
				backend: string
				auth_mode: string
				readiness: string
				has_auth_mode_dependency: boolean
				codex_direct_rollout: string
				codex_direct_base_url: string | null
			}

			expect(response.status).toBe(200)
			expect(payload.backend).toBe('codex_direct_api')
			expect(payload.auth_mode).toBe('api_key')
			expect(payload.readiness).toBe('ready')
			expect(payload.has_auth_mode_dependency).toBe(true)
			expect(payload.codex_direct_rollout).toBe('prefer-direct')
			expect(payload.codex_direct_base_url).toBe('https://example.test/v1')
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

	test('routes explicit codex-direct model ids through the direct provider', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
			CODEX_DIRECT_AUTH_MODE: 'api_key',
			CODEX_OPENAI_API_KEY: 'test-key',
			CODEX_DIRECT_BASE_URL: 'https://example.test/backend-api/codex',
		})

		try {
			let capturedHeaders: Headers | null = null
			let capturedBody: Record<string, unknown> | null = null
			restoreFetch(async (input, init) => {
				if (String(input) === 'https://example.test/backend-api/codex/responses') {
					capturedHeaders = new Headers(init?.headers)
					capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
					return Response.json({
						id: 'resp-codex-direct-1',
						model: 'gpt-5.4-mini',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: 'codex-direct 경로 응답입니다.' }],
							},
						],
						usage: {
							input_tokens: 12,
							output_tokens: 7,
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
						model: 'codex-direct/gpt-5.4-mini',
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
			expect(capturedHeaders?.get('authorization')).toBe('Bearer test-key')
			expect(Array.isArray(capturedBody?.input)).toBe(true)
			expect(payload.model).toBe('codex-direct/gpt-5.4-mini')
			expect(payload.content[0]).toEqual({
				type: 'text',
				text: 'codex-direct 경로 응답입니다.',
			})
		} finally {
			restore()
		}
	})

	test('keeps prefer-direct health ready when oauth state is refreshable', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'prefer-direct',
			CODEX_DIRECT_AUTH_MODE: 'oauth',
			CODEX_DIRECT_AUTH_STATE_FILE: join(process.cwd(), '.tmp-codex-direct-auth.json'),
		})

		try {
			await Bun.write(
				join(process.cwd(), '.tmp-codex-direct-auth.json'),
				JSON.stringify({
					authType: 'oauth',
					accessToken: 'expired-token',
					refreshToken: 'refresh-token',
					expiresAt: '2000-01-01T00:00:00.000Z',
				}),
			)

			const { app } = createApp()
			const response = await app.fetch(new Request('http://127.0.0.1:3000/health'))
			const payload = (await response.json()) as {
				backend: string
				readiness: string
				codex_direct_auth_state: string
			}

			expect(response.status).toBe(200)
			expect(payload.backend).toBe('codex_direct_api')
			expect(payload.readiness).toBe('ready')
			expect(payload.codex_direct_auth_state).toBe('refreshable')
		} finally {
			rmSync(join(process.cwd(), '.tmp-codex-direct-auth.json'), { force: true })
			restore()
		}
	})
})
