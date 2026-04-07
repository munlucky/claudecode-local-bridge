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
})
