import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type RouterConfig } from '../../../src/server/index.js'
import { listOllamaModels, mapToolCallsToAnthropicContent, runOllamaTurn, streamOllamaTurn } from '../../../src/bridge/ollama/index.js'

function readJsonFixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ollama', name), 'utf8')) as T
}

function createOllamaConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
	const config = loadConfig()
	return {
		...config,
		bridgeBackend: 'ollama',
		ollamaBaseUrl: 'http://127.0.0.1:11434',
		ollamaModel: 'qwen3.5:27b',
		ollamaRequestTimeoutMs: 120000,
		ollamaShowThinking: false,
		...overrides,
	}
}

async function collectStreamPayload(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let payload = ''

	while (true) {
		const chunk = await reader.read()
		if (chunk.done) {
			break
		}
		if (chunk.value) {
			payload += decoder.decode(chunk.value, { stream: true })
		}
	}

	payload += decoder.decode()
	return payload
}

const fixtureApiTags = readJsonFixture<{
	models: Array<{ model?: string; name?: string }>
}>('01-api-tags.json')

const fixtureChatResponse = readJsonFixture<{
	model: string
	message: { content: string; thinking?: string; tool_calls?: unknown[] }
	done_reason?: string
	prompt_eval_count?: number
	eval_count?: number
}>('03-chat-response.json')

const fixtureToolChatResponse = readJsonFixture<{
	message: { tool_calls?: unknown[]; content: string }
	done_reason?: string
}>('05-tool-chat-response.json')

const baseRequest = {
	model: 'qwen3.5:27b',
	max_tokens: 256,
	messages: [{ role: 'user' as const, content: '서울 날씨 알려줘' }],
	tools: [
		{
			name: 'get_weather',
			description: 'Get current weather for a city',
			input_schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					city: { type: 'string' },
				},
				required: ['city'],
			},
		},
	],
	tool_choice: 'any' as const,
}

describe('Ollama provider mapping', () => {
	const originalFetch = global.fetch
	afterEach(() => {
		global.fetch = originalFetch
	})

	test('lists models from /api/tags and normalizes payload', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/tags')) {
				return Response.json(fixtureApiTags)
			}
			throw new Error('unexpected endpoint')
		}

		const models = await listOllamaModels(createOllamaConfig())

		expect(models.length).toBeGreaterThan(0)
		expect(models.some((entry) => entry.model === 'qwen3.5:27b')).toBe(true)
	})

	test('maps non-stream chat response to Anthropic text content', async () => {
		let sentBody: unknown = null
		global.fetch = async (input, init) => {
			if (String(input).includes('/api/chat')) {
				sentBody = init?.body ? JSON.parse(String(init.body)) : null
				return Response.json(fixtureChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '짧게 자기소개' }],
		})

		expect(response.response.stop_reason).toBe('end_turn')
		expect(response.response.content[0].type).toBe('text')
		expect((response.response.content[0] as { text: string }).text).toContain('안녕하세요')
		expect((sentBody as { model: string }).model).toBe('qwen3.5:27b')
	})

	test('maps tool_calls into Anthropic tool_use blocks when request has tools', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json(fixtureToolChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), baseRequest)

		expect(response.response.stop_reason).toBe('tool_use')
		expect(response.response.content).toEqual([
			{
				type: 'tool_use',
				id: 'call_c9j2d4de',
				name: 'get_weather',
				input: { city: '서울' },
			},
		])
	})

	test('normalizes tool_choice any to ollama auto', async () => {
		let sentBody: { tool_choice?: unknown } | null = null
		global.fetch = async (input, init) => {
			if (String(input).includes('/api/chat')) {
				sentBody = init?.body ? (JSON.parse(String(init.body)) as { tool_choice?: unknown }) : null
				return Response.json(fixtureChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		await runOllamaTurn(createOllamaConfig(), baseRequest)
		expect(sentBody?.tool_choice).toBe('auto')
	})

	test('maps raw tool_calls into Anthropic tool_use content blocks', () => {
		const mapped = mapToolCallsToAnthropicContent([
			{
				id: 'call_c9j2d4de',
				function: {
					name: 'get_weather',
					arguments: { city: '서울' },
				},
			},
		])

		expect(mapped).toEqual([
			{
				type: 'tool_use',
				id: 'call_c9j2d4de',
				name: 'get_weather',
				input: { city: '서울' },
			},
		])
	})

	test('adapts stream chunks into Anthropic SSE events and hides thinking by default', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const lines = [
					'{"model":"qwen3.5:27b","message":{"content":"안녕하세요","thinking":"기본 분석"},"done":false}',
					'{"model":"qwen3.5:27b","message":{"content":"!","thinking":"완료"},"done":true,"done_reason":"stop"}',
				].join('\n')
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(lines))
						controller.close()
					},
				})
				return new Response(body)
			}
			throw new Error('unexpected endpoint')
		}

		const stream = streamOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			stream: true,
			messages: [{ role: 'user', content: '인사말만' }],
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('event: message_start')
		expect(payload).toContain('event: content_block_start')
		expect(payload).toContain('event: content_block_delta')
		expect(payload).toContain('안녕하세요')
		expect(payload).toContain('!')
		expect(payload).toContain('event: message_delta')
		expect(payload).toContain('event: message_stop')
		expect(payload).not.toContain('기본 분석')
		expect(payload).not.toContain('완료')
	})

	test('keeps tool_use stream mapping when tool_calls arrive', async () => {
		const toolStreamLines = [
			'{"model":"qwen3.5:27b","message":{"content":"","tool_calls":[{"id":"call_abc","function":{"name":"search","arguments":{"query":"test"}}]},"done":false}',
			'{"model":"qwen3.5:27b","message":{"content":"","done":true},"done":true,"done_reason":"tool_calls"}',
		].join('\n')

		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(toolStreamLines))
						controller.close()
					},
				})
				return new Response(body)
			}
			throw new Error('unexpected endpoint')
		}

		const stream = streamOllamaTurn(createOllamaConfig(), {
			...baseRequest,
			stream: true,
			max_tokens: 128,
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('event: message_start')
		expect(payload).toContain('event: message_delta')
		expect(payload).toContain('event: message_stop')
		expect(payload).toContain('"stop_reason":"tool_use"')
	})
})
