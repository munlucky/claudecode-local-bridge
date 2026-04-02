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
- 유효한 로컬 Codex 인증 파일
  기본값: `~/.codex/auth.json`

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

기본 엔드포인트:

- `http://127.0.0.1:3000/health`
- `http://127.0.0.1:3000/v1/models`
- `http://127.0.0.1:3000/v1/messages`

## Claude Code 연결

Claude Code가 로컬 브리지를 바라보도록 설정합니다.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000
ANTHROPIC_AUTH_TOKEN=dummy
ANTHROPIC_API_KEY=
```

브리지는 inbound Anthropic 토큰을 검증하지 않고, 실제 upstream 인증은 로컬 Codex 세션으로 처리합니다.

## 설정

`.env.template`을 복사한 뒤 필요한 값만 조정하면 됩니다.

핵심 설정:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ROUTER_LISTEN_HOST` | `127.0.0.1` | 바인드 주소 |
| `ROUTER_LISTEN_PORT` | `3000` | HTTP 포트 |
| `CODEX_AUTH_FILE` | `~/.codex/auth.json` | 로컬 Codex 인증 파일 경로 |
| `CODEX_RUNTIME_CWD` | `~/.codex/bridge-runtime` | Codex가 작업하는 기본 디렉터리 |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex 파일/쉘 권한 수준 |
| `CODEX_TURN_TIMEOUT_MS` | `180000` | Codex 한 턴 최대 실행 시간 |
| `ROUTER_IDLE_TIMEOUT_SEC` | `185` | SSE 유휴 타임아웃 |
| `MODEL_ALIASES_JSON` | 미설정 | Anthropic 모델 ID와 Codex 모델 매핑 덮어쓰기 |

디버그 로그와 요청/응답 캡처는 기본적으로 활성화되어 있습니다. `.history/` 아래에 로컬 추적 파일을 남기고 싶지 않다면 다음 값을 끄면 됩니다.

```bash
ROUTER_LOG_REQUESTS=0
ROUTER_CAPTURE_REQUESTS=0
ROUTER_CAPTURE_RESPONSES=0
```

## API 표면

### `GET /health`

런타임 상태, 인증 모드, 실행 명령, 로컬 인증 파일 존재 여부를 반환합니다.

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
3. `codex app-server`의 `thread/start`로 Codex thread를 시작합니다.
4. `turn/start`로 직렬화된 요청을 Codex에 전달합니다.
5. 결과를 Anthropic 호환 JSON 또는 SSE로 변환합니다.
6. 최종 텍스트 응답 또는 다음 `tool_use` 결정을 반환합니다.

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
- `codex app-server`의 로컬 프로토콜에 의존하며, 공개 안정 API 계약이 아닙니다.
- 로컬 Codex 인증 기반 브리지 경로만 지원합니다.
- Inbound Anthropic bearer token은 검증하지 않습니다.
- 요청마다 새 Codex thread를 만들고, 문맥은 들어온 transcript로 재구성합니다.

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
