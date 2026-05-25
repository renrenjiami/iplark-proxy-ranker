#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkerPath = path.join(__dirname, 'iplark-checker.mjs');
const args = parseArgs(process.argv.slice(2));

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      sendHtml(response);
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, { ok: true });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/check') {
      const body = await readJson(request);
      const proxy = String(body.proxy || '').trim();
      if (!proxy) {
        sendJson(response, { ok: false, error: '代理不能为空' }, 400);
        return;
      }

      const result = await runChecker({
        proxy,
        scheme: body.scheme,
        timeout: Number(body.timeout || args.timeout),
      });
      sendJson(response, result, result.ok ? 200 : 502);
      return;
    }

    sendJson(response, { ok: false, error: 'Not found' }, 404);
  } catch (error) {
    sendJson(response, { ok: false, error: error.message }, 500);
  }
});

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`IPLark WebUI: http://127.0.0.1:${address.port}`);
});

function parseArgs(argv) {
  const parsed = {
    port: 8787,
    timeout: 30000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      parsed.port = Number(requiredValue(argv, ++index, '--port'));
    } else if (arg === '--timeout') {
      parsed.timeout = Number(requiredValue(argv, ++index, '--timeout'));
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error('--port 需要是 1-65535 的端口号');
  }
  if (!Number.isFinite(parsed.timeout) || parsed.timeout < 1000) {
    throw new Error('--timeout 需要是大于 1000 的毫秒数');
  }

  return parsed;
}

function requiredValue(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} 缺少参数值`);
  }
  return value;
}

function printHelp() {
  console.log(`IPLark WebUI

用法:
  node scripts/iplark-webui.mjs
  node scripts/iplark-webui.mjs --port 8787 --timeout 30000
`);
}

function runChecker(options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const childArgs = [
      checkerPath,
      options.proxy,
      '--json',
      '--timeout',
      String(options.timeout),
    ];

    if (options.scheme && options.scheme !== 'auto') {
      childArgs.push('--scheme', options.scheme);
    }

    const child = spawn(process.execPath, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
    }, Math.max(options.timeout + 30000, 30000));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: sanitizeError(error.message, options.proxy),
      });
    });
    child.once('exit', (code) => {
      clearTimeout(killTimer);
      const elapsedMs = Date.now() - startedAt;
      const parsed = parseCheckerJson(stdout);
      if (parsed) {
        resolve({ ok: true, elapsedMs, data: parsed });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          elapsedMs,
          error: sanitizeError(stderr || stdout || `checker exited with code ${code}`, options.proxy),
        });
        return;
      }

      resolve({
        ok: false,
        elapsedMs,
        error: 'checker 没有返回 JSON 结果',
      });
    });
  });
}

function parseCheckerJson(stdout) {
  const text = stdout.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体太大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求 JSON 格式不正确'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response) {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

function sanitizeError(message, proxy) {
  let text = String(message || '').trim();
  if (proxy) {
    text = text.replaceAll(proxy, maskProxy(proxy));
  }
  return text.replace(/\/\/([^/@\s]+)@/g, '//***:***@').replace(/(^|\s)([^/\s:@]+:[^@\s]+)@/g, '$1***:***@');
}

function maskProxy(proxy) {
  return proxy.replace(/\/\/([^/@]+)@/, '//***:***@').replace(/^([^/@]+)@/, '***:***@');
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IPLark Proxy Ranker</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #18212f;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #0f766e;
      --accent-2: #2563eb;
      --danger: #b42318;
      --warn: #a15c07;
      --ok: #067647;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    header {
      background: #ffffff;
      border-bottom: 1px solid var(--line);
      padding: 16px 22px;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }

    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 18px 22px 28px;
      display: grid;
      gap: 14px;
    }

    .controls {
      display: grid;
      grid-template-columns: minmax(340px, 1fr) 360px;
      gap: 14px;
      align-items: stretch;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .input-panel {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 260px;
    }

    .panel-title {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }

    textarea {
      width: 100%;
      min-height: 220px;
      resize: vertical;
      border: 0;
      outline: 0;
      padding: 12px 14px;
      color: var(--text);
      background: #ffffff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.55;
    }

    .settings {
      padding: 14px;
      display: grid;
      gap: 12px;
      align-content: start;
    }

    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }

    input,
    select {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--text);
      background: #ffffff;
    }

    .button-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 2px;
    }

    button {
      height: 38px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
      font-weight: 650;
    }

    button.primary {
      background: var(--accent);
      color: #ffffff;
    }

    button.secondary {
      background: #ffffff;
      color: var(--text);
      border-color: var(--line);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.56;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 10px;
    }

    .stat {
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      box-shadow: var(--shadow);
    }

    .stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }

    .stat strong {
      display: block;
      margin-top: 3px;
      font-size: 20px;
      line-height: 1.1;
    }

    .table-wrap {
      overflow: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1100px;
    }

    th,
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f8fafc;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }

    .proxy-cell {
      position: relative;
      cursor: pointer;
      outline: 0;
    }

    .proxy-cell:hover,
    .proxy-cell:focus-visible {
      background: #f0fdfa;
      color: var(--accent);
    }

    .proxy-cell.copied {
      background: #ecfdf3;
      color: var(--ok);
    }

    .proxy-cell.copy-failed {
      background: #fef3f2;
      color: var(--danger);
    }

    .proxy-cell.copied::after,
    .proxy-cell.copy-failed::after {
      position: absolute;
      top: 8px;
      right: 8px;
      border-radius: 999px;
      padding: 1px 7px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 11px;
      font-weight: 700;
      background: #ffffff;
      box-shadow: 0 0 0 1px var(--line);
    }

    .proxy-cell.copied::after {
      content: "已复制";
    }

    .proxy-cell.copy-failed::after {
      content: "复制失败";
    }

    .score {
      font-weight: 750;
      color: var(--accent-2);
    }

    .badge {
      display: inline-block;
      min-width: 48px;
      border-radius: 999px;
      padding: 2px 8px;
      text-align: center;
      font-size: 12px;
      font-weight: 700;
      background: #eef4ff;
      color: #175cd3;
    }

    .badge.ok { background: #ecfdf3; color: var(--ok); }
    .badge.fail { background: #fef3f2; color: var(--danger); }
    .badge.wait { background: #fff7ed; color: var(--warn); }

    .muted {
      color: var(--muted);
    }

    .error {
      color: var(--danger);
      max-width: 360px;
    }

    @media (max-width: 900px) {
      main { padding: 14px; }
      .controls { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>IPLark Proxy Ranker</h1>
    </header>
    <main>
      <section class="controls">
        <div class="panel input-panel">
          <div class="panel-title">代理列表</div>
          <textarea id="proxyInput" spellcheck="false" placeholder="user:pass@host:port&#10;http://user:pass@host:port&#10;socks5h://user:pass@host:port"></textarea>
        </div>
        <div class="panel settings">
          <label>
            协议
            <select id="schemeInput">
              <option value="auto">自动</option>
              <option value="http">HTTP</option>
              <option value="socks5h">SOCKS5H</option>
            </select>
          </label>
          <label>
            并发数
            <input id="concurrencyInput" type="number" min="1" max="5" value="2">
          </label>
          <label>
            单条超时（毫秒）
            <input id="timeoutInput" type="number" min="5000" step="1000" value="30000">
          </label>
          <div class="button-row">
            <button id="startButton" class="primary">开始检测</button>
            <button id="stopButton" class="secondary" disabled>停止排队</button>
          </div>
        </div>
      </section>

      <section class="stats">
        <div class="stat"><span>总数</span><strong id="totalStat">0</strong></div>
        <div class="stat"><span>完成</span><strong id="doneStat">0</strong></div>
        <div class="stat"><span>成功</span><strong id="okStat">0</strong></div>
        <div class="stat"><span>失败</span><strong id="failStat">0</strong></div>
        <div class="stat"><span>最佳分数</span><strong id="bestStat">-</strong></div>
      </section>

      <section class="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>排名</th>
              <th>代理</th>
              <th>出口 IP</th>
              <th>分数</th>
              <th>纯净度</th>
              <th>代理识别</th>
              <th>ASN / 企业</th>
              <th>耗时</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody id="resultBody"></tbody>
        </table>
      </section>
    </main>
  </div>

  <script>
    const state = {
      active: 0,
      cancelQueued: false,
      cursor: 0,
      rows: [],
    };

    const el = {
      bestStat: document.getElementById('bestStat'),
      concurrencyInput: document.getElementById('concurrencyInput'),
      doneStat: document.getElementById('doneStat'),
      failStat: document.getElementById('failStat'),
      okStat: document.getElementById('okStat'),
      proxyInput: document.getElementById('proxyInput'),
      resultBody: document.getElementById('resultBody'),
      schemeInput: document.getElementById('schemeInput'),
      startButton: document.getElementById('startButton'),
      stopButton: document.getElementById('stopButton'),
      timeoutInput: document.getElementById('timeoutInput'),
      totalStat: document.getElementById('totalStat'),
    };

    el.startButton.addEventListener('click', start);
    el.stopButton.addEventListener('click', () => {
      state.cancelQueued = true;
      el.stopButton.disabled = true;
    });
    el.resultBody.addEventListener('click', (event) => {
      const cell = event.target.closest('.proxy-cell');
      if (cell) copyProxyCell(cell);
    });
    el.resultBody.addEventListener('keydown', (event) => {
      const cell = event.target.closest('.proxy-cell');
      if (!cell || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      copyProxyCell(cell);
    });

    function start() {
      const proxies = uniqueLines(el.proxyInput.value);
      state.rows = proxies.map((proxy, index) => ({
        index,
        proxy,
        status: 'pending',
      }));
      state.active = 0;
      state.cursor = 0;
      state.cancelQueued = false;
      el.startButton.disabled = true;
      el.stopButton.disabled = proxies.length === 0;
      render();
      pump();
    }

    function uniqueLines(text) {
      const seen = new Set();
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .filter((line) => {
          if (seen.has(line)) return false;
          seen.add(line);
          return true;
        });
    }

    function pump() {
      const limit = clamp(Number(el.concurrencyInput.value || 1), 1, 5);
      while (!state.cancelQueued && state.active < limit && state.cursor < state.rows.length) {
        const row = state.rows[state.cursor++];
        state.active += 1;
        row.status = 'running';
        row.startedAt = Date.now();
        render();
        checkProxy(row).finally(() => {
          state.active -= 1;
          if (state.cursor >= state.rows.length && state.active === 0) {
            el.startButton.disabled = false;
            el.stopButton.disabled = true;
          }
          pump();
          render();
        });
      }

      if ((state.cancelQueued || state.cursor >= state.rows.length) && state.active === 0) {
        el.startButton.disabled = false;
        el.stopButton.disabled = true;
      }
    }

    async function checkProxy(row) {
      try {
        const response = await fetch('/api/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proxy: row.proxy,
            scheme: el.schemeInput.value,
            timeout: Number(el.timeoutInput.value || 30000),
          }),
        });
        const payload = await response.json();
        row.elapsedMs = payload.elapsedMs;
        if (!payload.ok) {
          row.status = 'failed';
          row.error = payload.error || '检测失败';
          return;
        }
        row.status = 'ok';
        row.data = payload.data;
      } catch (error) {
        row.status = 'failed';
        row.error = error.message;
      }
    }

    function render() {
      const sorted = [...state.rows].sort(compareRows);
      el.resultBody.innerHTML = sorted.map((row, rankIndex) => rowHtml(row, rankIndex)).join('');
      const ok = state.rows.filter((row) => row.status === 'ok').length;
      const failed = state.rows.filter((row) => row.status === 'failed').length;
      const done = ok + failed;
      const best = Math.max(...state.rows.filter((row) => row.status === 'ok').map((row) => Number(row.data.score ?? -1)));
      el.totalStat.textContent = String(state.rows.length);
      el.doneStat.textContent = String(done);
      el.okStat.textContent = String(ok);
      el.failStat.textContent = String(failed);
      el.bestStat.textContent = best >= 0 ? String(best) : '-';
    }

    function compareRows(a, b) {
      const scoreA = a.status === 'ok' ? Number(a.data.score ?? -1) : -1;
      const scoreB = b.status === 'ok' ? Number(b.data.score ?? -1) : -1;
      if (scoreA !== scoreB) return scoreB - scoreA;
      const statusOrder = { ok: 0, running: 1, pending: 2, failed: 3 };
      if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
      return a.index - b.index;
    }

    function rowHtml(row, rankIndex) {
      const data = row.data || {};
      const intelligence = data.intelligence || {};
      const status = statusCell(row);
      const rank = row.status === 'ok' ? String(rankIndex + 1) : '-';
      const purity = [data.category, data.purity].filter(Boolean).join(' / ') || '-';
      const proxyDetected = [intelligence.proxy, intelligence.proxyType].filter(Boolean).join(' / ') || '-';
      const asn = [data.asn, data.organization].filter(Boolean).join('<br>') || '-';
      const score = row.status === 'ok' && data.score !== null && data.score !== undefined ? data.score : '-';
      const elapsed = row.elapsedMs ? (row.elapsedMs / 1000).toFixed(1) + 's' : row.status === 'running' ? liveElapsed(row) : '-';
      return '<tr>' +
        '<td>' + escapeHtml(rank) + '</td>' +
        '<td class="mono proxy-cell" data-row-index="' + escapeHtml(row.index) + '" role="button" tabindex="0" aria-label="复制完整代理" title="点击复制完整代理">' + escapeHtml(maskProxy(row.proxy)) + '</td>' +
        '<td class="mono">' + escapeHtml(data.ip || '-') + '</td>' +
        '<td class="score">' + escapeHtml(String(score)) + '</td>' +
        '<td>' + escapeHtml(purity) + '</td>' +
        '<td>' + escapeHtml(proxyDetected) + '</td>' +
        '<td>' + asn + '</td>' +
        '<td>' + escapeHtml(elapsed) + '</td>' +
        '<td>' + status + '</td>' +
      '</tr>';
    }

    function statusCell(row) {
      if (row.status === 'ok') return '<span class="badge ok">成功</span>';
      if (row.status === 'failed') return '<div><span class="badge fail">失败</span><div class="error">' + escapeHtml(row.error || '') + '</div></div>';
      if (row.status === 'running') return '<span class="badge wait">检测中</span>';
      return '<span class="badge">排队</span>';
    }

    function liveElapsed(row) {
      if (!row.startedAt) return '-';
      return ((Date.now() - row.startedAt) / 1000).toFixed(1) + 's';
    }

    function clamp(value, min, max) {
      if (!Number.isFinite(value)) return min;
      return Math.max(min, Math.min(max, value));
    }

    async function copyProxyCell(cell) {
      const row = state.rows.find((item) => String(item.index) === String(cell.dataset.rowIndex));
      if (!row) return;

      try {
        await copyText(row.proxy);
        flashCell(cell, 'copied');
      } catch {
        flashCell(cell, 'copy-failed');
      }
    }

    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) {
        throw new Error('copy failed');
      }
    }

    function flashCell(cell, className) {
      cell.classList.remove('copied', 'copy-failed');
      cell.classList.add(className);
      clearTimeout(cell.copyTimer);
      cell.copyTimer = setTimeout(() => {
        cell.classList.remove(className);
      }, 1200);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function maskProxy(value) {
      return String(value)
        .replace(/\/\/([^:/@\s]+):([^/@\s]+)@/g, '//$1:***@')
        .replace(/^([^:/@\s]+):([^/@\s]+)@/g, '$1:***@');
    }

    setInterval(() => {
      if (state.rows.some((row) => row.status === 'running')) render();
    }, 1000);
  </script>
</body>
</html>`;
