import { existsSync, lstatSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
	buildCodexDeveloperInstructions,
	collectRequestTextSegments,
	parseCodexBridgeDecision,
	resolveModelAlias,
	serializeAnthropicRequestToCodexPrompt,
} from '../anthropic/index.js'
import { AuthConfigurationError, requireCodexLocalAuthFile } from './auth.js'
import type { RouterConfig } from '../../server/config.js'
import type {
	AnthropicMessagesRequest,
	CodexTokenUsage,
	CodexTurnResult,
	CodexBridgeDecision,
	JsonValue,
} from '../../shared/index.js'

type JsonRpcResult = Record<string, unknown>
type JsonRpcNotification = {
	method?: string
	params?: Record<string, unknown>
}

type PendingRequest = {
	resolve: (value: JsonRpcResult) => void
	reject: (error: Error) => void
	timeout: Timer
}

export interface CodexTurnMetadata {
	threadId: string
	workspaceRoot: string
}

export interface StreamLifecycleLogger {
	onSessionReady?: (metadata: CodexTurnMetadata & { model: string }) => void | Promise<void>
	onComplete?: (payload: {
		stopReason: 'end_turn' | 'tool_use'
		usage: CodexTokenUsage
		finalText: string
		decision: CodexBridgeDecision | null
		metadata: CodexTurnMetadata & { model: string }
	}) => void | Promise<void>
	onError?: (payload: {
		error: unknown
		metadata?: Partial<CodexTurnMetadata & { model: string }>
	}) => void | Promise<void>
	onCancel?: (payload: {
		metadata?: Partial<CodexTurnMetadata & { model: string }>
	}) => void | Promise<void>
}

const ZERO_USAGE: CodexTokenUsage = {
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0,
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function getObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function getString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeUsage(value: unknown): CodexTokenUsage {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ...ZERO_USAGE }
	}

	const usage = value as Record<string, unknown>
	return {
		inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
		cachedInputTokens:
			typeof usage.cachedInputTokens === 'number' ? usage.cachedInputTokens : 0,
		outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
		reasoningOutputTokens:
			typeof usage.reasoningOutputTokens === 'number' ? usage.reasoningOutputTokens : 0,
		totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
	}
}

function getTurnUsage(params: Record<string, unknown> | undefined): CodexTokenUsage | null {
	const tokenUsage = getObject(params?.tokenUsage)
	if (!tokenUsage) {
		return null
	}

	const last = getObject(tokenUsage.last)
	return last ? normalizeUsage(last) : null
}

function getItemText(item: Record<string, unknown> | null): string | null {
	const direct = getString(item?.text)
	if (direct) {
		return direct
	}

	const content = Array.isArray(item?.content) ? item.content : null
	if (!content) {
		return null
	}

	const text = content
		.map((part) => {
			const block = getObject(part)
			return getString(block?.text)
		})
		.filter((value): value is string => Boolean(value))
		.join('')

	return text.length > 0 ? text : null
}

function formatSse(event: string, payload: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function formatSseComment(comment: string): Uint8Array {
	return new TextEncoder().encode(`: ${comment}\n\n`)
}

function getReadableStream(
	stream: ReturnType<typeof Bun.spawn>['stdout'] | ReturnType<typeof Bun.spawn>['stderr'],
	label: string,
): ReadableStream<Uint8Array> {
	if (stream instanceof ReadableStream) {
		return stream
	}

	throw new Error(`${label} 스트림을 읽을 수 없습니다.`)
}

function getWritableStdin(stream: ReturnType<typeof Bun.spawn>['stdin']) {
	if (stream && typeof stream === 'object' && 'write' in stream) {
		return stream
	}

	throw new Error('codex app-server stdin 에 쓸 수 없습니다.')
}

function normalizeWorkspaceCandidate(rawPath: string): string | null {
	const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, '')
	if (!trimmed) {
		return null
	}

	try {
		const resolved = resolve(trimmed)
		if (!existsSync(resolved)) {
			return null
		}

		const stats = lstatSync(resolved)
		return stats.isDirectory() ? resolved : dirname(resolved)
	} catch {
		return null
	}
}

function inferWorkspaceRoot(config: RouterConfig, request: AnthropicMessagesRequest): string {
	const pathRegex = /([A-Za-z]:\\[^<>:"|?*\r\n]+(?:\.[^\\/\s'"]+)?)|([A-Za-z]:\/[^\r\n'"]+)/g
	const segments = collectRequestTextSegments(request)

	for (const segment of segments) {
		const matches = segment.match(pathRegex) ?? []
		for (const match of matches) {
			const workspace = normalizeWorkspaceCandidate(match)
			if (workspace) {
				return workspace
			}
		}
	}

	return config.codexRuntimeCwd
}

function buildSandboxPolicy(
	sandboxMode: RouterConfig['codexSandboxMode'],
): 'read-only' | 'workspace-write' | 'danger-full-access' {
	return sandboxMode
}

function buildTurnSandboxPolicy(
	sandboxMode: RouterConfig['codexSandboxMode'],
):
	| { type: 'readOnly' }
	| {
			type: 'workspaceWrite'
			networkAccess: boolean
			excludeTmpdirEnvVar: boolean
			excludeSlashTmp: boolean
	  }
	| { type: 'dangerFullAccess' } {
	switch (sandboxMode) {
		case 'read-only':
			return { type: 'readOnly' }
		case 'danger-full-access':
			return { type: 'dangerFullAccess' }
		default:
			return {
				type: 'workspaceWrite',
				networkAccess: true,
				excludeTmpdirEnvVar: false,
				excludeSlashTmp: false,
			}
	}
}

class CodexAppServerSession {
	private readonly process: ReturnType<typeof Bun.spawn>
	private readonly encoder = new TextEncoder()
	private readonly decoder = new TextDecoder()
	private readonly pending = new Map<number, PendingRequest>()
	private readonly listeners = new Set<(notification: JsonRpcNotification) => void>()
	private nextId = 1
	private buffer = ''
	private closed = false

	private constructor(config: RouterConfig) {
		const executable = Bun.which(config.codexCommand) ?? config.codexCommand
		this.process = Bun.spawn([executable, 'app-server'], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: process.env,
		})
		this.processStdout()
		this.processStderr()
		void this.process.exited.then(() => {
			this.failAll(new Error('codex app-server 프로세스가 종료되었습니다.'))
		})
	}

	static async create(config: RouterConfig): Promise<CodexAppServerSession> {
		const session = new CodexAppServerSession(config)
		await session.request(
			'initialize',
			{
				clientInfo: {
					name: 'claudecode-codex-local-bridge',
					version: '2.0.0',
				},
			},
			config.codexInitTimeoutMs,
		)
		return session
	}

	private processStdout() {
		void (async () => {
			const reader = getReadableStream(this.process.stdout, 'stdout').getReader()
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) {
						break
					}

					this.buffer += this.decoder.decode(value, { stream: true })
					while (true) {
						const newlineIndex = this.buffer.indexOf('\n')
						if (newlineIndex < 0) {
							break
						}

						const line = this.buffer.slice(0, newlineIndex).trim()
						this.buffer = this.buffer.slice(newlineIndex + 1)
						if (!line) {
							continue
						}

						this.handleLine(line)
					}
				}
			} finally {
				reader.releaseLock()
			}
		})()
	}

	private processStderr() {
		void (async () => {
			const text = (await new Response(getReadableStream(this.process.stderr, 'stderr')).text()).trim()
			if (text && !this.closed) {
				this.failAll(new Error(text))
			}
		})()
	}

	private handleLine(line: string) {
		let message: Record<string, unknown>
		try {
			message = JSON.parse(line) as Record<string, unknown>
		} catch {
			return
		}

		if (typeof message.id === 'number') {
			const pending = this.pending.get(message.id)
			if (!pending) {
				return
			}

			clearTimeout(pending.timeout)
			this.pending.delete(message.id)
			if (message.error && typeof message.error === 'object') {
				const errorObject = message.error as Record<string, unknown>
				pending.reject(new Error(getString(errorObject.message) ?? 'codex app-server 오류'))
				return
			}

			pending.resolve(getObject(message.result) ?? {})
			return
		}

		const notification: JsonRpcNotification = {
			method: getString(message.method) ?? undefined,
			params: getObject(message.params) ?? undefined,
		}
		for (const listener of this.listeners) {
			listener(notification)
		}
	}

	private failAll(error: Error) {
		this.closed = true
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout)
			pending.reject(error)
		}
		this.pending.clear()
	}

	addListener(listener: (notification: JsonRpcNotification) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
	): Promise<JsonRpcResult> {
		if (this.closed) {
			return Promise.reject(new Error('codex app-server 세션이 닫혔습니다.'))
		}

		const id = this.nextId++
		const deferred = createDeferred<JsonRpcResult>()
		const timeout = setTimeout(() => {
			this.pending.delete(id)
			deferred.reject(new Error(`${method} 요청이 시간 초과되었습니다.`))
		}, timeoutMs)

		this.pending.set(id, {
			resolve: deferred.resolve,
			reject: deferred.reject,
			timeout,
		})
		getWritableStdin(this.process.stdin).write(
			this.encoder.encode(`${JSON.stringify({ id, method, params })}\n`),
		)
		return deferred.promise
	}

	close() {
		if (this.closed) {
			return
		}

		this.failAll(new Error('codex app-server 세션이 종료되었습니다.'))
		this.process.kill()
	}
}

async function createPreparedSession(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
): Promise<{
	session: CodexAppServerSession
	threadId: string
	model: string
	reasoningEffort: string | null
	workspaceRoot: string
	cleanup: () => Promise<void>
}> {
	if (config.codexAuthMode !== 'local_auth_json') {
		throw new AuthConfigurationError(
			'이 프로젝트는 CODEX_AUTH_MODE=local_auth_json 전용으로 동작합니다.',
		)
	}

	await requireCodexLocalAuthFile(config.codexAuthFile)
	await mkdir(config.codexRuntimeCwd, { recursive: true })
	const workspaceRoot = inferWorkspaceRoot(config, request)

	const session = await CodexAppServerSession.create(config)
	const authStatus = await session.request(
		'getAuthStatus',
		{
			includeToken: false,
			refreshToken: true,
		},
		config.codexInitTimeoutMs,
	)

	if (authStatus.authMethod !== 'chatgpt') {
		session.close()
		throw new AuthConfigurationError('Codex local auth 상태가 활성화되어 있지 않습니다.')
	}

	const targetModel = resolveModelAlias(config, request.model)
	const threadStart = await session.request(
		'thread/start',
		{
			model: targetModel,
			cwd: workspaceRoot,
			approvalPolicy: 'never',
			sandbox: buildSandboxPolicy(config.codexSandboxMode),
			baseInstructions:
				'You are serving as an Anthropic-compatible backend through a local bridge.',
			developerInstructions: buildCodexDeveloperInstructions(request),
		},
		config.codexInitTimeoutMs,
	)

	const thread = getObject(threadStart.thread)
	const threadId = getString(thread?.id)
	if (!threadId) {
		session.close()
		throw new Error('thread/start 응답에 thread.id 가 없습니다.')
	}

	return {
		session,
		threadId,
		model: getString(threadStart.model) ?? targetModel,
		reasoningEffort: getString(threadStart.reasoningEffort),
		workspaceRoot,
		cleanup: async () => {},
	}
}

function normalizeEffort(value: string | null): string {
	switch (value) {
		case 'none':
		case 'low':
		case 'medium':
		case 'high':
		case 'xhigh':
			return value
		default:
			return 'low'
	}
}

function buildTurnStartParams(
	threadId: string,
	reasoningEffort: string | null,
	config: RouterConfig,
	request: AnthropicMessagesRequest,
): Record<string, unknown> {
	return {
		threadId,
		input: [
			{
				type: 'text',
				text: serializeAnthropicRequestToCodexPrompt(request),
			},
		],
		approvalPolicy: 'never',
		sandboxPolicy: buildTurnSandboxPolicy(config.codexSandboxMode),
		effort: normalizeEffort(reasoningEffort),
		outputSchema: null as JsonValue | null,
	}
}

function createResult(
	model: string,
	text: string,
	usage: CodexTokenUsage,
	decision: CodexBridgeDecision | null,
): CodexTurnResult {
	return {
		id: `msg_${crypto.randomUUID()}`,
		model,
		text,
		usage,
		decision,
	}
}

export async function executeCodexTurn(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
): Promise<CodexTurnResult> {
	const prepared = await createPreparedSession(config, request)
	let finalText = ''
	const usage = { ...ZERO_USAGE }
	const structuredToolLoop = Boolean(request.tools?.length)

	try {
		const completed = createDeferred<CodexTurnResult>()
		const unsubscribe = prepared.session.addListener((notification) => {
			const method = notification.method
			const params = notification.params

			if (method === 'item/agentMessage/delta') {
				finalText += getString(params?.delta) ?? ''
				return
			}

			if (method === 'item/completed') {
				const item = getObject(params?.item)
				if (item?.type === 'agentMessage') {
					finalText = getItemText(item) ?? finalText
				}
				return
			}

			if (method === 'thread/tokenUsage/updated') {
				Object.assign(usage, getTurnUsage(params) ?? {})
				return
			}

			if (method === 'turn/completed') {
				unsubscribe()
				const decision = parseCodexBridgeDecision(finalText, request)
				completed.resolve(
					createResult(
						prepared.model,
						finalText,
						usage,
						structuredToolLoop ? decision : null,
					),
				)
			}
		})

		await prepared.session.request(
			'turn/start',
			buildTurnStartParams(
				prepared.threadId,
				prepared.reasoningEffort,
				config,
				request,
			),
			config.codexInitTimeoutMs,
		)

		return await Promise.race([
			completed.promise,
			new Promise<CodexTurnResult>((_, reject) =>
				setTimeout(
					() => reject(new Error('Codex turn 완료를 기다리다 시간 초과되었습니다.')),
					config.codexTurnTimeoutMs,
				),
			),
		])
	} finally {
		prepared.session.close()
		await prepared.cleanup()
	}
}

export function createCodexAnthropicStream(
	config: RouterConfig,
	request: AnthropicMessagesRequest,
	logger?: StreamLifecycleLogger,
): ReadableStream<Uint8Array> {
	let prepared: Awaited<ReturnType<typeof createPreparedSession>> | null = null
	let unsubscribe: (() => void) | null = null
	let streamClosed = false
	let keepAliveTimer: Timer | null = null

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let usage = { ...ZERO_USAGE }
			let textStarted = false
			let streamedText = ''
			let finalText = ''
			const structuredToolLoop = Boolean(request.tools?.length)

			const safeEnqueue = (payload: Uint8Array): boolean => {
				if (streamClosed) {
					return false
				}

				try {
					controller.enqueue(payload)
					return true
				} catch {
					streamClosed = true
					return false
				}
			}

			const safeClose = () => {
				if (streamClosed) {
					return
				}

				streamClosed = true
				try {
					controller.close()
				} catch {}
			}

			try {
				safeEnqueue(formatSseComment('stream-open'))
				keepAliveTimer = setInterval(() => {
					safeEnqueue(formatSseComment('keepalive'))
				}, 5000)

				prepared = await createPreparedSession(config, request)
				await logger?.onSessionReady?.({
					threadId: prepared.threadId,
					workspaceRoot: prepared.workspaceRoot,
					model: prepared.model,
				})
				if (
					!safeEnqueue(
					formatSse('message_start', {
						type: 'message_start',
						message: {
							id: `msg_${crypto.randomUUID()}`,
							type: 'message',
							role: 'assistant',
							model: prepared.model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: {
								input_tokens: 0,
								output_tokens: 0,
							},
						},
					}),
					)
				) {
					return
				}

				const completed = createDeferred<void>()
				unsubscribe = prepared.session.addListener((notification) => {
					const method = notification.method
					const params = notification.params

					if (method === 'item/agentMessage/delta') {
						const delta = getString(params?.delta) ?? ''
						if (!delta) {
							return
						}

						if (structuredToolLoop) {
							streamedText += delta
							finalText = streamedText
							return
						}

						if (!textStarted) {
							textStarted = true
							if (
								!safeEnqueue(
								formatSse('content_block_start', {
									type: 'content_block_start',
									index: 0,
									content_block: {
										type: 'text',
										text: '',
									},
								}),
								)
							) {
								return
							}
						}

						streamedText += delta
						finalText = streamedText
						safeEnqueue(
							formatSse('content_block_delta', {
								type: 'content_block_delta',
								index: 0,
								delta: {
									type: 'text_delta',
									text: delta,
								},
							}),
						)
						return
					}

					if (method === 'item/completed') {
						const item = getObject(params?.item)
						if (item?.type === 'agentMessage') {
							finalText = getItemText(item) ?? finalText
						}
						return
					}

					if (method === 'thread/tokenUsage/updated') {
						usage = getTurnUsage(params) ?? usage
						return
					}

					if (method === 'turn/completed') {
						if (structuredToolLoop) {
							const decision = parseCodexBridgeDecision(finalText, request)
							if (decision?.kind === 'tool_use') {
								const activePrepared = prepared
								if (!activePrepared) {
									unsubscribe?.()
									completed.resolve()
									return
								}
								let blockIndex = 0
								if (decision.preamble?.trim()) {
									safeEnqueue(
										formatSse('content_block_start', {
											type: 'content_block_start',
											index: blockIndex,
											content_block: {
												type: 'text',
												text: '',
											},
										}),
									)
									safeEnqueue(
										formatSse('content_block_delta', {
											type: 'content_block_delta',
											index: blockIndex,
											delta: {
												type: 'text_delta',
												text: decision.preamble,
											},
										}),
									)
									safeEnqueue(
										formatSse('content_block_stop', {
											type: 'content_block_stop',
											index: blockIndex,
										}),
									)
									blockIndex += 1
								}

								const toolUseId = `toolu_${crypto.randomUUID()}`
								safeEnqueue(
									formatSse('content_block_start', {
										type: 'content_block_start',
										index: blockIndex,
										content_block: {
											type: 'tool_use',
											id: toolUseId,
											name: decision.name,
											input: {},
										},
									}),
								)
								safeEnqueue(
									formatSse('content_block_delta', {
										type: 'content_block_delta',
										index: blockIndex,
										delta: {
											type: 'input_json_delta',
											partial_json: JSON.stringify(decision.input),
										},
									}),
								)
								safeEnqueue(
									formatSse('content_block_stop', {
										type: 'content_block_stop',
										index: blockIndex,
									}),
								)
								safeEnqueue(
									formatSse('message_delta', {
										type: 'message_delta',
										delta: {
											stop_reason: 'tool_use',
											stop_sequence: null,
										},
										usage: {
											output_tokens: usage.outputTokens,
										},
									}),
								)
								safeEnqueue(
									formatSse('message_stop', {
										type: 'message_stop',
									}),
								)
								void logger?.onComplete?.({
									stopReason: 'tool_use',
									usage,
									finalText,
									decision,
									metadata: {
										threadId: activePrepared.threadId,
										workspaceRoot: activePrepared.workspaceRoot,
										model: activePrepared.model,
									},
								})
								unsubscribe?.()
								completed.resolve()
								return
							}

							if (decision?.kind === 'assistant') {
								finalText = decision.text
							}
						}

						const activePrepared = prepared
						if (!activePrepared) {
							unsubscribe?.()
							completed.resolve()
							return
						}

						if (!textStarted && finalText) {
							textStarted = true
							if (
								!safeEnqueue(
								formatSse('content_block_start', {
									type: 'content_block_start',
									index: 0,
									content_block: {
										type: 'text',
										text: '',
									},
								}),
								)
							) {
								unsubscribe?.()
								completed.resolve()
								return
							}
							safeEnqueue(
								formatSse('content_block_delta', {
									type: 'content_block_delta',
									index: 0,
									delta: {
										type: 'text_delta',
									text: finalText,
								},
							}),
							)
						}

						if (textStarted) {
							safeEnqueue(
								formatSse('content_block_stop', {
									type: 'content_block_stop',
									index: 0,
								}),
							)
						}

						safeEnqueue(
							formatSse('message_delta', {
								type: 'message_delta',
								delta: {
									stop_reason: 'end_turn',
									stop_sequence: null,
								},
								usage: {
									output_tokens: usage.outputTokens,
								},
							}),
						)
						safeEnqueue(
							formatSse('message_stop', {
								type: 'message_stop',
							}),
						)
						void logger?.onComplete?.({
							stopReason: 'end_turn',
							usage,
							finalText,
							decision: structuredToolLoop
								? parseCodexBridgeDecision(finalText, request)
								: null,
							metadata: {
								threadId: activePrepared.threadId,
								workspaceRoot: activePrepared.workspaceRoot,
								model: activePrepared.model,
							},
						})
						unsubscribe?.()
						completed.resolve()
					}
				})

				await prepared.session.request(
					'turn/start',
					buildTurnStartParams(
						prepared.threadId,
						prepared.reasoningEffort,
						config,
						request,
					),
					config.codexInitTimeoutMs,
				)

				await Promise.race([
					completed.promise,
					new Promise<void>((_, reject) =>
						setTimeout(
							() => reject(new Error('Codex stream 완료를 기다리다 시간 초과되었습니다.')),
							config.codexTurnTimeoutMs,
						),
					),
				])
				safeClose()
			} catch (error) {
				void logger?.onError?.({
					error,
					metadata: prepared
						? {
								threadId: prepared.threadId,
								workspaceRoot: prepared.workspaceRoot,
								model: prepared.model,
							}
						: undefined,
				})
				safeEnqueue(
					formatSse('error', {
						type: 'error',
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				)
				safeClose()
			} finally {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer)
				}
				unsubscribe?.()
				prepared?.session.close()
				await prepared?.cleanup()
			}
		},
		cancel() {
			streamClosed = true
			if (keepAliveTimer) {
				clearInterval(keepAliveTimer)
			}
			void logger?.onCancel?.({
				metadata: prepared
					? {
							threadId: prepared.threadId,
							workspaceRoot: prepared.workspaceRoot,
							model: prepared.model,
						}
					: undefined,
			})
			unsubscribe?.()
			prepared?.session.close()
			void prepared?.cleanup()
		},
	})
}
