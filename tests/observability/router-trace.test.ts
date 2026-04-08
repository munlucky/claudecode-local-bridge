import { describe, expect, test } from 'bun:test'
import { buildRouterTraceContext, redactSensitiveValue } from '../../src/observability/index.js'

describe('buildRouterTraceContext', () => {
	test('uses upstream request id when present', () => {
		const headers = new Headers({
			'x-request-id': 'req-upstream-123',
			'x-claude-code-session-id': 'session-1',
			'x-bridge-session-id': 'bridge-session-1',
			'x-app': 'claude-code',
			'x-stainless-runtime': 'node',
			'x-stainless-package-version': '1.2.3',
		})

		const context = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
			request: {
				model: 'claude-opus-4-6',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hello' }],
				stream: true,
				tools: [
					{
						name: 'Read',
						input_schema: {},
					},
				],
			},
		})

		expect(context.router_request_id).toBe('req-upstream-123')
		expect(context.headers.x_claude_code_session_id).toBe('session-1')
		expect(context.headers.x_bridge_session_id).toBe('bridge-session-1')
		expect(context.headers.resolved_session_id).toBe('session-1')
		expect(context.headers.x_app).toBe('claude-code')
		expect(context.headers.x_stainless_runtime).toBe('node')
		expect(context.headers.x_stainless_package_version).toBe('1.2.3')
		expect(context.header_names).toEqual([
				'x-app',
				'x-bridge-session-id',
				'x-claude-code-session-id',
				'x-request-id',
				'x-stainless-package-version',
			'x-stainless-runtime',
		])
		expect(context.tool_names).toEqual(['Read'])
	})

	test('preserves existing router request id on rebuild', () => {
		const headers = new Headers()

		const initial = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
		})

		const rebuilt = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
			routerRequestId: initial.router_request_id,
			request: {
				model: 'claude-opus-4-6',
				max_tokens: 64,
				messages: [{ role: 'user', content: 'hi' }],
			},
		})

		expect(rebuilt.router_request_id).toBe(initial.router_request_id)
		expect(rebuilt.message_count).toBe(1)
	})

	test('uses bridge session id when Claude session id is missing', () => {
		const headers = new Headers({
			'x-bridge-session-id': 'bridge-only-session',
		})

		const context = buildRouterTraceContext({
			method: 'POST',
			path: '/v1/messages',
			headers,
		})

		expect(context.headers.x_claude_code_session_id).toBeNull()
		expect(context.headers.x_bridge_session_id).toBe('bridge-only-session')
		expect(context.headers.resolved_session_id).toBe('bridge-only-session')
	})

	test('redacts secrets and absolute paths from captured payloads', () => {
		const sanitized = redactSensitiveValue({
			authorization: 'Bearer secret-token-value',
			file_path: 'C:\\dev\\secret\\token.txt',
			usage_total_tokens: 321,
			nested: {
				api_key: 'sk-test-123456789',
			},
		}) as Record<string, unknown>

		expect(sanitized.authorization).toBe('[REDACTED]')
		expect(sanitized.file_path).toBe('[REDACTED_PATH]')
		expect(sanitized.usage_total_tokens).toBe(321)
		expect((sanitized.nested as Record<string, unknown>).api_key).toBe('[REDACTED]')
	})
})
