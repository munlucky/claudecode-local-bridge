import { describe, expect, test } from 'bun:test'
import { createAnthropicToolBridge } from '../../../src/bridge/anthropic/index.js'
import { validateAnthropicToolDefinitions } from '../../../src/bridge/anthropic/tool-bridge.js'
import type { AnthropicToolDefinition } from '../../../src/shared/index.js'

describe('createAnthropicToolBridge', () => {
	test('creates MCP config override when Anthropic tools are present', async () => {
		const bridge = await createAnthropicToolBridge(
			{
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 256,
				messages: [{ role: 'user', content: 'hello' }],
				tools: [
					{
						name: 'Read',
						description: 'Read a file',
						input_schema: {
							type: 'object',
							properties: {
								file_path: { type: 'string' },
							},
							additionalProperties: false,
						},
					},
				],
			},
			'C:\\dev\\not-claude-code-emulator',
		)

		expect(bridge).not.toBeNull()
		expect(bridge?.serverName).toBe('anthropic_bridge')
		expect(bridge?.configOverride).toHaveProperty('mcp_servers')

		await bridge?.cleanup()
	})

	test('rejects duplicate or non-strict tool definitions', () => {
		expect(() =>
			validateAnthropicToolDefinitions([
				{
					name: 'Read',
					input_schema: {
						type: 'object',
						properties: { file_path: { type: 'string' } },
						additionalProperties: false,
					},
				},
				{
					name: 'read',
					input_schema: {
						type: 'object',
						properties: {},
						additionalProperties: false,
					},
				},
			]),
		).toThrow('중복된 tool 이름')

		const tools: AnthropicToolDefinition[] = [
			{
				name: 'Read',
				input_schema: {
					type: 'object',
					properties: { file_path: { type: 'string' } },
				},
			},
		]

		expect(() => validateAnthropicToolDefinitions(tools)).not.toThrow()
		expect(tools[0].input_schema.additionalProperties).toBe(false)
	})
})
