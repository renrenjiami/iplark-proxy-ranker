#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 30000;
const EXIT_IP_ENDPOINTS = [
  { host: 'api.ipify.org', path: '/?format=json', kind: 'json' },
  { host: 'ipv4.icanhazip.com', path: '/', kind: 'text' },
  { host: 'iplark.com', path: '/', kind: 'text' },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = args.timeout || DEFAULT_TIMEOUT_MS;
  const proxyInput = args.proxy || (args.ip ? null : await readProxyFromStdin());
  let targetIp = args.ip;
  let activeProxy = null;

  if (proxyInput) {
    const resolved = await resolveExitIp(proxyInput, { timeoutMs, scheme: args.scheme });
    targetIp ||= resolved.ip;
    activeProxy = resolved.proxy;
  }

  if (!targetIp) {
    throw new Error('请传入代理或 --ip');
  }

  let proxyBridge = null;
  try {
    proxyBridge = activeProxy ? await startProxyBridge(activeProxy, timeoutMs) : null;
    const page = await queryIplark(targetIp, {
      allowPartial: args.raw,
      chromePath: args.chrome,
      headed: args.headed,
      proxyServer: proxyBridge?.url,
      timeoutMs,
    });
    if (args.raw) {
      console.log(page.text);
      return;
    }
    const result = parseIplarkText(page.text, targetIp, page);
    result.iplarkAccess = proxyBridge
      ? `proxied via ${activeProxy.protocol}://${activeProxy.host}:${activeProxy.port}`
      : 'direct';

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result);
    }
  } finally {
    await proxyBridge?.close();
  }
}

function parseArgs(argv) {
  const parsed = {
    chrome: undefined,
    headed: false,
    ip: undefined,
    json: false,
    proxy: undefined,
    raw: false,
    scheme: undefined,
    timeout: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--raw') {
      parsed.raw = true;
    } else if (arg === '--headed') {
      parsed.headed = true;
    } else if (arg === '--ip') {
      parsed.ip = requiredValue(argv, ++index, '--ip');
    } else if (arg === '--proxy') {
      parsed.proxy = requiredValue(argv, ++index, '--proxy');
    } else if (arg === '--scheme') {
      parsed.scheme = requiredValue(argv, ++index, '--scheme');
    } else if (arg === '--chrome') {
      parsed.chrome = requiredValue(argv, ++index, '--chrome');
    } else if (arg === '--timeout') {
      parsed.timeout = Number(requiredValue(argv, ++index, '--timeout'));
      if (!Number.isFinite(parsed.timeout) || parsed.timeout < 1000) {
        throw new Error('--timeout 需要是大于 1000 的毫秒数');
      }
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (!parsed.proxy) {
      parsed.proxy = arg;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
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
  console.log(`IPLark proxy checker

用法:
  node scripts/iplark-checker.mjs 'user:pass@host:port'
  node scripts/iplark-checker.mjs --proxy 'http://user:pass@host:port'
  node scripts/iplark-checker.mjs --ip 8.8.8.8

选项:
  --scheme http|socks5|socks5h  代理没有协议头时强制指定协议
  --json                        输出 JSON
  --raw                         输出 IPLark 页面原始文本，方便排查解析
  --headed                      使用可见 Chrome 窗口，适合排查 headless 被站点拦截
  --chrome /path/to/chrome      指定 Chrome 可执行文件
  --timeout 30000               超时时间，单位毫秒
`);
}

async function readProxyFromStdin() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) {
      return text;
    }
  }

  throw new Error('请传入代理，例如: node scripts/iplark-checker.mjs "user:pass@host:port"');
}

async function resolveExitIp(rawProxy, options) {
  const candidates = proxyCandidates(rawProxy, options.scheme);
  const errors = [];

  for (const proxy of candidates) {
    for (const endpoint of EXIT_IP_ENDPOINTS) {
      try {
        const body = proxy.protocol.startsWith('socks')
          ? await socksHttpGet(proxy, endpoint, options.timeoutMs)
          : await httpProxyGet(proxy, endpoint, options.timeoutMs);
        const ip = extractIp(body);
        if (ip) {
          return { ip, proxy };
        }
        errors.push(`${proxy.protocol}: ${endpoint.host} 没有返回 IP`);
      } catch (error) {
        errors.push(`${proxy.protocol}: ${error.message}`);
      }
    }
  }

  throw new Error(`无法通过代理解析出口 IP（${sanitizeProxy(rawProxy)}）。${errors.slice(0, 4).join('；')}`);
}

function proxyCandidates(rawProxy, forcedScheme) {
  const protocols = forcedScheme ? [forcedScheme] : inferProtocols(rawProxy);
  const candidates = [];

  for (const protocol of protocols) {
    candidates.push(parseProxy(rawProxy, protocol));
  }

  return candidates;
}

function inferProtocols(rawProxy) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawProxy)) {
    return [new URL(rawProxy).protocol.replace(':', '')];
  }
  return ['http', 'socks5h'];
}

function parseProxy(rawProxy, defaultProtocol = 'http') {
  if (!rawProxy || typeof rawProxy !== 'string') {
    throw new Error('代理不能为空');
  }

  let text = rawProxy.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.includes('@')) {
    const legacy = parseHostPortUserPass(text, defaultProtocol);
    if (legacy) {
      return legacy;
    }
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `${defaultProtocol}://${text}`;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    const legacy = parseHostPortUserPass(rawProxy, defaultProtocol);
    if (legacy) {
      return legacy;
    }
    throw new Error('代理格式不正确');
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    throw new Error(`暂不支持代理协议: ${protocol}`);
  }

  if (!url.hostname || !url.port) {
    const legacy = parseHostPortUserPass(rawProxy, protocol);
    if (legacy) {
      return legacy;
    }
    throw new Error('代理格式需要包含 host 和 port');
  }

  return {
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port),
    protocol,
    username: decodeURIComponent(url.username),
  };
}

function parseHostPortUserPass(rawProxy, protocol) {
  const parts = rawProxy.split(':');
  if (parts.length !== 4 || rawProxy.includes('@')) {
    return null;
  }

  const [host, port, username, password] = parts;
  if (!host || !port || !username || !password) {
    return null;
  }

  return {
    host,
    password,
    port: Number(port),
    protocol,
    username,
  };
}

async function httpProxyGet(proxy, endpoint, timeoutMs) {
  if (proxy.protocol === 'https') {
    throw new Error('HTTPS 代理暂未实现，请用 http 或 socks5');
  }

  const socket = await connectSocket(proxy.host, proxy.port, timeoutMs);
  const authorization = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
    : '';
  const request = [
    `GET http://${endpoint.host}${endpoint.path} HTTP/1.1`,
    `Host: ${endpoint.host}`,
    'User-Agent: iplark-checker/1.0',
    'Accept: application/json,text/plain,*/*',
    authorization.trimEnd(),
    'Connection: close',
  ].filter(Boolean).join('\r\n') + '\r\n\r\n';

  socket.write(request);
  const response = await readSocket(socket, timeoutMs);
  const parsed = parseHttpResponse(response);

  if (parsed.statusCode < 200 || parsed.statusCode >= 300) {
    throw new Error(`HTTP 代理返回 ${parsed.statusCode}: ${parsed.body.slice(0, 80).trim()}`);
  }

  return parsed.body;
}

async function socksHttpGet(proxy, endpoint, timeoutMs) {
  const socket = await connectSocket(proxy.host, proxy.port, timeoutMs);
  await socks5Handshake(socket, proxy, endpoint.host, 80, timeoutMs);

  socket.write([
    `GET ${endpoint.path} HTTP/1.1`,
    `Host: ${endpoint.host}`,
    'User-Agent: iplark-checker/1.0',
    'Accept: application/json,text/plain,*/*',
    'Connection: close',
  ].join('\r\n') + '\r\n\r\n');

  const response = await readSocket(socket, timeoutMs);
  const parsed = parseHttpResponse(response);

  if (parsed.statusCode < 200 || parsed.statusCode >= 300) {
    throw new Error(`SOCKS 请求返回 ${parsed.statusCode}: ${parsed.body.slice(0, 80).trim()}`);
  }

  return parsed.body;
}

async function startProxyBridge(upstreamProxy, timeoutMs) {
  const server = net.createServer((clientSocket) => {
    handleBridgeClient(clientSocket, upstreamProxy, timeoutMs).catch((error) => {
      if (!clientSocket.destroyed) {
        clientSocket.write([
          'HTTP/1.1 502 Bad Gateway',
          'Content-Type: text/plain; charset=utf-8',
          'Connection: close',
          '',
          `proxy bridge error: ${error.message}`,
        ].join('\r\n'));
      }
      clientSocket.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function handleBridgeClient(clientSocket, upstreamProxy, timeoutMs) {
  clientSocket.once('error', () => {});
  const { header, rest } = await readHttpHeader(clientSocket, timeoutMs);
  const lines = header.split(/\r?\n/);
  const [method, requestTarget, version] = lines[0].split(/\s+/);

  if (!method || !requestTarget || !version) {
    throw new Error('浏览器代理请求格式不正确');
  }

  if (method.toUpperCase() === 'CONNECT') {
    const target = parseTargetHostPort(requestTarget, 443);
    const upstreamSocket = await connectViaProxy(upstreamProxy, target.host, target.port, timeoutMs);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: iplark-checker\r\n\r\n');
    if (rest.length) {
      upstreamSocket.write(rest);
    }
    pipeSockets(clientSocket, upstreamSocket);
    return;
  }

  const target = parseHttpRequestTarget(requestTarget, lines);
  const upstreamSocket = await connectViaProxy(upstreamProxy, target.host, target.port, timeoutMs);
  lines[0] = `${method} ${target.path} ${version}`;
  const request = `${lines.filter((line) => !/^proxy-connection:/i.test(line)).join('\r\n')}\r\n\r\n`;
  upstreamSocket.write(request);
  if (rest.length) {
    upstreamSocket.write(rest);
  }
  pipeSockets(clientSocket, upstreamSocket);
}

function parseHttpRequestTarget(requestTarget, headerLines) {
  if (/^https?:\/\//i.test(requestTarget)) {
    const url = new URL(requestTarget);
    return {
      host: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    };
  }

  const hostHeader = headerLines.find((line) => /^host:/i.test(line));
  if (!hostHeader) {
    throw new Error('HTTP 请求缺少 Host 头');
  }
  const hostPort = hostHeader.replace(/^host:\s*/i, '').trim();
  return {
    ...parseTargetHostPort(hostPort, 80),
    path: requestTarget,
  };
}

function parseTargetHostPort(value, defaultPort) {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return { host, port: rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort };
    }
  }

  const colon = value.lastIndexOf(':');
  if (colon > -1 && /^\d+$/.test(value.slice(colon + 1))) {
    return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
  }

  return { host: value, port: defaultPort };
}

async function connectViaProxy(proxy, targetHost, targetPort, timeoutMs) {
  if (proxy.protocol.startsWith('socks')) {
    const socket = await connectSocket(proxy.host, proxy.port, timeoutMs);
    await socks5Handshake(socket, proxy, targetHost, targetPort, timeoutMs);
    return socket;
  }

  if (proxy.protocol !== 'http') {
    throw new Error(`Chrome 代理桥暂不支持上游协议: ${proxy.protocol}`);
  }

  const socket = await connectSocket(proxy.host, proxy.port, timeoutMs);
  const authorization = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
    : '';
  socket.write([
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
    'User-Agent: iplark-checker/1.0',
    authorization.trimEnd(),
    'Connection: keep-alive',
  ].filter(Boolean).join('\r\n') + '\r\n\r\n');

  const { header, rest } = await readHttpHeader(socket, timeoutMs);
  const statusCode = Number((header.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1] || 0);
  if (statusCode !== 200) {
    socket.destroy();
    throw new Error(`HTTP 上游代理 CONNECT 返回 ${statusCode || '未知状态'}: ${header.split(/\r?\n/)[0] || ''}`);
  }
  if (rest.length) {
    socket.unshift(rest);
  }
  return socket;
}

function readHttpHeader(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => cleanupReject(new Error('读取 HTTP 头超时')), timeoutMs);

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index !== -1) {
        const header = buffer.subarray(0, index).toString('latin1');
        const rest = buffer.subarray(index + 4);
        cleanup();
        resolve({ header, rest });
      }
    }

    function onError(error) {
      cleanupReject(error);
    }

    function cleanupReject(error) {
      cleanup();
      reject(error);
    }

    function cleanup() {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function pipeSockets(left, right) {
  left.pipe(right);
  right.pipe(left);
  left.once('error', () => right.destroy());
  right.once('error', () => left.destroy());
  left.once('close', () => right.destroy());
  right.once('close', () => left.destroy());
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function socks5Handshake(socket, proxy, targetHost, targetPort, timeoutMs) {
  const hasAuth = Boolean(proxy.username || proxy.password);
  socket.write(Buffer.from([0x05, hasAuth ? 0x02 : 0x01, 0x00, ...(hasAuth ? [0x02] : [])]));
  const greeting = await readExact(socket, 2, timeoutMs);

  if (greeting[0] !== 0x05) {
    throw new Error('SOCKS5 握手失败');
  }
  if (greeting[1] === 0xff) {
    throw new Error('SOCKS5 代理不接受当前认证方式');
  }

  if (greeting[1] === 0x02) {
    const username = Buffer.from(proxy.username || '');
    const password = Buffer.from(proxy.password || '');
    if (username.length > 255 || password.length > 255) {
      throw new Error('SOCKS5 用户名或密码过长');
    }
    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]));
    const auth = await readExact(socket, 2, timeoutMs);
    if (auth[1] !== 0x00) {
      throw new Error('SOCKS5 用户名或密码被拒绝');
    }
  }

  const host = Buffer.from(targetHost);
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
  ]);
  socket.write(request);

  const header = await readExact(socket, 4, timeoutMs);
  if (header[1] !== 0x00) {
    throw new Error(`SOCKS5 连接目标失败，状态码 ${header[1]}`);
  }

  const addressLength = header[3] === 0x01
    ? 4
    : header[3] === 0x04
      ? 16
      : (await readExact(socket, 1, timeoutMs))[0];
  await readExact(socket, addressLength + 2, timeoutMs);
}

function readExact(socket, byteLength, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(cleanupReject, timeoutMs, new Error('读取 SOCKS5 响应超时'));

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= byteLength) {
        const needed = buffer.subarray(0, byteLength);
        const rest = buffer.subarray(byteLength);
        cleanup();
        if (rest.length) {
          socket.unshift(rest);
        }
        resolve(needed);
      }
    }

    function onError(error) {
      cleanupReject(error);
    }

    function cleanupReject(error) {
      cleanup();
      reject(error);
    }

    function cleanup() {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function readSocket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('读取响应超时'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    }

    function onData(chunk) {
      chunks.push(chunk);
    }

    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function parseHttpResponse(response) {
  const [headerText, ...bodyParts] = response.split(/\r?\n\r?\n/);
  const statusLine = headerText.split(/\r?\n/)[0] || '';
  const statusCode = Number(statusLine.match(/\s(\d{3})\s/)?.[1] || 0);
  const body = bodyParts.join('\n\n');

  if (!statusCode) {
    throw new Error(`无法解析 HTTP 响应: ${response.slice(0, 80)}`);
  }

  return { body, statusCode };
}

function extractIp(body) {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text);
    const value = parsed.ip || parsed.query || parsed.origin;
    if (value && isIp(value)) {
      return value;
    }
  } catch {
    // The endpoint may return plain text.
  }

  const match = text.match(/(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9:]{2,}/i);
  return match && isIp(match[0]) ? match[0] : null;
}

function isIp(value) {
  return net.isIP(value) !== 0;
}

async function queryIplark(ip, options) {
  const chrome = await launchChrome(options);
  const port = new URL(chrome.browserWsEndpoint).port;
  let page;
  let client;

  try {
    page = await createChromePage(port);
    client = await CdpClient.connect(page.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setUserAgentOverride', {
      userAgent: chromeLikeUserAgent(),
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: os.platform() === 'darwin' ? 'macOS' : 'Linux',
    });
    await client.send('Page.navigate', { url: `https://iplark.com/${encodeURIComponent(ip)}` });

    const started = Date.now();
    let lastValue = null;
    while (Date.now() - started < options.timeoutMs) {
      await delay(500);
      lastValue = await evaluatePage(client);
      if (lastValue.text.includes('403 Forbidden')) {
        throw new Error('IPLark 返回 403。可以加 --headed 重试，使用可见 Chrome 窗口。');
      }
      if (hasCompleteIplarkText(lastValue.text)) {
        return lastValue;
      }
    }

    if (options.allowPartial && lastValue) {
      return lastValue;
    }

    throw new Error(`等待 IPLark 完整评分/情报超时，最后页面标题: ${lastValue?.title || '未知'}。可加 --headed 重试。`);
  } finally {
    if (client) {
      client.close();
    }
    await closeChrome(chrome);
  }
}

async function launchChrome(options) {
  const chromePath = options.chromePath || findChromeExecutable();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iplark-chrome-'));
  const args = [
    options.headed ? null : '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    options.proxyServer ? `--proxy-server=${options.proxyServer}` : null,
    options.proxyServer ? '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1' : null,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-blink-features=AutomationControlled',
    '--disable-component-update',
    '--disable-features=UseDnsHttpsSvcbAlpn,DnsOverHttps,AsyncDns',
    '--disable-gpu',
    '--disable-quic',
    '--disable-sync',
    '--lang=zh-CN',
    '--window-size=1280,900',
    'about:blank',
  ].filter(Boolean);

  const child = spawn(chromePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const browserWsEndpoint = await waitForDevToolsEndpoint(child, options.timeoutMs);
  return { browserWsEndpoint, child, userDataDir };
}

function findChromeExecutable() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('找不到 Chrome。请安装 Google Chrome，或用 --chrome 指定路径。');
}

function waitForDevToolsEndpoint(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGTERM');
      reject(new Error('启动 Chrome 超时'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    function onData(chunk) {
      stderr += chunk.toString('utf8');
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Chrome 已退出，退出码 ${code ?? '未知'}: ${stderr.slice(-500)}`));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function createChromePage(port) {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`;
  let response = await fetch(url, { method: 'PUT' });
  if (!response.ok) {
    response = await fetch(url);
  }
  if (!response.ok) {
    throw new Error(`创建 Chrome 标签页失败: HTTP ${response.status}`);
  }
  return response.json();
}

async function closeChrome(chrome) {
  if (!chrome) {
    return;
  }

  chrome.child.kill('SIGTERM');
  await onceExit(chrome.child).catch(() => {});
  await fs.rm(chrome.userDataDir, { force: true, recursive: true }).catch(() => {});
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

function chromeLikeUserAgent() {
  if (os.platform() === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
}

function hasCompleteIplarkText(text) {
  const hasScore = /IP评分\s*\n?\s*\d{1,3}(?:\s*\/100)?/.test(text);
  const hasIntelligence = /使用类型[:：]\s*\n/.test(text) || /代理[:：]\s*\n/.test(text);
  return hasScore && hasIntelligence;
}

async function evaluatePage(client) {
  const expression = `(() => ({
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText : ''
  }))()`;
  const response = await client.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || '页面执行脚本失败');
  }

  return response.result.value;
}

class CdpClient {
  constructor(socket) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = socket;
    this.socket.addEventListener('message', (event) => this.onMessage(event));
    this.socket.addEventListener('error', (event) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`CDP WebSocket 错误: ${event.message || 'unknown error'}`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 版本没有 WebSocket，请使用 Node 22+');
    }

    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('连接 Chrome 调试端口超时')), 10000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('连接 Chrome 调试端口失败'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (!message.id || !this.pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) {
      reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
    } else {
      resolve(message.result || {});
    }
  }

  close() {
    this.socket.close();
  }
}

function parseIplarkText(text, ip, page) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const top = extractTopSummary(lines, ip);

  const result = {
    ip,
    title: page.title,
    url: page.url,
    host: top.host,
    reddit: top.reddit || lines.find((line) => /^reddit\b/i.test(line)) || null,
    category: top.category,
    purity: top.purity,
    score: extractScore(lines),
    country: afterLine(lines, '国家/地区'),
    asn: afterLine(lines, 'ASN'),
    organization: afterLine(lines, '企业'),
    scene: afterAnyLine(lines, ['使用场景更多数据', '使用场景']),
    note: afterLine(lines, '备注'),
    intelligence: {
      usageType: afterLine(lines, '使用类型:'),
      threat: afterLine(lines, '威胁:'),
      ipType: afterLine(lines, 'IP类型:'),
      provider: afterLine(lines, '提供商:'),
      proxy: afterLine(lines, '代理:'),
      proxyType: afterLine(lines, '代理类型:'),
      tags: afterLine(lines, '标签:'),
    },
  };

  return result;
}

const VALUE_LABELS = new Set([
  '+ 拓展数据',
  '+ 拓展数据 专业版',
  'API & 离线数据库',
  'ASN',
  'BGP路由图',
  'DB-IP',
  'Digital Element',
  'Ease',
  'IDC/SOCKS识别（Gemini模型驱动）',
  'IP2Location',
  'IPinfo',
  'IPLark',
  'IP情报',
  'IP评分',
  'Ipstack',
  'Internet',
  'Maxmind',
  'Moe',
  'Moe+',
  'Telegram群组',
  '企业',
  '位置历史',
  '使用场景',
  '使用场景更多数据',
  '全球延迟测试',
  '备注',
  '国家/地区',
  '地理位置（多源对比）',
  '数字地址',
  '时间轴',
  '更多',
  '标签:',
  '提供商:',
  '威胁:',
  '代理:',
  '代理类型:',
  '使用类型:',
  '端口扫描',
  '专业版',
  'IP类型:',
]);

function extractTopSummary(lines, ip) {
  const index = lines.findIndex((line) => line === ip);
  const summary = {
    category: null,
    host: null,
    purity: null,
    reddit: null,
  };

  if (index === -1) {
    return summary;
  }

  let cursor = index + 1;
  const first = lines[cursor];
  if (first && !isTopCategory(first) && !isPurityLine(first) && !/^reddit\b/i.test(first) && !VALUE_LABELS.has(first)) {
    summary.host = first;
    cursor += 1;
  }

  if (/^reddit\b/i.test(lines[cursor] || '')) {
    summary.reddit = lines[cursor];
    cursor += 1;
  }

  if (isTopCategory(lines[cursor])) {
    summary.category = lines[cursor];
    cursor += 1;
  }

  if (isPurityLine(lines[cursor])) {
    summary.purity = lines[cursor];
  }

  return summary;
}

function isTopCategory(line) {
  return ['ISP', '数据中心', '住宅', '普通宽带', '企业专线', '移动网络'].includes(line);
}

function isPurityLine(line) {
  return typeof line === 'string' && /(原生IP|广播IP|非原生|中转|住宅|数据中心)/.test(line);
}

function afterLine(lines, label) {
  const index = lines.findIndex((line) => line === label);
  if (index === -1 || index + 1 >= lines.length) {
    return null;
  }
  const value = lines[index + 1];
  return VALUE_LABELS.has(value) ? null : value;
}

function afterAnyLine(lines, labels) {
  for (const label of labels) {
    const value = afterLine(lines, label);
    if (value) {
      return value;
    }
  }
  return null;
}

function extractScore(lines) {
  const index = lines.findIndex((line) => line === 'IP评分');
  if (index === -1) {
    return null;
  }

  for (const line of lines.slice(index + 1, index + 5)) {
    const match = line.match(/^(\d{1,3})(?:\/100)?$/);
    if (match) {
      const value = Number(match[1]);
      return Number.isFinite(value) ? value : null;
    }
  }

  return null;
}

function printHuman(result) {
  console.log(`IP: ${result.ip}`);
  if (result.iplarkAccess) console.log(`IPLark访问: ${result.iplarkAccess}`);
  if (result.host) console.log(`主机名: ${result.host}`);
  if (result.category || result.purity) {
    console.log(`纯净度/归类: ${[result.category, result.purity].filter(Boolean).join(' / ')}`);
  }
  if (result.score !== null) console.log(`IP评分: ${result.score}/100`);
  if (result.country) console.log(`国家/地区: ${result.country}`);
  if (result.asn) console.log(`ASN: ${result.asn}`);
  if (result.organization) console.log(`企业: ${result.organization}`);
  if (result.scene) console.log(`使用场景: ${result.scene}`);
  if (result.note) console.log(`备注: ${result.note}`);
  if (result.reddit) console.log(`Reddit: ${result.reddit}`);

  console.log('\nIP情报:');
  printMaybe('  使用类型', result.intelligence.usageType);
  printMaybe('  IP类型', result.intelligence.ipType);
  printMaybe('  代理', result.intelligence.proxy);
  printMaybe('  代理类型', result.intelligence.proxyType);
  printMaybe('  威胁', result.intelligence.threat);
  printMaybe('  提供商', result.intelligence.provider);
  printMaybe('  标签', result.intelligence.tags);
}

function printMaybe(label, value) {
  if (value !== null && value !== undefined) {
    console.log(`${label}: ${value}`);
  }
}

function sanitizeProxy(rawProxy) {
  return rawProxy.replace(/\/\/([^/@]+)@/, '//***:***@').replace(/^([^/@]+)@/, '***:***@');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`查询失败: ${error.message}`);
  process.exitCode = 1;
});
