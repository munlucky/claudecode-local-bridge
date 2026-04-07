#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
  printHelp();
  process.exit(0);
}

const config = {
  baseUrl: argv.base || process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:3000',
  model: argv.model || process.env.OLLAMA_MODEL || null,
  timeoutMs: Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS || argv.timeout || 120000),
  outputDir:
    argv.out || process.env.BRIDGE_OUTPUT_DIR || path.join(process.cwd(), '.bridge-qa'),
};

if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
  console.error('timeout은 1 이상의 숫자여야 합니다.');
  process.exit(1);
}

const runId = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+/, '')
  .replace('T', '-')
  .replace('Z', '');
const reportDir = path.join(config.outputDir, runId);

const scenarios = [
  {
    id: '01-chat',
    label: '일반 텍스트 응답',
    body: {
      model: config.model,
      max_tokens: 256,
      stream: false,
      messages: [
        {
          role: 'user',
          content: '안녕하세요. 본문 한 문장으로 자기소개를 부탁해.',
        },
      ],
    },
    expected: {
      minContentBlocks: 1,
      mustIncludeText: true,
      shouldStream: false,
    },
  },
  {
    id: '02-tool-chat',
    label: 'tool_calls 응답',
    body: {
      model: config.model,
      max_tokens: 512,
      stream: false,
      messages: [
        {
          role: 'user',
          content:
            '주어진 툴을 반드시 사용해서 계산해 줘요. 수식: 19 + 23',
        },
      ],
      tools: [
        {
          name: 'add_numbers',
          description: '두 수의 합을 계산',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'add_numbers' },
    },
    expected: {
      requiresToolCall: true,
      shouldStream: false,
    },
  },
  {
    id: '03-stream',
    label: '스트리밍 응답',
    body: {
      model: config.model,
      max_tokens: 256,
      stream: true,
      messages: [
        {
          role: 'user',
          content:
            '퀘스천: 다음 항목을 3개로 간단히 나열해줘. 각 항목은 한 줄만.',
        },
      ],
    },
    expected: {
      shouldStream: true,
      hasAtLeastOneChunk: true,
      mustFinish: true,
      mustIncludeText: true,
    },
  },
];

async function main() {
  await fs.mkdir(reportDir, { recursive: true });
  const summary = {
    startedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    scenarios: [],
    overall: { passed: 0, failed: 0, skipped: 0 },
  };

  await writeJson(
    path.join(reportDir, '00-health-request.json'),
    { method: 'GET', endpoint: '/health' },
    true
  );
  const health = await runRequest({
    id: '00-health',
    label: '헬스 체크',
    method: 'GET',
    endpoint: '/health',
    body: null,
    expected: { statusOk: true },
    parser: readNonStreamJson,
  });
  summary.scenarios.push(health.result);
  if (!config.model) {
    config.model = health.responseRecord?.data?.ollama_model || 'qwen3.5:27b';
    summary.model = config.model;
  }

  for (const scenario of scenarios) {
    scenario.body.model = config.model;
    const endpoint = '/v1/messages';
    const requestFile = path.join(reportDir, `${scenario.id}-request.json`);
    const result = await runRequest({
      id: scenario.id,
      label: scenario.label,
      method: 'POST',
      endpoint,
      body: scenario.body,
      expected: scenario.expected,
      parser: scenario.expected.shouldStream ? readSseStream : readNonStreamJson,
      requestFile,
    });
    summary.scenarios.push(result.result);
  }

  summary.finishedAt = new Date().toISOString();
  summary.overall.passed = summary.scenarios.filter((s) => s.status === 'passed').length;
  summary.overall.failed = summary.scenarios.filter((s) => s.status === 'failed').length;
  summary.overall.skipped = summary.scenarios.filter((s) => s.status === 'skipped').length;

  await writeJson(path.join(reportDir, '08-summary.json'), summary, true);
  await writeMarkdownReport(summary, reportDir);

  console.log(`\n검사 완료: ${reportDir}`);
  console.log(
    `결과: ${summary.overall.passed} passed, ${summary.overall.failed} failed, ${summary.overall.skipped} skipped`
  );
  console.log(
    `요약 파일: ${path.relative(process.cwd(), path.join(reportDir, '08-summary.json'))}`
  );
}

async function runRequest({
  id,
  label,
  method,
  endpoint,
  body,
  expected,
  parser,
  requestFile,
}) {
  const url = `${config.baseUrl.replace(/\/$/, '')}${endpoint}`;
  const started = new Date().toISOString();
  const requestRecord = {
    id,
    label,
    url,
    method,
    timeoutMs: config.timeoutMs,
    body,
    headers: {
      'content-type': 'application/json',
    },
    expected,
  };

  if (requestFile && body) {
    await writeJson(requestFile, { request: requestRecord }, true);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  let bodyData;
  let responseRecord = null;
  let ok = true;
  const checks = [];
  const issues = [];

  try {
    response = await fetch(url, {
      method,
      headers: method === 'GET' ? undefined : requestRecord.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - Date.parse(started);
    const parseResult = await parser(response);
    bodyData = parseResult.data;
    responseRecord = {
      status: response.status,
      statusText: response.statusText,
      elapsedMs,
      headers: extractHeaders(response.headers),
      data: bodyData,
    };

    await writeJson(path.join(reportDir, `${id}-response.json`), responseRecord, true);

    if (id === '00-health') {
      if (response.status >= 200 && response.status < 300) {
        checks.push('health-ok');
      } else {
        ok = false;
        issues.push(`health status=${response.status}`);
      }
    } else if (response.status !== 200) {
      ok = false;
      issues.push(`예상 응답 200, 실제 ${response.status}`);
    } else {
      ok = evaluateScenario({
        id,
        expected,
        body: parseResult,
        response: responseRecord,
        checks,
        issues,
      });
    }
  } catch (error) {
    ok = false;
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`요청 실패: ${message}`);
    responseRecord = {
      status: null,
      statusText: null,
      elapsedMs: Date.now() - Date.parse(started),
      headers: {},
      data: {
        type: 'error',
        error: {
          message,
        },
      },
    };
    await writeJson(path.join(reportDir, `${id}-response.json`), responseRecord, true);
  } finally {
    clearTimeout(timer);
  }

  if (id !== '00-health') {
    await writeJson(
      path.join(reportDir, `${id}-result.json`),
      {
        id,
        label,
        started,
        finishedAt: new Date().toISOString(),
        status: ok ? 'passed' : 'failed',
        checks,
        issues,
      },
      true
    );
  }

  if (bodyData && bodyData.kind === 'sse') {
    await fs.writeFile(
      path.join(reportDir, `${id}-chunks.txt`),
      bodyData.rawLines.join('\n'),
      'utf8'
    );
    await writeJson(path.join(reportDir, `${id}-events.jsonl`), bodyData.parsedLines, true, true);
  }

  return {
    result: {
      id,
      label,
      status: ok ? 'passed' : 'failed',
      responseStatus: response ? response.status : null,
      responseStatusText: response ? response.statusText : null,
      checks,
      issues,
      responseFile: path.relative(process.cwd(), path.join(reportDir, `${id}-response.json`)),
      requestFile: body
        ? path.relative(process.cwd(), requestFile || path.join(reportDir, `${id}-request.json`))
        : null,
      startedAt: started,
      finishedAt: new Date().toISOString(),
    },
    responseRecord,
  };
}

function evaluateScenario({ id, expected, body, response, checks, issues }) {
  if (!body || !body.data) {
    issues.push('응답 본문 파싱 실패');
    return false;
  }

  if (!expected?.shouldStream && response.status >= 400) {
    issues.push(`HTTP 에러 응답 ${response.status}`);
    return false;
  }

  if (id === '00-health') {
    return true;
  }

  if (id === '02-tool-chat' && expected?.requiresToolCall) {
    const hasToolCall = hasToolCallInObject(body.data);
    if (!hasToolCall) {
      issues.push('tool 호출 블록이 감지되지 않았습니다');
      return false;
    }
    checks.push('tool-call-detected');
  }

  if (id === '03-stream') {
    const streamBody = body.data;
    if (expected?.hasAtLeastOneChunk && streamBody.chunkCount < 1) {
      issues.push('스트리밍 청크가 수신되지 않았습니다');
      return false;
    }
    if (expected?.mustFinish && !streamBody.doneReceived) {
      issues.push('DONE 신호를 받지 못했습니다');
      return false;
    }
    if (expected?.mustIncludeText && !streamBody.hasTextContent) {
      issues.push('스트리밍 텍스트 콘텐츠가 없습니다');
      return false;
    }
    checks.push('stream-chunks');
    if (expected?.mustIncludeText) {
      checks.push('stream-text-check');
    }
  }

  if (!expected?.shouldStream && (expected?.minContentBlocks || expected?.mustIncludeText)) {
    const content = body.data?.content;
    if (!Array.isArray(content) || content.length < (expected.minContentBlocks || 1)) {
      issues.push('content 블록이 부족합니다');
      return false;
    }
    if (expected.mustIncludeText) {
      const hasText = content.some(
        (block) => typeof block?.text === 'string' && block.text.trim().length > 0
      );
      if (!hasText) {
        issues.push('텍스트 콘텐츠가 없습니다');
        return false;
      }
    }
    checks.push('content-block-check');
  }

  checks.push('ok');
  return true;
}

async function readNonStreamJson(response) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    return { data: { raw: text, kind: 'text', parseError: String(error) } };
  }
  return { data };
}

async function readSseStream(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      data: {
        kind: 'sse',
        chunkCount: 0,
        doneReceived: false,
        parsedLines: [],
        rawLines: [],
        contentText: '',
        hasTextContent: false,
        hasMeaningfulContent: false,
      },
    };
  }

  const decoder = new TextDecoder('utf-8');
  let remainder = '';
  const parsedLines = [];
  const rawLines = [];
  let chunkCount = 0;
  let doneReceived = false;
  let body = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = body.indexOf('\n')) !== -1) {
      const line = body.slice(0, idx).trimEnd();
      body = body.slice(idx + 1);
      if (line.length === 0) continue;
      processSseLine({
        line,
        rawLines,
        parsedLines,
        onChunk: () => {
          chunkCount += 1;
        },
        onDone: () => {
          doneReceived = true;
        },
      });
    }
  }

  if (body.trim().length > 0) {
    processSseLine({
      line: body.trim(),
      rawLines,
      parsedLines,
      onChunk: () => {
        chunkCount += 1;
      },
      onDone: () => {
        doneReceived = true;
      },
    });
  }

  const streamSummary = summarizeSseContent(parsedLines);

  return {
    data: {
      kind: 'sse',
      chunkCount,
      doneReceived,
      parsedLines,
      rawLines,
      contentText: streamSummary.contentText,
      hasTextContent: streamSummary.hasTextContent,
      hasMeaningfulContent: streamSummary.hasMeaningfulContent,
      content:
        parsedLines.length && typeof parsedLines[parsedLines.length - 1]?.message === 'object'
          ? parsedLines.at(-1).message?.content
          : null,
    },
  };
}

function processSseLine({ line, rawLines, parsedLines, onChunk, onDone }) {
  rawLines.push(line);
  if (!line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload) return;

  if (payload === '[DONE]') {
    onDone();
    return;
  }

  try {
    const parsed = JSON.parse(payload);
    parsedLines.push(parsed);
    onChunk();
    if (parsed?.type === 'message_stop') {
      onDone();
    }
  } catch {
    parsedLines.push({ parseError: true, raw: payload });
  }
}

function summarizeSseContent(parsedLines) {
  let contentText = '';
  let hasToolUse = false;

  for (const parsed of parsedLines) {
    if (!parsed || typeof parsed !== 'object') continue;

    if (parsed.type === 'content_block_start') {
      if (parsed.content_block?.type === 'tool_use') {
        hasToolUse = true;
      }
      if (
        parsed.content_block?.type === 'text' &&
        typeof parsed.content_block.text === 'string' &&
        parsed.content_block.text.length > 0
      ) {
        contentText += parsed.content_block.text;
      }
    }

    if (
      parsed.type === 'content_block_delta' &&
      parsed.delta?.type === 'text_delta' &&
      typeof parsed.delta.text === 'string'
    ) {
      contentText += parsed.delta.text;
    }
  }

  const hasTextContent = contentText.trim().length > 0;

  return {
    contentText,
    hasTextContent,
    hasMeaningfulContent: hasTextContent || hasToolUse,
  };
}

function hasToolCallInObject(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasToolCallInObject(item));
  }

  if (typeof value.type === 'string' && value.type.includes('tool')) return true;
  if (value.type === 'tool_use') return true;
  if (value.type === 'tool_calls' || value.type === 'tool_call') return true;

  if (Array.isArray(value.content)) {
    if (value.content.some((entry) => hasToolCallInObject(entry))) return true;
  }

  if (Array.isArray(value.delta?.content)) {
    if (value.delta.content.some((entry) => hasToolCallInObject(entry))) return true;
  }

  if (Array.isArray(value.tool_calls)) return value.tool_calls.length > 0;
  return Object.values(value).some((entry) => hasToolCallInObject(entry));
}

function extractHeaders(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() !== 'set-cookie' && key.toLowerCase() !== 'transfer-encoding') {
      out[key] = value;
    }
  }
  return out;
}

async function writeJson(filePath, data, pretty = false, forceJsonl = false) {
  const text = forceJsonl
    ? `${data.map((item) => JSON.stringify(item)).join('\n')}\n`
    : JSON.stringify(data, null, pretty ? 2 : 0);
  await fs.writeFile(filePath, text, 'utf8');
}

async function writeMarkdownReport(summary, outputDir) {
  const lines = [
    '# Ollama 호환성 점검 결과',
    `- 실행 시간: ${summary.startedAt} ~ ${summary.finishedAt}`,
    `- 모델: ${summary.model}`,
    `- 베이스 URL: ${summary.baseUrl}`,
    '',
    '| 시나리오 | 상태 | 체크 | 이슈 |',
    '| --- | --- | --- | --- |',
  ];

  for (const item of summary.scenarios) {
    const status = item.status === 'passed' ? 'PASS' : 'FAIL';
    lines.push(
      `| ${item.label} | ${status} | ${item.checks.join(', ') || '-'} | ${(
        item.issues || []
      ).join('; ') || '-'} |`
    );
  }

  lines.push(
    '',
    `- 총합: PASS ${summary.overall.passed}, FAIL ${summary.overall.failed}, SKIP ${summary.overall.skipped}`
  );

  await fs.writeFile(path.join(outputDir, '08-report.md'), `${lines.join('\n')}\n`, 'utf8');
}

function parseArgs(args) {
  const out = {
    timeout: undefined,
    base: undefined,
    model: undefined,
    out: undefined,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const [name, valueRaw] = token.slice(2).split('=');
    const value = valueRaw ?? args[i + 1];
    if (!valueRaw && value?.startsWith('--')) continue;
    if (name === 'help') {
      out.help = true;
      continue;
    }
    if (name === 'timeout') {
      out.timeout = Number(value);
      i += valueRaw ? 0 : 1;
      continue;
    }
    if (name === 'base') {
      out.base = value;
      i += valueRaw ? 0 : 1;
      continue;
    }
    if (name === 'model') {
      out.model = value;
      i += valueRaw ? 0 : 1;
      continue;
    }
    if (name === 'out') {
      out.out = value;
      i += valueRaw ? 0 : 1;
      continue;
    }
  }
  return out;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/verify-ollama-bridge.mjs [--base URL] [--model MODEL] [--timeout ms] [--out DIR] [--help]

Examples:
  node scripts/verify-ollama-bridge.mjs
  node scripts/verify-ollama-bridge.mjs --base http://127.0.0.1:3000 --model qwen3.5:27b --out .bridge-qa

Env:
  BRIDGE_BASE_URL           기본: http://127.0.0.1:3000
  OLLAMA_MODEL             기본: qwen3.5:27b
  BRIDGE_REQUEST_TIMEOUT_MS 타임아웃 기본값(ms), 기본: 120000
  BRIDGE_OUTPUT_DIR         결과 저장 기본 폴더(.bridge-qa)
`);
}

main().catch((error) => {
  console.error('실행 중 오류:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
