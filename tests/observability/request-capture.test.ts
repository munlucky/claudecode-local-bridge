import { describe, expect, test } from 'bun:test'
import { collectLastUserMessageSummary } from '../../src/observability/request-capture.js'

describe('collectLastUserMessageSummary', () => {
	test('captures raw slash command from the last user message', () => {
		const summary = collectLastUserMessageSummary({
			model: 'claude-sonnet-4-6',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: '/moonshot-phase-runner docs/implementation/00-master-plan-v1.md 개발 진행' },
			],
		})

		expect(summary).toEqual({
			last_user_message_preview:
				'/moonshot-phase-runner docs/implementation/00-master-plan-v1.md 개발 진행',
			last_user_message_is_slash_command: true,
			last_user_message_slash_command: 'moonshot-phase-runner',
		})
	})

	test('captures text from structured text blocks', () => {
		const summary = collectLastUserMessageSummary({
			model: 'claude-sonnet-4-6',
			max_tokens: 256,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'master plan 확인 후 실행 준비' },
						{ type: 'text', text: '추가 맥락' },
					],
				},
			],
		})

		expect(summary).toEqual({
			last_user_message_preview: 'master plan 확인 후 실행 준비\n추가 맥락',
			last_user_message_is_slash_command: false,
			last_user_message_slash_command: null,
		})
	})
})
