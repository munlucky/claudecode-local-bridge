# claudecode-codex-local-bridge

`codex app-server`와 로컬 Codex 인증 세션을 기반으로 동작하는 Claude Code용 Anthropic 호환 브리지입니다.

이 프로젝트는 Claude Code가 로컬 HTTP 엔드포인트를 통해 Codex와 통신할 수 있도록 Anthropic API의 일부를 얇게 변환해 주는 용도로 설계되었습니다. 멀티테넌트 운영이나 외부 공개 서비스용이 아니라 로컬 개발, 디버깅, 프로토콜 변환에 초점을 둡니다.

## 제공 기능

- `POST /v1/messages` 제공
- `GET /v1/models` 제공
- `GET /health` 제공
- Anthropic Messages 요청을 Codex app-server turn으로 변환
- Codex 응답을 Anthropic 호환 JSON 및 SSE 스트림으로 재구성
- Claude Code의 `tool_use` / `tool_result` 루프 유지
- Anthropic 모델 ID를 Codex 모델로 매핑

## 요구 사항

- [Bun](https://bun.sh/) `>= 1.1`
- `PATH`에 등록된 `codex` 실행 파일
- 인증 모드 설정(`CODEX_AUTH_MODE`)에 맞는 인증 준비
- `local_auth_json` 모드: `~/.codex/auth.json` 또는 `CODEX_AUTH_FILE`에 유효한 인증 파일 필요
- `account` 모드: `account/read` 계정 인증을 앱 서버가 자체 확인
- `api_key` 모드: `CODEX_OPENAI_API_KEY` 또는 `OPENAI_API_KEY` 필요

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

## Claude Code 연결

Claude Code가 로컬 브리지를 바라보도록 설정합니다.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000
ANTHROPIC_AUTH_TOKEN=dummy
ANTHROPIC_API_KEY=
```

브리지는 inbound Anthropic 토큰을 검증하지 않고, 실제 upstream 인증은 로컬 Codex 세션으로 처리합니다.
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

Ollama backend에서는 `ollama_base_url`, `ollama_model`, `has_ollama_api_key`, `live`, `readiness`만 반환합니다.

`/health`는 위 항목이 `false`이면 503(서비스 점검)으로 반환됩니다.  
`local_auth_json`에서 인증 파일이 없으면 시작 로그에 경고가 기록됩니다.

### `GET /v1/models`

현재 브리지에 매핑된 Anthropic 모델 ID 목록을 반환합니다.

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

## 개발

```bash
bun run typecheck
bun test
bun run build
```

패키징 시에는 `prepack`에서 `bun run build`를 실행하고, 배포 산출물은 `dist/index.js`를 기준으로 사용합니다.

기본 스모크 테스트:

- `GET /health`
- `GET /v1/models`
- `POST /v1/messages` 1회 호출

테스트는 `tests/` 아래에 모아 두었고, 프로덕션 코드는 `src/`에만 둡니다.

추가 검증 기준은 [TEST_GUIDE.md](./TEST_GUIDE.md)를 참고하면 됩니다.

## 라이선스

MIT
