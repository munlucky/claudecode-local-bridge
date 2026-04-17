# claudecode-codex-local-bridge

Claude Code가 로컬 HTTP 엔드포인트를 통해 `codex app-server`, Ollama, optional `openai-compatible` provider로 라우팅할 수 있게 해주는 Anthropic 호환 브리지입니다.

이 프로젝트는 Anthropic Messages API의 일부를 로컬 브리지 표면으로 얇게 변환하고, 선택된 backend/provider에 맞는 요청/응답 형식으로 다시 매핑하는 용도로 설계되었습니다. 멀티테넌트 운영이나 외부 공개 서비스용이 아니라 로컬 개발, 디버깅, 프로토콜 변환에 초점을 둡니다.

## 제공 기능

- `POST /v1/messages` 제공
- `GET /v1/models` 제공
- `GET /health` 제공
- Anthropic Messages 요청을 Codex, Ollama, optional `openai-compatible` provider 요청으로 변환
- provider 응답을 Anthropic 호환 JSON 및 SSE 스트림으로 재구성
- Claude Code의 `tool_use` / `tool_result` 루프 유지
- Anthropic 모델 ID, provider-qualified model ID, routing alias를 backend/provider target으로 매핑
- selector 기반 `provider/model` 라우팅 지원
- optional `openai-compatible` provider slot 지원

## 요구 사항

- [Bun](https://bun.sh/) `>= 1.1`
- `BRIDGE_BACKEND=codex`를 사용할 경우 `PATH`에 등록된 `codex` 실행 파일
- Codex backend 사용 시 인증 모드 설정(`CODEX_AUTH_MODE`)에 맞는 인증 준비
- `local_auth_json` 모드: `~/.codex/auth.json` 또는 `CODEX_AUTH_FILE`에 유효한 인증 파일 필요
- `account` 모드: `account/read` 계정 인증을 앱 서버가 자체 확인
- `api_key` 모드: `CODEX_OPENAI_API_KEY` 또는 `OPENAI_API_KEY` 필요
- `codex-direct` provider를 사용할 경우 `CODEX_DIRECT_ENABLED=1`과 선택한 direct auth 모드에 맞는 준비 필요
- direct OAuth/auto 모드: `~/.codex/auth-direct.json` 또는 `CODEX_DIRECT_AUTH_STATE_FILE`에 direct auth state 필요
- direct `api_key` 모드: `CODEX_OPENAI_API_KEY` 또는 `OPENAI_API_KEY` 필요
- `BRIDGE_BACKEND=ollama`를 사용할 경우 접근 가능한 `OLLAMA_BASE_URL`과 모델
- optional `openai-compatible` provider를 사용할 경우 `OPENAI_COMPATIBLE_BASE_URL`과 API 키

## 빠른 시작

`.env.template`을 `.env`로 복사한 뒤 서버를 실행합니다.

macOS / Linux:

```bash
bun install
cp .env.template .env
bun run start
```

Windows PowerShell:

```powershell
bun install
Copy-Item .env.template .env
bun run start
```

개발 모드로 실행하려면:

```bash
bun run dev
```

멀티 백엔드 엔드포인트:

- `http://127.0.0.1:3000/health`
 - `http://127.0.0.1:3000/v1/models`
 - `http://127.0.0.1:3000/v1/messages`

백엔드 기본값:

- `BRIDGE_BACKEND=codex` (기본): 기존 로컬 Codex 앱서버 사용
- `BRIDGE_BACKEND=ollama`: Ollama API 기반 사용 (`/api/tags`, `/api/chat`)

`codex-direct` rollout 기본값:

- `CODEX_DIRECT_ENABLED=0` 기본: direct provider 비활성화, 기존 `codex-app-server` 경로 유지
- `CODEX_DIRECT_ENABLED=1` + `CODEX_DIRECT_ROLLOUT=shadow`: `GET /v1/models`에 direct 모델을 provider-qualified ID로 함께 노출하지만 active path는 계속 `codex-app-server`
- `CODEX_DIRECT_ENABLED=1` + `CODEX_DIRECT_ROLLOUT=prefer-direct`: active provider를 `codex-direct`로 전환
- 1차 릴리스 기준 권장 posture는 `shadow` 이하이며, 기본 경로 변경 전에는 회귀 테스트와 rollback 절차를 먼저 확인해야 함

추가 provider routing:

- `provider/model` 형식(`ollama/qwen3.5:27b`, `openai-compatible/gpt-5.4-mini`)으로 명시 라우팅 가능
- `PROVIDER_ROUTING_JSON`으로 skill/family/alias 정책 라우팅 가능
- `GET /v1/models`는 enabled provider들의 모델을 합쳐 노출하며, non-active provider 모델은 provider-qualified ID로 표시됩니다
- `openai-compatible` slot은 현재 provider-qualified model listing + non-stream `/v1/messages` 경로를 우선 지원하며 stream 경로는 아직 미구현입니다
- `openai-compatible` non-stream support matrix:
  - 지원: text 응답, `tool_calls` -> Anthropic `tool_use`, explicit provider routing, skill-policy routing
  - 제한: Anthropic `thinking` request config와 image input block은 현재 명시적으로 거절합니다
  - 제한: stream 요청은 controlled 502로 종료됩니다

## Claude Code 연결

Claude Code가 로컬 브리지를 바라보도록 설정합니다.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000
ANTHROPIC_AUTH_TOKEN=dummy
ANTHROPIC_API_KEY=
```

브리지는 inbound Anthropic 토큰을 검증하지 않습니다. 실제 upstream 인증은 active backend/provider 설정에 따라 Codex 세션, Ollama endpoint, 또는 `openai-compatible` API 키로 처리됩니다.
반드시 `127.0.0.1` 또는 로컬 전용 인터페이스에만 바인딩해야 합니다.

### Ollama backend 사용 예시

```powershell
Copy-Item .env.template .env
@'
BRIDGE_BACKEND=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:27b
'@ | Out-File -FilePath .env -Encoding utf8

bun run start
```

Ollama/qwen 연동 점검(응답 저장 포함):

```powershell
node scripts/verify-ollama-bridge.mjs --base http://127.0.0.1:3000 --model qwen3.5:27b
```

점검 결과는 `.bridge-qa/<timestamp>/` 아래에 요청/응답/스트리밍 청크/요약본으로 저장됩니다.

## 설정

`.env.template`을 복사한 뒤 필요한 값만 조정하면 됩니다.

핵심 설정:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `BRIDGE_BACKEND` | `codex` | `codex` 또는 `ollama` |
| `ROUTER_LISTEN_HOST` | `127.0.0.1` | 바인드 주소 |
| `ROUTER_LISTEN_PORT` | `3000` | HTTP 포트 |
| `CODEX_AUTH_MODE` | `local_auth_json` | 인증 모드 (`disabled`, `local_auth_json`, `account`, `api_key`) |
| `CODEX_AUTH_FILE` | `~/.codex/auth.json` | 로컬 Codex 인증 파일 경로 |
| `CODEX_OPENAI_API_KEY` | 미설정 | `api_key` 모드에서 직접 사용할 OpenAI API 키 |
| `CODEX_DIRECT_ENABLED` | `0` | `codex-direct` provider 노출 여부 |
| `CODEX_DIRECT_ROLLOUT` | `disabled` | `disabled`, `shadow`, `prefer-direct` |
| `CODEX_DIRECT_AUTH_MODE` | `auto` | direct auth 모드 (`disabled`, `oauth`, `api_key`, `auto`) |
| `CODEX_DIRECT_AUTH_STATE_FILE` | `~/.codex/auth-direct.json` | direct OAuth/auth state 파일 경로 |
| `CODEX_DIRECT_BASE_URL` | ChatGPT Codex backend base | direct provider backend override (`.../backend-api/codex` or full `.../responses`) |
| `CODEX_DIRECT_REQUEST_TIMEOUT_MS` | `180000` | direct provider request timeout(ms) |
| `CODEX_RUNTIME_CWD` | `~/.codex/bridge-runtime` | Codex가 작업하는 기본 디렉터리 |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex 파일/쉘 권한 수준 |
| `CODEX_TURN_TIMEOUT_MS` | `180000` | Codex 한 턴 최대 실행 시간 |
| `CODEX_TURN_REQUEST_TIMEOUT_MS` | `180000` | `turn/start` 요청만의 타임아웃 |
| `ROUTER_IDLE_TIMEOUT_SEC` | `185` | SSE 유휴 타임아웃 |
| `ROUTER_CAPTURE_MAX_FILE_BYTES` | `5242880` | 캡처 파일 rotate 기준 크기(byte) |
| `ROUTER_CAPTURE_RETENTION_DAYS` | `7` | 캡처 파일 보존 일수 |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama 서버 주소 |
| `OLLAMA_MODEL` | `qwen3.5:27b` | Ollama 기본 모델 |
| `OLLAMA_API_KEY` | 미설정 | Ollama 인증키 (필요 시) |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `120000` | Ollama 요청 타임아웃(ms) |
| `OLLAMA_SHOW_THINKING` | `0` | `message.thinking` 응답 포함 여부 (`1`이면 포함) |
| `OLLAMA_MODEL_ALIASES_JSON` | 미설정 | Anthropic/Ollama 요청 모델명과 실제 Ollama 모델명 매핑 |
| `MODEL_ALIASES_JSON` | 미설정 | Anthropic 모델 ID와 Codex 모델 매핑 덮어쓰기 |
| `PROVIDER_ROUTING_JSON` | 미설정 | skill/family/alias 기반 provider routing 정책 JSON |
| `OPENAI_COMPATIBLE_BASE_URL` | 미설정 | OpenAI-compatible provider base URL (`/v1/models`, `/v1/chat/completions`) |
| `OPENAI_COMPATIBLE_API_KEY` | 미설정 | OpenAI-compatible provider API 키 |
| `OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS` | `120000` | OpenAI-compatible `/v1/models`, `/v1/chat/completions` 요청 타임아웃(ms) |

`PROVIDER_ROUTING_JSON` 예시:

```json
{
  "aliases": {
    "fast": "openai-compatible/gpt-5.4-mini"
  },
  "skillPolicies": {
    "review": "openai-compatible/gpt-5.4-mini"
  },
  "providerDefaults": {
    "openai-compatible": "gpt-5.4-mini"
  }
}
```

`codex-direct` shadow rollout 예시:

```bash
BRIDGE_BACKEND=codex
CODEX_DIRECT_ENABLED=1
CODEX_DIRECT_ROLLOUT=shadow
CODEX_DIRECT_AUTH_MODE=auto
```

이 설정에서는 `/health`가 계속 `codex_app_server` readiness를 보여주고, `/v1/models`에는 `codex-direct/...` provider-qualified 모델이 추가로 노출됩니다. 실제 direct 경로 smoke는 `codex-direct/<model>` 또는 `prefer-direct` 전환 후에만 수행하세요.

디버그 로그와 요청/응답 캡처는 기본적으로 활성화되어 있습니다. `.history/` 아래에 로컬 추적 파일을 남기고 싶지 않다면 다음 값을 끄면 됩니다.

```bash
ROUTER_LOG_REQUESTS=0
ROUTER_CAPTURE_REQUESTS=0
ROUTER_CAPTURE_RESPONSES=0
```

캡처를 켜 두면 `.history/*.jsonl`은 기본적으로 5MB 초과 시 rotate 되며 7일이 지난 파일은 정리됩니다.

### 토큰 분석 로그

요청/응답 캡처 파일(`ROUTER_CAPTURE_REQUESTS_PATH`, `ROUTER_CAPTURE_RESPONSES_PATH`)은 사용자 입력 대비 Codex 전달 토큰의 추이를 분석할 수 있습니다.

- 요청 로그(`anthropic-requests.jsonl`)에는 `anonymous_conversation_seed`와 `tool_names`가 기록됩니다.
- 응답 로그(`anthropic-responses.jsonl`)에는 Codex 사용량이 기록되며, 주요 필드는 다음과 같습니다.
  - `usage_input_tokens`
  - `usage_cached_input_tokens`
  - `usage_reasoning_output_tokens`
  - `usage_total_tokens`
  - `prompt_metrics.estimatedPromptTokens`
  - `prompt_metrics.estimatedUserVisibleTokens`
  - `prompt_metrics.promptMode`
  - `prompt_metrics.replayFromMessageIndex`
  - `thread_mode`, `thread_reuse_reason`

빠른 분석 예시:

```bash
# 한 번의 요청에서 사용자 입력(추정) 대비 Codex 입력 토큰 비교
jq -r '
  select(.type=="response") |
  [.timestamp, .router_request_id, .prompt_metrics.estimatedUserVisibleTokens, .usage_input_tokens, .usage_cached_input_tokens, .thread_mode, .thread_reuse_reason]
  | @tsv
' .history/anthropic-responses.jsonl | head

# 세션/쓰레드 재사용률 확인
jq -r '
  select(.type=="response" and .thread_mode!=null) |
  .thread_mode
' .history/anthropic-responses.jsonl | sort | uniq -c
```

## API 표면

### `GET /health`

런타임 상태를 반환합니다. 응답 필드는 활성 backend에 맞춰 분리됩니다.

응답 예시(예: `/health`):

```json
{
  "status": "ok",
  "backend": "codex_app_server",
  "auth_mode": "local_auth_json",
  "codex_command": "codex",
  "codex_runtime_cwd": "/Users/me/.codex/bridge-runtime",
  "codex_auth_file": "/Users/me/.codex/auth.json",
  "has_local_auth_file": true,
  "has_auth_mode_dependency": true,
  "live": true,
  "readiness": "ready",
  "queue_depth": 0,
  "active_session_count": 0,
  "pending_session_creates": 0,
  "recent_retryable_failures": 0,
  "recent_non_retryable_failures": 0,
  "recent_retries": 0
}
```

Codex backend에서만:

`has_local_auth_file`는 `CODEX_AUTH_FILE` 존재 여부만 나타내며,  
`has_auth_mode_dependency`는 현재 `CODEX_AUTH_MODE` 기준으로 실제 인증 선행 조건 충족 여부를 의미합니다.
- `local_auth_json`: 인증 파일 존재 여부
- `api_key`: `CODEX_OPENAI_API_KEY` 또는 `OPENAI_API_KEY` 존재 여부
- `account`: `account/read` 또는 구버전 `getAuthStatus` 호출로 실제 인증 존재 여부 판정
- `disabled`: `true`

Codex 추가 health 필드:
- `live`: 프로세스 생존 여부
- `readiness`: 현재 인증/런타임 준비 상태
- `queue_depth`, `active_session_count`, `pending_session_creates`: 세션 캐시와 대기 상태
- `recent_retryable_failures`, `recent_non_retryable_failures`, `recent_retries`: 최근 브리지 실패/재시도 카운터

`codex-direct`가 active provider인 경우 `/health`는 `backend: "codex_direct_api"`로 응답하며 다음 direct 전용 필드를 포함합니다.

- `codex_direct_rollout`
- `codex_direct_base_url`
- `codex_direct_auth_state_file`
- `has_codex_direct_auth_state`
- `codex_direct_auth_state`

Rollback이 필요하면 `CODEX_DIRECT_ROLLOUT=disabled` 또는 `shadow`로 되돌리고 `BRIDGE_BACKEND=codex` 기본 경로를 유지하면 됩니다.

Ollama backend에서는 `ollama_base_url`, `ollama_model`, `has_ollama_api_key`, `live`, `readiness`만 반환합니다.

`/health`는 위 항목이 `false`이면 503(서비스 점검)으로 반환됩니다.  
`local_auth_json`에서 인증 파일이 없으면 시작 로그에 경고가 기록됩니다.

### `GET /v1/models`

enabled provider들의 모델 목록을 반환합니다. active provider의 legacy 모델 ID는 그대로 노출되고, 추가 provider 모델은 `openai-compatible/gpt-5.4-mini` 같은 provider-qualified ID로 노출됩니다.

### `POST /v1/messages`

지원하는 요청 필드:

- `messages`
- `system`
- `stream`
- `tools`
- `tool_choice`
- `thinking`
- `temperature`
- `top_p`
- `top_k`

## 동작 방식

1. Claude Code가 보낸 Anthropic Messages 요청을 받습니다.
2. 요청 본문을 검증하고 정규화합니다.
3. `BRIDGE_BACKEND`에 따라 Codex 또는 Ollama provider로 라우팅합니다.
4. Anthropic request/response를 provider 포맷으로 변환한 뒤 실행합니다.
5. 결과를 Anthropic 호환 JSON 또는 SSE로 변환해 반환합니다.
6. 최종 텍스트 응답 또는 다음 `tool_use` 결정을 반환합니다.

지원 정책:

- `thinking`은 기본적으로 응답 본문에서 제거됩니다.
- `tool_calls`는 Anthropic `tool_use` 블록으로 정규화됩니다.
- Ollama 스트리밍은 줄단위 JSON을 Anthropic SSE로 매핑합니다.
- `openai-compatible` non-stream은 현재 text/tool 중심 경로만 지원하며, unsupported feature는 upstream 호출 전 브리지에서 거절합니다.

## 프로젝트 구조

프로덕션 코드와 테스트 코드를 분리해 두었습니다.

```text
src/
├─ index.ts
├─ server/           # HTTP 엔트리, 설정, 스트리밍 어댑터
├─ bridge/
│  ├─ anthropic/     # Anthropic 요청/응답 변환, tool bridge
│  └─ codex/         # Codex app-server 세션, 로컬 인증
├─ observability/    # 요청/응답 추적, JSONL 캡처
└─ shared/           # 공용 타입과 계약

tests/
├─ server/
├─ bridge/
│  ├─ anthropic/
│  └─ codex/
└─ observability/

dist/
└─ index.js          # bun run build 결과물
```

모듈 간 import는 가능하면 각 디렉터리의 `index.ts` barrel export를 통해 진입합니다.

## 제한 사항

- 로컬 사용 전제입니다. 외부 인터넷에 직접 노출하면 안 됩니다.
- inbound bearer token은 검증하지 않으므로 reverse proxy 없이 외부 바인딩하면 안 됩니다.
- `codex app-server`의 로컬 프로토콜에 의존하며, 공개 안정 API 계약이 아닙니다.
- 인증은 Codex app-server 세션 기준이며 `local_auth_json`/`account`/`api_key` 모드를 지원합니다.
- Inbound Anthropic bearer token은 검증하지 않습니다.
- `x-claude-code-session-id`가 있으면 동일 workspace 안에서 Codex app-server 세션과 thread를 재사용합니다.
- 구버전 Claude Code처럼 session header가 없는 경우에는 동일 workspace + 동일 CLI user agent + 요청에서 추출한 대화 seed에 대해 짧은 TTL 기반 fallback 재사용을 시도합니다.
- 재사용된 thread가 더 이상 유효하지 않으면 같은 세션에서 새 thread를 다시 만들고, 세션 자체가 깨졌으면 캐시 세션을 교체합니다.

## 운영 런북

운영/장애 대응 절차는 [docs/runbook.md](./docs/runbook.md)를 참고합니다.

## 워크플로 문서

- 운영/장애 대응: [docs/runbook.md](./docs/runbook.md)
- PR 체크리스트: [workflow/PR_CHECKLIST.md](./workflow/PR_CHECKLIST.md)
- 릴리스 절차: [workflow/RELEASE_PLAYBOOK.md](./workflow/RELEASE_PLAYBOOK.md)
- 저장소 워크플로 개요: [workflow/README.md](./workflow/README.md)
- 추가 검증 기준: [TEST_GUIDE.md](./TEST_GUIDE.md)

## 개발

```bash
bun run typecheck
bun test tests
bun run build
```

패키징 시에는 `prepack`에서 `bun run build`를 실행하고, 배포 산출물은 `dist/index.js`를 기준으로 사용합니다.

기본 스모크 테스트:

- `GET /health`
- `GET /v1/models`
- `POST /v1/messages` 1회 호출

테스트는 `tests/` 아래에 모아 두었고, 프로덕션 코드는 `src/`에만 둡니다.

추가 검증 기준은 [TEST_GUIDE.md](./TEST_GUIDE.md)를 참고하면 됩니다.

`.claude/**`, workflow-core, verifier script를 바꾸는 작업은 [workflow/README.md](./workflow/README.md)와 `.claude/verification.contract.yaml`에 선언된 검증 명령을 함께 확인해야 합니다.

## 라이선스

MIT
