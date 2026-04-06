import { serve } from 'bun'
import { createApp } from './server/index.js'

const { app, config, hasCodexAuthFile } = createApp()

const server = serve({
	fetch: app.fetch,
	port: config.listenPort,
	hostname: config.listenHost,
	idleTimeout: config.serverIdleTimeoutSec,
})

console.log(`[router] listening on http://${config.listenHost}:${config.listenPort}`)
console.log(`[router] backend=${config.bridgeBackend}`)
console.log(`[router] codex_auth_mode=${config.codexAuthMode}`)
console.log(`[router] codex_auth_file=${config.codexAuthFile}`)
console.log(`[router] codex_auth_file_exists=${hasCodexAuthFile}`)
if (config.bridgeBackend === 'ollama') {
	console.log(`[router] ollama_base_url=${config.ollamaBaseUrl}`)
	console.log(`[router] ollama_model=${config.ollamaModel}`)
	console.log(`[router] ollama_api_key_configured=${Boolean(config.ollamaApiKey)}`)
}
console.log(`[router] codex_runtime_cwd=${config.codexRuntimeCwd}`)
console.log(`[router] request_logging=${config.logRequests}`)
console.log(`[router] request_capture=${config.captureRequests}`)
console.log(`[router] request_capture_path=${config.captureRequestsPath}`)
console.log(`[router] heartbeat_interval_sec=${config.heartbeatIntervalSec}`)
console.log(`[router] idle_timeout_sec=${config.serverIdleTimeoutSec}`)

if (config.heartbeatIntervalSec > 0) {
	setInterval(() => {
		console.log(
			`[router] ${new Date().toISOString()} heartbeat pid=${process.pid} url=http://${config.listenHost}:${config.listenPort} pending_listener=${server.pendingRequests}`,
		)
	}, config.heartbeatIntervalSec * 1000)
}

export { app }
