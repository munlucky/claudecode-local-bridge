import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../../src/server/index.js'
import {
	AnthropicRequestValidationError,
	buildAnonymousConversationSeed,
	buildCodexDeveloperInstructions,
	buildToolMappingGuidance,
	collectRequestTextSegments,
	extractToolExecutionHints,
	mapCodexResultToAnthropic,
	parseCodexBridgeDecision,
	resolveModelAlias,
	serializeAnthropicRequestToCodexPrompt,
	validateAnthropicRequestSemantics,
} from '../../../src/bridge/anthropic/index.js'

describe('Anthropic/Codex mapping', () => {
	test('Anthropic request is transformed into a Codex prompt', () => {
		process.env.CODEX_MODEL_SONNET = 'gpt-5.4'
		const config = loadConfig()

		const request = {
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 1024,
			system: 'You are helpful.',
			messages: [
				{
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'toolu_1',
							name: 'read_file',
							input: { path: 'README.md' },
						},
					],
				},
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'toolu_1',
							content: 'done',
						},
						{
							type: 'text' as const,
							text: 'continue',
						},
					],
				},
			],
			tools: [
				{
					name: 'read_file',
					description: 'Read a file',
					input_schema: {
						type: 'object',
						properties: {
							path: {
								type: 'string',
							},
						},
						required: ['path'],
					},
				},
			],
			thinking: {
				type: 'enabled' as const,
				budget_tokens: 5000,
			},
			stream: false,
		}

		expect(resolveModelAlias(config, request.model)).toBe('gpt-5.4')

		const developerInstructions = buildCodexDeveloperInstructions(request)
		const prompt = serializeAnthropicRequestToCodexPrompt(request)
		const textSegments = collectRequestTextSegments(request)
		const toolGuidance = buildToolMappingGuidance(request)

		expect(developerInstructions).toContain('Caller system instructions')
		expect(developerInstructions).toContain('You are helpful.')
		expect(developerInstructions).toContain('do not execute tools directly')
		expect(developerInstructions).toContain('Tool equivalence guidance')
		expect(developerInstructions).toContain('External tool loop contract')
		expect(prompt).toContain('"name": "read_file"')
		expect(prompt).toContain('Tool request read_file (toolu_1): {"path":"README.md"}')
		expect(prompt).toContain('Tool result for toolu_1: done')
		expect(prompt).toContain('continue')
		expect(prompt).toContain('return it as strict JSON')
		expect(prompt).toContain('Tool mapping hints')
		expect(textSegments).toContain('You are helpful.')
		expect(toolGuidance).toHaveLength(1)
		expect(toolGuidance[0]).toContain("'read_file'")
	})

	test('tool_use and tool_result are turned into execution handoff hints', () => {
		const request = {
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 1024,
			messages: [
				{
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'toolu_read',
							name: 'Read',
							input: { file_path: 'C:\\dev\\claude-code-main\\README.md' },
						},
						{
							type: 'tool_use' as const,
							id: 'toolu_glob',
							name: 'Glob',
							input: { pattern: 'src/**/*.ts', path: 'C:\\dev\\claude-code-main\\src' },
						},
					],
				},
				{
					role: 'user' as const,
					content: [
						{
							type: 'tool_result' as const,
							tool_use_id: 'toolu_read',
							content: '# heading',
						},
					],
				},
			],
		}

		const hints = extractToolExecutionHints(request)
		const developerInstructions = buildCodexDeveloperInstructions(request)
		const prompt = serializeAnthropicRequestToCodexPrompt(request)
		const textSegments = collectRequestTextSegments(request)

		expect(hints).toEqual([
			{
				id: 'toolu_read',
				name: 'Read',
				inputSummary: '{"file_path":"C:\\\\dev\\\\claude-code-main\\\\README.md"}',
				resultSummary: '# heading',
				status: 'resolved',
			},
			{
				id: 'toolu_glob',
				name: 'Glob',
				inputSummary:
					'{"pattern":"src/**/*.ts","path":"C:\\\\dev\\\\claude-code-main\\\\src"}',
				resultSummary: null,
				status: 'pending',
			},
		])
		expect(developerInstructions).toContain('Tool execution handoff')
		expect(developerInstructions).toContain("Resolved tool call 'Read'")
		expect(developerInstructions).toContain("Pending tool intent 'Glob'")
		expect(prompt).toContain('resolved Read (toolu_read)')
		expect(prompt).toContain('pending Glob (toolu_glob)')
		expect(
			textSegments.some((segment) => segment.includes('C:\\\\dev\\\\claude-code-main\\\\README.md')),
		).toBe(true)
		expect(
			textSegments.some((segment) => segment.includes('C:\\\\dev\\\\claude-code-main\\\\src')),
		).toBe(true)
	})

	test('Codex turn result is transformed into Anthropic response', () => {
		const mapped = mapCodexResultToAnthropic(
			{
				id: 'msg_123',
				model: 'gpt-5.4',
				text: 'done',
				usage: {
					inputTokens: 12,
					cachedInputTokens: 0,
					outputTokens: 8,
					reasoningOutputTokens: 2,
					totalTokens: 20,
				},
			},
			'claude-sonnet-4-5-20250929',
		)

		expect(mapped.id).toBe('msg_123')
		expect(mapped.model).toBe('gpt-5.4')
		expect(mapped.stop_reason).toBe('end_turn')
		expect(mapped.content).toEqual([
			{
				type: 'text',
				text: 'done',
			},
		])
	})

	test('structured tool decision is parsed and mapped back to anthropic tool_use', () => {
		const request = {
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 512,
			messages: [{ role: 'user' as const, content: 'read the README' }],
			tools: [
				{
					name: 'Read',
					input_schema: {
						type: 'object',
						properties: {
							file_path: { type: 'string' },
						},
						required: ['file_path'],
					},
				},
			],
		}

		const decision = parseCodexBridgeDecision(
			'{"kind":"tool_use","name":"Read","input":{"file_path":"README.md"},"preamble":"먼저 README를 확인하겠습니다."}',
			request,
		)

		expect(decision).toEqual({
			kind: 'tool_use',
			name: 'Read',
			input: { file_path: 'README.md' },
			preamble: '먼저 README를 확인하겠습니다.',
		})

		const mapped = mapCodexResultToAnthropic(
			{
				id: 'msg_tool',
				model: 'gpt-5.4',
				text: '{"kind":"tool_use","name":"Read","input":{"file_path":"README.md"}}',
				decision,
				usage: {
					inputTokens: 10,
					cachedInputTokens: 0,
					outputTokens: 5,
					reasoningOutputTokens: 0,
					totalTokens: 15,
				},
			},
			request.model,
		)

		expect(mapped.stop_reason).toBe('tool_use')
		expect(mapped.content[0]).toEqual({
			type: 'text',
			text: '먼저 README를 확인하겠습니다.',
		})
		expect(mapped.content[1]).toMatchObject({
			type: 'tool_use',
			name: 'Read',
			input: { file_path: 'README.md' },
		})
	})

	test('actual Claude Code tool surface is mapped to Codex guidance', () => {
		const guidance = buildToolMappingGuidance({
			model: 'claude-opus-4-6',
			max_tokens: 1024,
			messages: [{ role: 'user', content: 'inspect the repo' }],
			tools: [
				{ name: 'Agent', input_schema: {} },
				{ name: 'Bash', input_schema: {} },
				{ name: 'Edit', input_schema: {} },
				{ name: 'Glob', input_schema: {} },
				{ name: 'Grep', input_schema: {} },
				{ name: 'Read', input_schema: {} },
				{ name: 'Skill', input_schema: {} },
				{ name: 'ToolSearch', input_schema: {} },
				{ name: 'Write', input_schema: {} },
			],
		})

		expect(guidance).toHaveLength(9)
		expect(guidance.some((line) => line.includes("'Read'"))).toBe(true)
		expect(guidance.some((line) => line.includes("'Glob'"))).toBe(true)
		expect(guidance.some((line) => line.includes("'Grep'"))).toBe(true)
		expect(guidance.some((line) => line.includes("'Bash'"))).toBe(true)
		expect(guidance.some((line) => line.includes("'ToolSearch'"))).toBe(true)
	})

	test('anonymous conversation seed is stable for equivalent prompts', () => {
		const seedA = buildAnonymousConversationSeed({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: 'You are helpful.',
			messages: [
				{
					role: 'user',
					content:
						'Please inspect routerreq_123e4567-e89b-12d3-a456-426614174000 and continue.',
				},
			],
			tools: [{ name: 'Read', input_schema: {} }],
		})

		const seedB = buildAnonymousConversationSeed({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: '  you are helpful. ',
			messages: [
				{
					role: 'user',
					content:
						'Please inspect routerreq_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee and continue.',
				},
			],
			tools: [{ name: 'Read', input_schema: {} }],
		})

		const seedC = buildAnonymousConversationSeed({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: 'You are helpful.',
			messages: [{ role: 'user', content: 'Please inspect a different task.' }],
			tools: [{ name: 'Read', input_schema: {} }],
		})

		expect(seedA).toBe(seedB)
		expect(seedC).not.toBe(seedA)
	})

	test('anonymous conversation seed stays stable as later turns are appended', () => {
		const seedInitial = buildAnonymousConversationSeed({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: 'You are helpful.',
			messages: [{ role: 'user', content: 'Investigate the bridge runtime issue.' }],
			tools: [{ name: 'Read', input_schema: {} }],
		})

		const seedLater = buildAnonymousConversationSeed({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			system: 'You are helpful.',
			messages: [
				{ role: 'user', content: 'Investigate the bridge runtime issue.' },
				{ role: 'assistant', content: 'I will inspect the logs.' },
				{ role: 'user', content: 'Here are more logs and a new stack trace.' },
			],
			tools: [{ name: 'Read', input_schema: {} }],
		})

		expect(seedLater).toBe(seedInitial)
	})

	test('rejects tool_result without a prior tool_use', () => {
		expect(() =>
			validateAnthropicRequestSemantics({
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 128,
				messages: [
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'x' }],
					},
				],
				tools: [
					{
						name: 'Read',
						input_schema: {
							type: 'object',
							properties: { file_path: { type: 'string' } },
							required: ['file_path'],
							additionalProperties: false,
						},
					},
				],
			}),
		).toThrow(AnthropicRequestValidationError)
	})

	test('normalizes non-strict tool schemas to satisfy strict requirements', () => {
		const request = {
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 128,
			messages: [{ role: 'user', content: 'hello' }],
			tools: [
				{
					name: 'Read',
					input_schema: {
						type: 'object',
						properties: { file_path: { type: 'string' } },
					},
				},
			],
		}

		expect(() => validateAnthropicRequestSemantics(request)).not.toThrow()
		expect(request.tools?.[0].input_schema.additionalProperties).toBe(false)
	})

	test('rejects non-object tool schemas', () => {
		expect(() =>
			validateAnthropicRequestSemantics({
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hello' }],
				tools: [
					{
						name: 'Read',
						input_schema: 'not-an-object' as unknown as any,
					},
				],
			}),
		).toThrow('object 여야 합니다')
	})
})
