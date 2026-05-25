# IPLark Proxy Ranker

本地工具：输入代理，自动解析出口 IP，并用同一条代理访问 IPLark，输出 IPLark 分数、纯净度、代理识别等信息。

## 功能

- 支持 `user:pass@host:port`、`http://user:pass@host:port`、`socks5h://user:pass@host:port`
- Chrome 访问 IPLark 时也走传入代理，避免 IPLark 详情页看到本地出口
- CLI 单条查询
- WebUI 批量查询，按 IPLark 分数从高到低排序
- WebUI 代理列默认打码，点击代理单元格可复制完整代理

## 要求

- Node.js 22+
- 本机 Google Chrome

## WebUI

启动：

```bash
npm start
```

或：

```bash
node iplark-webui.mjs
```

打开：

```text
http://127.0.0.1:8787
```

每行粘贴一条代理，点击开始检测。结果会按 IPLark 分数从高到低排序，并显示每条代理的出口 IP、分数、纯净度、代理识别和 ASN。

## CLI

查询代理：

```bash
node iplark-checker.mjs 'user:pass@host:port'
```

输出 JSON：

```bash
node iplark-checker.mjs 'user:pass@host:port' --json
```

直接查指定 IP：

```bash
node iplark-checker.mjs --ip 8.8.8.8
```

指定协议：

```bash
node iplark-checker.mjs 'user:pass@host:port' --scheme http
node iplark-checker.mjs 'user:pass@host:port' --scheme socks5h
```

如果 IPLark 对无头 Chrome 返回不完整内容，可以用可见窗口模式：

```bash
node iplark-checker.mjs 'user:pass@host:port' --headed
```
