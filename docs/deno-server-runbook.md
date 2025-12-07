# Deno 代理运行指南

## 环境变量

在启动前配置以下变量（可写入 `.env` 或直接导出）：

| 变量 | 说明 |
| --- | --- |
| `UPSTREAM_BASE_URL` | 纯提示词上游 `chat/completions` 地址（例如 `http://localhost:8000/v1/chat/completions`） |
| `UPSTREAM_API_KEY` | 可选，上游 API Key。若为空则不发送 `Authorization`。 |
| `UPSTREAM_MODEL` | 可选，强制覆盖 Claude 请求中的 `model` 字段。 |
| `CLIENT_API_KEY` | 可选，若设置，则代理要求客户端在 `x-api-key` 或 `Authorization: Bearer` 中提供相同值。 |
| `TIMEOUT_MS` | 可选，默认 `120000`。超时后自动 `abort` 上游请求。 |
| `AGGREGATION_INTERVAL_MS` | 可选，默认 `35`。下游 SSE 聚合间隔，避免产生过多事件。 |
| `PORT` / `HOST` | 监听地址，默认 `0.0.0.0:3456`。 |

## 启动

```bash
cd deno-proxy
deno run --allow-net --allow-env src/main.ts
```

> CI 环境若未预装 Deno，请先安装（例如 `curl -fsSL https://deno.land/install.sh | sh`）。

## 健康检查

```bash
curl http://localhost:3456/healthz
```

## 发送示例请求

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H 'content-type: application/json' \
  -d @sample_claude_request.json
```

如需流式查看 SSE，可用 `curl -N`。

## 测试

```bash
cd deno-proxy
deno test --allow-env src
```

`parser_test.ts` 验证了 Toolify 解析器在“单字符输入”策略下能解析 `<invoke>` 结构；后续可继续补充其它模块的单元测试。
