import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type RouterConfig } from '../../../src/server/index.js'
import {
	buildOllamaRequestBody,
	listOllamaModels,
	mapToolCallsToAnthropicContent,
	runOllamaTurn,
	streamOllamaTurn,
} from '../../../src/bridge/ollama/index.js'

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

const fixtureOpenAIChatResponse = readJsonFixture<{
	choices: Array<{
		message: {
			content: string
		}
		finish_reason?: string
	}>
}>('08-openai-chat-response.json')

const fixtureOpenAIToolChatResponse = readJsonFixture<{
	choices: Array<{
		message: {
			content: string
			tool_calls?: unknown[]
		}
		finish_reason?: string
	}>
}>('09-openai-tool-chat-response.json')

const fixtureOpenAIUsageResponse = readJsonFixture<{
	choices: Array<{
		message: {
			content: string
		}
		finish_reason?: string
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		total_tokens?: number
	}
}>('11-openai-usage-response.json')

const fixtureOpenAIStreamChunks = readFileSync(
	join(process.cwd(), 'tests', 'fixtures', 'ollama', '10-openai-stream-chunks.txt'),
	'utf8',
).trim()

const fixtureOpenAISseStreamChunks = readFileSync(
	join(process.cwd(), 'tests', 'fixtures', 'ollama', '12-openai-sse-stream-chunks.txt'),
	'utf8',
).trim()

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

	test('does not reuse CODEX model aliases when resolving Ollama requests', async () => {
		const originalCodeModel = process.env.CODEX_MODEL_SONNET
		process.env.CODEX_MODEL_SONNET = 'gpt-5.4'

		let sentBody: unknown = null
		global.fetch = async (input, init) => {
			if (String(input).includes('/api/chat')) {
				sentBody = init?.body ? JSON.parse(String(init.body)) : null
				return Response.json(fixtureChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		try {
			await runOllamaTurn(createOllamaConfig(), {
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 128,
				messages: [{ role: 'user', content: '짧게 자기소개' }],
			})
		} finally {
			if (originalCodeModel === undefined) {
				delete process.env.CODEX_MODEL_SONNET
			} else {
				process.env.CODEX_MODEL_SONNET = originalCodeModel
			}
		}

		expect((sentBody as { model: string }).model).toBe('qwen3.5:27b')
	})

	test('uses OLLAMA model aliases independently from CODEX aliases', async () => {
		let sentBody: unknown = null
		global.fetch = async (input, init) => {
			if (String(input).includes('/api/chat')) {
				sentBody = init?.body ? JSON.parse(String(init.body)) : null
				return Response.json(fixtureChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		await runOllamaTurn(
			createOllamaConfig({
				ollamaModelAliases: {
					'claude-sonnet-4-5-20250929': 'qwen3.5:32b',
				},
			}),
			{
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 128,
				messages: [{ role: 'user', content: '짧게 자기소개' }],
			},
		)

		expect((sentBody as { model: string }).model).toBe('qwen3.5:32b')
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

	test('maps OpenAI-style non-stream chat message into Anthropic content', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json(fixtureOpenAIChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '한 줄로 자기소개해줘' }],
		})

		expect(response.response.stop_reason).toBe('end_turn')
		expect(response.response.content[0].type).toBe('text')
		expect((response.response.content[0] as { text: string }).text).toContain('안녕하세요')
	})

	test('maps OpenAI-style non-stream tool_calls into Anthropic tool_use blocks', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json(fixtureOpenAIToolChatResponse)
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '수식 계산: 19 + 23' }],
			tools: [
				{
					name: 'add_numbers',
					description: '두 수의 합을 계산',
					input_schema: {
						type: 'object',
						properties: {
							a: { type: 'number' },
							b: { type: 'number' },
						},
						required: ['a', 'b'],
						additionalProperties: false,
					},
				},
			],
			tool_choice: {
				type: 'function',
				function: {
					name: 'add_numbers',
				},
			},
		})

		expect(response.response.stop_reason).toBe('tool_use')
		expect(response.response.content).toEqual([
			{
				type: 'tool_use',
				id: 'call_openai_add_numbers',
				name: 'add_numbers',
				input: { a: 19, b: 23 },
			},
		])
	})

	test('maps faux bracket tool_use text into Anthropic tool_use blocks', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json({
					model: 'qwen3.5:27b',
					choices: [
						{
							message: {
								content: '[tool_use name=Read args={"file_path":"/tmp/demo.txt"}]',
							},
							finish_reason: 'stop',
						},
					],
				})
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '마스터 플랜 읽어줘' }],
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
		})

		expect(response.response.stop_reason).toBe('tool_use')
		expect(response.response.content).toEqual([
			{
				type: 'tool_use',
				id: expect.stringMatching(/^call_/),
				name: 'Read',
				input: { file_path: '/tmp/demo.txt' },
			},
		])
	})

	test('does not promote faux bracket tool_use text when required args are missing', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json({
					model: 'qwen3.5:27b',
					choices: [
						{
							message: {
								content: '[tool_use name=Read args={}]',
							},
							finish_reason: 'stop',
						},
					],
				})
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '플랜 읽어줘' }],
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
		})

		expect(response.response.stop_reason).toBe('end_turn')
		expect(response.response.content).toEqual([
			{
				type: 'text',
				text: '[tool_use name=Read args={}]',
			},
		])
	})

	test('does not map native tool_calls when required args are missing', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json({
					model: 'qwen3.5:27b',
					message: {
						content: '',
						tool_calls: [
							{
								id: 'call_missing_read_args',
								function: {
									name: 'Read',
									arguments: {},
								},
							},
						],
					},
					done: true,
					done_reason: 'tool_calls',
				})
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '플랜 파일 읽어줘' }],
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
		})

		expect(response.response.stop_reason).toBe('end_turn')
		expect(response.response.content).toEqual([
			{
				type: 'text',
				text: '',
			},
		])
	})

	test('maps usage tokens from OpenAI-style usage.prompt_tokens/completion_tokens', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				return Response.json(fixtureOpenAIUsageResponse)
			}
			throw new Error('unexpected endpoint')
		}

		const response = await runOllamaTurn(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [{ role: 'user', content: '토큰 사용량 테스트' }],
		})

		expect(response.response.usage.input_tokens).toBe(12)
		expect(response.response.usage.output_tokens).toBe(34)
		expect(response.response.usage.total_tokens).toBe(46)
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

	test('does not serialize prior tool_use blocks as bracket text in request messages', () => {
		const body = buildOllamaRequestBody(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [
				{ role: 'user', content: '마스터 플랜 읽어줘' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_read_1',
							name: 'Read',
							input: { file_path: '/tmp/demo.txt' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_read_1',
							content: 'master plan contents',
						},
					],
				},
			],
		})

		expect(body.messages).toEqual([
			{ role: 'user', content: '마스터 플랜 읽어줘' },
			{ role: 'user', content: 'Tool result (toolu_read_1): master plan contents' },
		])
	})

	test('serializes tool_result arrays without bracket tool markers', () => {
		const body = buildOllamaRequestBody(createOllamaConfig(), {
			model: 'qwen3.5:27b',
			max_tokens: 128,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_read_1',
							content: [
								{ type: 'text', text: 'phase one summary' },
								{ type: 'text', text: 'phase two summary' },
							],
						},
					],
				},
			],
		})

		expect(body.messages).toEqual([
			{
				role: 'user',
				content: 'Tool result (toolu_read_1): phase one summary\nphase two summary',
			},
		])
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
			'{"model":"qwen3.5:27b","message":{"content":"","tool_calls":[{"id":"call_abc","function":{"name":"get_weather","arguments":{"city":"서울"}}}]},"done":false}',
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

	test('accumulates OpenAI-style stream tool_calls across delta chunks', async () => {
		const streamedToolCallLines = [
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\""}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"docs/implementation/00-master-plan-v1.md"}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]},"finish_reason":"tool_calls"}]}',
		].join('\n')

		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(streamedToolCallLines))
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
			messages: [{ role: 'user', content: '플랜 파일 읽어줘' }],
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
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('event: content_block_start')
		expect(payload).toContain('"type":"tool_use"')
		expect(payload).toContain('"name":"Read"')
		expect(payload).toContain('docs/implementation/00-master-plan-v1.md')
		expect(payload).toContain('"stop_reason":"tool_use"')
	})

	test('maps faux bracket tool_use stream text into Anthropic tool_use events', async () => {
		const fauxToolUseLines = [
			'{"choices":[{"delta":{"content":"["}}]}',
			'{"choices":[{"delta":{"content":"tool"}}]}',
			'{"choices":[{"delta":{"content":"_use name=Read args={\\"file_path\\":\\"/tmp/demo.txt\\"}]"},"finish_reason":"stop"}]}',
		].join('\n')

		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(fauxToolUseLines))
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
			messages: [{ role: 'user', content: '플랜 파일 읽어줘' }],
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
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('"type":"tool_use"')
		expect(payload).toContain('"name":"Read"')
		expect(payload).toContain('\\"file_path\\":\\"/tmp/demo.txt\\"')
		expect(payload).toContain('"stop_reason":"tool_use"')
		expect(payload).not.toContain('"type":"text_delta"')
	})

	test('does not promote faux bracket tool_use stream text when required args are missing', async () => {
		const invalidFauxToolUseLines = [
			'{"choices":[{"delta":{"content":"["}}]}',
			'{"choices":[{"delta":{"content":"tool"}}]}',
			'{"choices":[{"delta":{"content":"_use name=Read args={}]"},"finish_reason":"stop"}]}',
		].join('\n')

		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(invalidFauxToolUseLines))
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
			messages: [{ role: 'user', content: '플랜 파일 읽어줘' }],
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
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('"type":"text_delta"')
		expect(payload).toContain('[tool_use name=Read args={}]')
		expect(payload).toContain('"stop_reason":"end_turn"')
		expect(payload).not.toContain('"type":"tool_use"')
	})

	test('does not map native tool_calls stream events when required args are missing', async () => {
		const invalidToolStreamLines = [
			'{"model":"qwen3.5:27b","message":{"content":"","tool_calls":[{"id":"call_missing_read_args","function":{"name":"Read","arguments":{}}}]},"done":false}',
			'{"model":"qwen3.5:27b","message":{"content":"","done":true},"done":true,"done_reason":"tool_calls"}',
		].join('\n')

		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(invalidToolStreamLines))
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
			messages: [{ role: 'user', content: '플랜 파일 읽어줘' }],
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
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('"stop_reason":"end_turn"')
		expect(payload).not.toContain('"type":"tool_use"')
	})

	test('maps OpenAI-style stream deltas into Anthropic SSE events', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(fixtureOpenAIStreamChunks))
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
			messages: [{ role: 'user', content: '인사만 해줘' }],
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('event: message_start')
		expect(payload).toContain('event: content_block_start')
		expect(payload).toContain('event: content_block_delta')
		expect(payload).toContain('text":"안"')
		expect(payload).toContain('text":"녕하세요"')
		expect(payload).toContain('event: message_delta')
		expect(payload).toContain('"stop_reason":"end_turn"')
		expect(payload).toContain('event: message_stop')
	})

	test('maps SSE-wrapped OpenAI stream lines into Anthropic SSE events', async () => {
		global.fetch = async (input) => {
			if (String(input).includes('/api/chat')) {
				const body = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(fixtureOpenAISseStreamChunks))
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
			messages: [{ role: 'user', content: '세 단어만 나열해줘' }],
		})
		const payload = await collectStreamPayload(stream)

		expect(payload).toContain('event: content_block_start')
		expect(payload).toContain('text":"하나"')
		expect(payload).toContain('text":" 둘"')
		expect(payload).toContain('text":" 셋"')
		expect(payload).toContain('"stop_reason":"end_turn"')
		expect(payload).toContain('event: message_stop')
	})
})
