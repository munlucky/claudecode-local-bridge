import { describe, expect, test } from 'bun:test'
import {
	createMockReadableStream,
	createRouteTestHarness,
	readJsonFixture,
} from './app.routes.helpers.js'

const { createApp, restoreEnv, restoreFetch } = createRouteTestHarness()

describe('Ollama router integration streaming and skill flows', () => {
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
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'qwen3.5:27b',
						max_tokens: 128,
						stream: true,
						messages: [{ role: 'user', content: '인사말만' }],
					}),
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
			const response = await app.fetch(
				new Request('http://127.0.0.1:3000/v1/messages', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: 'qwen3.5:27b',
						max_tokens: 128,
						stream: true,
						messages: [{ role: 'user', content: '두 단어만' }],
					}),
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
