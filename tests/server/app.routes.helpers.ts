import { createApp } from '../../src/server/index.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function readJsonFixture<T>(name: string): T {
	return JSON.parse(
		readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ollama', name), 'utf8'),
	) as T
}

export function createMockReadableStream(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(lines.join('\n')))
			controller.close()
		},
	})
}

export function createRouteTestHarness() {
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

	const restoreFetch = (handler: MockFetch) => {
		global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
			handler(input, init)) as typeof globalThis.fetch
	}

	return {
		createApp,
		restoreEnv,
		restoreFetch,
		restoreOriginalFetch() {
			global.fetch = originalFetch
		},
	}
}
