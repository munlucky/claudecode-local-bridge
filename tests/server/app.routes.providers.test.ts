import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	createMockReadableStream,
	createRouteTestHarness,
} from './app.routes.helpers.js'

const { createApp, restoreEnv, restoreFetch } = createRouteTestHarness()
const tempAuthStateFile = join(process.cwd(), '.tmp-codex-direct-route-auth.json')

describe('Ollama router integration provider routing', () => {
	afterEach(() => {
		rmSync(tempAuthStateFile, { force: true })
	})

	test('includes upstream error previews for codex-direct non-stream failures', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
			CODEX_DIRECT_AUTH_MODE: 'api_key',
			CODEX_OPENAI_API_KEY: 'test-key',
			CODEX_DIRECT_BASE_URL: 'https://example.test/backend-api/codex',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input) === 'https://example.test/backend-api/codex/responses') {
					return Response.json(
						{
							error: {
								message: 'direct backend rejected the request payload',
							},
						},
						{
							status: 401,
							headers: {
								'x-request-id': 'req_codex_direct_123',
							},
						},
					)
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
				error?: { message?: string; raw_message?: string | null }
			}

			expect(response.status).toBe(502)
			expect(payload.error?.message).toBe('failed to execute message')
			expect(payload.error?.raw_message).toContain(
				'codex-direct request failed with status 401',
			)
			expect(payload.error?.raw_message).toContain(
				'direct backend rejected the request payload',
			)
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

	test('rejects Anthropic thinking on openai-compatible non-stream requests before upstream fetch', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async () => {
				throw new Error('upstream fetch should not run for unsupported thinking requests')
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
						thinking: {
							type: 'enabled',
							budget_tokens: 64,
						},
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				error?: { message?: string }
			}

			expect(response.status).toBe(422)
			expect(payload.error?.message).toContain(
				"provider 'openai-compatible' does not support Anthropic thinking",
			)
		} finally {
			restore()
		}
	})

	test('rejects image content on openai-compatible non-stream requests before upstream fetch', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async () => {
				throw new Error('upstream fetch should not run for unsupported image requests')
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
								role: 'user',
								content: [
									{
										type: 'image',
										source: {
											type: 'base64',
											media_type: 'image/png',
											data: 'aGVsbG8=',
										},
									},
								],
							},
						],
					}),
				}),
			)
			const payload = (await response.json()) as {
				error?: { message?: string }
			}

			expect(response.status).toBe(422)
			expect(payload.error?.message).toContain(
				"provider 'openai-compatible' does not support image content",
			)
		} finally {
			restore()
		}
	})

	test('includes upstream error previews for openai-compatible non-stream failures', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			OPENAI_COMPATIBLE_BASE_URL: 'https://example.test',
			OPENAI_COMPATIBLE_API_KEY: 'test-key',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input) === 'https://example.test/v1/chat/completions') {
					return Response.json(
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
					)
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
				error?: { message?: string; raw_message?: string | null }
			}

			expect(response.status).toBe(502)
			expect(payload.error?.message).toBe('failed to execute message')
			expect(payload.error?.raw_message).toContain(
				'openai-compatible request failed with status 400',
			)
			expect(payload.error?.raw_message).toContain(
				'provider rejected the request payload',
			)
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
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
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

	test('streams codex-direct responses as Anthropic SSE events', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'shadow',
			CODEX_DIRECT_AUTH_MODE: 'api_key',
			CODEX_OPENAI_API_KEY: 'test-key',
			CODEX_DIRECT_BASE_URL: 'https://example.test/v1',
		})

		try {
			restoreFetch(async (input) => {
				if (String(input) === 'https://example.test/v1/responses') {
					const chunkLines = [
						'event: response.output_text.delta',
						'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"안녕하세요"}',
						'',
						'event: response.completed',
						'data: {"type":"response.completed","response":{"id":"resp_codex_direct_stream_1","model":"gpt-5.4-mini","output":[],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
						'',
						'data: [DONE]',
					]
					return new Response(createMockReadableStream(chunkLines), {
						headers: {
							'content-type': 'text/event-stream',
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
						stream: true,
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = await response.text()

			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('text/event-stream')
			expect(payload).toContain('event: message_start')
			expect(payload).toContain('event: content_block_start')
			expect(payload).toContain('event: content_block_delta')
			expect(payload).toContain('안녕하세요')
			expect(payload).toContain('event: message_delta')
			expect(payload).toContain('"stop_reason":"end_turn"')
			expect(payload).toContain('event: message_stop')
		} finally {
			restore()
		}
	})

	test('refreshes expired codex-direct oauth state through the route and persists the new tokens', async () => {
		const restore = restoreEnv({
			BRIDGE_BACKEND: 'codex',
			CODEX_DIRECT_ENABLED: '1',
			CODEX_DIRECT_ROLLOUT: 'prefer-direct',
			CODEX_DIRECT_AUTH_MODE: 'oauth',
			CODEX_DIRECT_AUTH_STATE_FILE: tempAuthStateFile,
			CODEX_DIRECT_BASE_URL: 'https://example.test/backend-api/codex',
		})

		writeFileSync(
			tempAuthStateFile,
			JSON.stringify({
				authType: 'oauth',
				accessToken: 'expired-token',
				refreshToken: 'refresh-token',
				expiresAt: '2000-01-01T00:00:00.000Z',
				accountId: 'acct_before',
			}),
		)

		try {
			restoreFetch(async (input) => {
				if (String(input) === 'https://auth.openai.com/oauth/token') {
					return Response.json({
						access_token: 'fresh-token',
						refresh_token: 'fresh-refresh-token',
						expires_in: 3600,
						id_token: 'header.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0X2FmdGVyIn0.signature',
					})
				}

				if (String(input) === 'https://example.test/backend-api/codex/responses') {
					return Response.json({
						id: 'resp_direct_refresh_1',
						model: 'gpt-5.4-mini',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: 'refresh ok' }],
							},
						],
						usage: {
							input_tokens: 9,
							output_tokens: 2,
							total_tokens: 11,
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
						messages: [{ role: 'user', content: '짧게 답해줘' }],
					}),
				}),
			)
			const payload = (await response.json()) as {
				content: Array<{ type: string; text?: string }>
			}
			const persisted = JSON.parse(readFileSync(tempAuthStateFile, 'utf8')) as {
				accessToken: string
				refreshToken: string
				accountId: string
			}

			expect(response.status).toBe(200)
			expect(payload.content).toEqual([{ type: 'text', text: 'refresh ok' }])
			expect(persisted.accessToken).toBe('fresh-token')
			expect(persisted.refreshToken).toBe('fresh-refresh-token')
			expect(persisted.accountId).toBe('acct_after')
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
})
