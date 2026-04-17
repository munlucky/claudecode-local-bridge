import { describe, expect, test } from 'bun:test'
import {
	parseAnthropicSseToCanonicalStream,
	renderCanonicalStreamAsAnthropicSse,
} from '../../../src/bridge/anthropic/surface.js'
import type { CanonicalStreamEvent } from '../../../src/bridge/canonical/types.js'

async function collectText(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let output = ''

	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		output += decoder.decode(value, { stream: true })
	}

	output += decoder.decode()
	return output
}

async function collectEvents(stream: ReadableStream<CanonicalStreamEvent>) {
	const reader = stream.getReader()
	const events: CanonicalStreamEvent[] = []

	while (true) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		events.push(value)
	}

	return events
}

describe('Anthropic surface stream adapters', () => {
	test('parses Anthropic SSE into canonical events', async () => {
		const body = [
			'event: message_start',
			'data: {"type":"message_start","message":{"id":"msg_1","model":"qwen3.5:27b","usage":{"input_tokens":1,"output_tokens":0}}}',
			'',
			'event: content_block_start',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}',
			'',
			'event: content_block_stop',
			'data: {"type":"content_block_stop","index":0}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
			'',
			'event: message_stop',
			'data: {"type":"message_stop"}',
			'',
		].join('\n')

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body))
				controller.close()
			},
		})

		const events = await collectEvents(parseAnthropicSseToCanonicalStream(stream))
		expect(events).toEqual([
			{
				type: 'message_start',
				messageId: 'msg_1',
				model: 'qwen3.5:27b',
				usage: {
					inputTokens: 1,
					outputTokens: 0,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 1,
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
					text: '안녕',
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
					outputTokens: 2,
				},
			},
			{
				type: 'message_stop',
			},
		])
	})

	test('renders canonical events back to Anthropic SSE while overriding exposed model', async () => {
		const stream = new ReadableStream<CanonicalStreamEvent>({
			start(controller) {
				controller.enqueue({
					type: 'message_start',
					messageId: 'msg_2',
					model: 'qwen3.5:27b',
					usage: {
						inputTokens: 2,
						outputTokens: 0,
						cachedInputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 2,
					},
				})
				controller.enqueue({
					type: 'content_block_start',
					index: 0,
					contentBlock: {
						type: 'tool_use',
						id: 'toolu_1',
						name: 'Read',
						input: { file_path: '/tmp/demo.txt' },
					},
				})
				controller.enqueue({
					type: 'content_block_delta',
					index: 0,
					delta: {
						type: 'input_json_delta',
						partialJson: '{"file_path":"/tmp/demo.txt"}',
					},
				})
				controller.enqueue({
					type: 'content_block_stop',
					index: 0,
				})
				controller.enqueue({
					type: 'message_delta',
					stopReason: 'tool_use',
					stopSequence: null,
					usage: {
						outputTokens: 1,
					},
				})
				controller.enqueue({
					type: 'message_stop',
				})
				controller.close()
			},
		})

		const payload = await collectText(
			renderCanonicalStreamAsAnthropicSse(stream, {
				exposedModel: 'ollama/qwen3.5:27b',
			}),
		)

		expect(payload).toContain('event: message_start')
		expect(payload).toContain('"model":"ollama/qwen3.5:27b"')
		expect(payload).toContain('"type":"tool_use"')
		expect(payload).toContain('"/tmp/demo.txt"')
		expect(payload).toContain('"stop_reason":"tool_use"')
		expect(payload).toContain('event: message_stop')
	})
})
