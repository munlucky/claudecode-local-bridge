import { describe, expect, test } from 'bun:test'
import {
	anthropicRequestToCanonical,
	anthropicResponseToCanonical,
	canonicalContentToAnthropicInput,
	canonicalResponseToAnthropic,
} from '../../../src/bridge/canonical/anthropic.js'
import type {
	AnthropicMessagesRequest,
	AnthropicMessagesResponse,
} from '../../../src/shared/index.js'

describe('canonical Anthropic compatibility transforms', () => {
	test('maps Anthropic request content into canonical request form', () => {
		const request: AnthropicMessagesRequest = {
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 512,
			stream: true,
			system: [
				{
					type: 'text',
					text: 'follow the system contract',
				},
			],
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'describe this image' },
						{
							type: 'image',
							source: {
								type: 'base64',
								media_type: 'image/png',
								data: 'abc123',
							},
						},
					],
				},
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_01',
							name: 'read_file',
							input: { path: 'README.md' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_01',
							content: 'file contents',
						},
						{
							type: 'thinking',
							thinking: 'need to inspect the file first',
						},
					],
				},
			],
			tools: [
				{
					name: 'read_file',
					input_schema: {
						type: 'object',
						properties: { path: { type: 'string' } },
						required: ['path'],
					},
				},
			],
			tool_choice: {
				type: 'tool',
				name: 'read_file',
			},
			thinking: {
				type: 'enabled',
				budget_tokens: 128,
			},
			temperature: 0.1,
			top_p: 0.8,
			top_k: 40,
		}

		const canonical = anthropicRequestToCanonical(request, {
			source: 'direct-skill',
			metadata: {
				sessionId: 'session-1',
				routerRequestId: 'request-1',
				userAgent: 'test-agent',
			},
		})

		expect(canonical).toEqual({
			model: 'claude-sonnet-4-5-20250929',
			stream: true,
			source: 'direct-skill',
			system: [{ type: 'text', text: 'follow the system contract' }],
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'describe this image' },
						{
							type: 'image',
							source: {
								type: 'base64',
								mediaType: 'image/png',
								data: 'abc123',
							},
						},
					],
				},
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_01',
							name: 'read_file',
							input: { path: 'README.md' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							toolUseId: 'toolu_01',
							content: 'file contents',
						},
						{
							type: 'thinking',
							text: 'need to inspect the file first',
						},
					],
				},
			],
			tools: request.tools,
			toolChoice: request.tool_choice,
			sampling: {
				maxTokens: 512,
				temperature: 0.1,
				topP: 0.8,
				topK: 40,
			},
			reasoning: {
				enabled: true,
				budgetTokens: 128,
				raw: request.thinking,
			},
			metadata: {
				sessionId: 'session-1',
				routerRequestId: 'request-1',
				userAgent: 'test-agent',
			},
		})
	})

	test('maps canonical response back into Anthropic response form', () => {
		const response = canonicalResponseToAnthropic({
			id: 'msg_123',
			model: 'claude-sonnet-4-5-20250929',
			content: [
				{ type: 'thinking', text: 'working through the request' },
				{ type: 'text', text: 'done' },
				{
					type: 'tool_use',
					id: 'toolu_02',
					name: 'read_file',
					input: { path: 'README.md' },
				},
			],
			stopReason: 'tool_use',
			stopSequence: null,
			usage: {
				inputTokens: 101,
				outputTokens: 22,
				cachedInputTokens: 3,
				reasoningOutputTokens: 9,
				totalTokens: 135,
			},
			provider: {
				id: 'codex-app-server',
				model: 'gpt-5.4',
			},
		})

		expect(response).toEqual({
			id: 'msg_123',
			type: 'message',
			role: 'assistant',
			model: 'claude-sonnet-4-5-20250929',
			content: [
				{ type: 'thinking', thinking: 'working through the request' },
				{ type: 'text', text: 'done' },
				{
					type: 'tool_use',
					id: 'toolu_02',
					name: 'read_file',
					input: { path: 'README.md' },
				},
			],
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage: {
				input_tokens: 101,
				output_tokens: 22,
				cache_read_input_tokens: 3,
				reasoning_output_tokens: 9,
				total_tokens: 135,
			},
		})
	})

	test('maps Anthropic response into canonical response form', () => {
		const response: AnthropicMessagesResponse = {
			id: 'msg_456',
			type: 'message',
			role: 'assistant',
			model: 'claude-opus-4-1-20250805',
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: {
				input_tokens: 20,
				output_tokens: 10,
				cache_read_input_tokens: 5,
				reasoning_output_tokens: 2,
			},
		}

		expect(
			anthropicResponseToCanonical(response, {
				id: 'ollama-chat',
				model: 'qwen3.5:27b',
			}),
		).toEqual({
			id: 'msg_456',
			model: 'claude-opus-4-1-20250805',
			content: [{ type: 'text', text: 'hello' }],
			stopReason: 'end_turn',
			stopSequence: null,
			usage: {
				inputTokens: 20,
				outputTokens: 10,
				cachedInputTokens: 5,
				reasoningOutputTokens: 2,
				totalTokens: 30,
			},
			provider: {
				id: 'ollama-chat',
				model: 'qwen3.5:27b',
			},
		})
	})

	test('keeps image and tool_result blocks when returning to Anthropic input content', () => {
		expect(
			canonicalContentToAnthropicInput([
				{
					type: 'image',
					source: {
						type: 'base64',
						mediaType: 'image/jpeg',
						data: 'xyz',
					},
				},
				{
					type: 'tool_result',
					toolUseId: 'toolu_99',
					content: 'result text',
				},
			]),
		).toEqual([
			{
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/jpeg',
					data: 'xyz',
				},
			},
			{
				type: 'tool_result',
				tool_use_id: 'toolu_99',
				content: 'result text',
			},
		])
	})

	test('rejects canonical tool_result blocks in Anthropic assistant response output', () => {
		expect(() =>
			canonicalResponseToAnthropic({
				id: 'msg_invalid',
				model: 'claude-haiku-4-5-20251001',
				content: [
					{
						type: 'tool_result',
						toolUseId: 'toolu_bad',
						content: 'not allowed in assistant response',
					},
				],
				stopReason: 'end_turn',
				stopSequence: null,
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					cachedInputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 2,
				},
				provider: {
					id: 'codex-app-server',
					model: 'gpt-5.4-mini',
				},
			}),
		).toThrow('Canonical tool_result blocks cannot be emitted in Anthropic message responses.')
	})
})
