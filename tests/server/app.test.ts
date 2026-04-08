import { describe, expect, test } from 'bun:test'
import { requestSchema } from '../../src/server/index.js'

describe('requestSchema', () => {
	test('accepts thinking without explicit enabled literal', () => {
		const parsed = requestSchema.parse({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 128,
			messages: [{ role: 'user', content: 'hello' }],
			thinking: {
				budget_tokens: 4096,
			},
		})

		expect(parsed.thinking).toEqual({
			budget_tokens: 4096,
		})
	})

	test('accepts disabled thinking payload', () => {
		const parsed = requestSchema.parse({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 128,
			messages: [{ role: 'user', content: 'hello' }],
			thinking: {
				type: 'disabled',
			},
		})

		expect(parsed.thinking).toEqual({
			type: 'disabled',
		})
	})

	test('accepts passthrough thinking payload from newer claude clients', () => {
		const parsed = requestSchema.parse({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 128,
			messages: [{ role: 'user', content: 'hello' }],
			thinking: {
				type: 'auto',
				effort: 'medium',
			},
		})

		expect(parsed.thinking).toEqual({
			type: 'auto',
			effort: 'medium',
		})
	})
})
