# 纯 Deno 聚合服务器设计（Claude Code ↔ 纯提示词 OpenAI 上游）

目标：用一个 Deno 服务完成 Claude → 纯提示词上游 → Claude 的双向转换——直接把带工具的 Claude 消息转换成**不含 OpenAI tool 字段**的“纯提示词驱动” OpenAI `chat/completions` 请求，上游只产出文本，再解析文本中的工具调用语段为 OpenAI `tool_calls`，最终还原为 Claude 工具消息。

## 核心流程
1. **入口（Anthropic/Claude 兼容）**：HTTP `POST /v1/messages`，接受 Claude Code 请求（`messages`、`tools`、`tool_choice` 等）。
2. **直接生成提示词**：将 Claude 对话与工具 schema 编织进系统提示/示例中，明确要求按约定的 XML/JSON 触发输出工具调用；请求体中**不包含** OpenAI `tools` 或 `tool_choice` 字段，只保留 `messages`（含注入的系统提示）。
3. **上游调用（纯提示词）**：对接只接受普通 `chat/completions` 的上游。Deno `fetch` 透传流式响应。
4. **解析上游文本 → OpenAI tool_calls**：扫描触发标记，解析函数名/参数为 `tool_calls`（流式逐块累计，遇到完整调用片段立即输出相应 delta）。
5. **OpenAI → Claude 响应**：将解析得到的 `tool_calls` 与模型文本内容转换为 Claude Code `type: "tool_use"` 与 `tool_result` 消息格式，返回给客户端。

## 模块划分
- `server.ts`：基于 `std/http` `serve`；路由 `/v1/messages`；统一错误处理、CORS、健康检查。
- `anthropic_to_openai.ts`：Claude → OpenAI 请求结构映射（roles、content、max_tokens、stream 等；**不输出 tools/tool_choice**）。
- `prompt_inject.ts`：构造系统提示并将工具 schema 嵌入提示词；提供 `buildPrompt(messages, tools, opts)`，返回仅含提示的 OpenAI `messages`。
- `upstream.ts`：封装 `fetch`；支持流式，处理超时/重试；注入上游 `base_url` 与 `api_key`。
- `parser.ts`：从上游纯文本解析工具调用；提供流式解析器（如基于触发 token + JSON/XML 片段状态机），输出 OpenAI `tool_calls` 片段或完成块。解析前先将上游 chunk 拆成单字符事件，保证稳定性。
- `openai_to_claude.ts`：OpenAI 响应 → Claude 消息（含工具调用转换为 `tool_use`，工具结果转换为 `tool_result`）。
- `config.ts`：从环境变量或 `config.json` 读取 `UPSTREAM_BASE_URL`、`UPSTREAM_API_KEY`、`CLIENT_API_KEY`、`TIMEOUT_MS` 等。
- `logging.ts`：结构化日志；记录请求 ID、阶段、耗时、上游状态码；可选文件输出。
- `test/`：Deno 内置测试，针对转换与解析模块做单测；提供集成假上游的 e2e 测试。

## 关键实现要点
- **角色/内容映射**：Claude `user/assistant/tool` → OpenAI `user/assistant`（工具消息在提示中表达）；Claude 的 `tool_use` 需要在回程映射为 OpenAI `tool_calls`；支持富文本（plain/array）统一扁平化。
- **工具定义保真**：将 `name`、`description`、`input_schema` 写入系统提示/示例，不再放入请求体的 `tools` 字段。
- **提示协议**：系统提示包含：如何输出 `<tool_call name=\"...\">{json}</tool_call>` 或自定义触发符号、支持多调用、禁止随意文本；示例输入输出；在流式下要求先输出触发，再输出参数。
- **流式解析**：使用 `TextDecoderStream` + 自定义状态机，先把上游 chunk 拆分为单字符逐个处理，再累积触发到闭合标签之间的内容，解析 JSON/XML 后立即生成 `tool_calls` delta；其余文本作为 `content` delta。对下游的 SSE 则在短时间窗口内聚合多字符，减少事件数量。
- **错误与超时**：上游非 2xx 返回标准错误；解析失败返回 502 并记录原始片段；请求超时中断上游流并返回 504。
- **认证**：可选 `x-api-key` 校验客户端；上游 `Authorization: Bearer ...` 由配置提供或透传。
- **可观察性**：请求 ID（UUID），日志分阶段：入站、转换、上游请求、解析、出站；暴露 `/healthz`。

## 伪代码骨架（简化）
```ts
// server.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { mapAnthropicToOpenAI } from "./anthropic_to_openai.ts";
import { injectPrompt } from "./prompt_inject.ts";
import { callUpstream } from "./upstream.ts";
import { parseUpstreamStream } from "./parser.ts";
import { mapOpenAIToClaude } from "./openai_to_claude.ts";

serve(async (req) => {
  if (req.method !== "POST" || !req.url.endsWith("/v1/messages")) return new Response("Not Found", { status: 404 });
  const body = await req.json();
  // 1) 验证 & 映射
  const openaiReq = mapAnthropicToOpenAI(body);
  // 2) 提示注入
  const promptReq = injectPrompt(openaiReq);
  // 3) 调上游（流式）
  const upstreamRes = await callUpstream(promptReq);
  // 4) 解析上游文本 → OpenAI tool_calls
  const parsedStream = parseUpstreamStream(upstreamRes.body);
  // 5) OpenAI → Claude 流式封装
  const claudeStream = mapOpenAIToClaude(parsedStream);
  return new Response(claudeStream, { headers: { "content-type": "text/event-stream" } });
});
```

## 配置示例
- 环境变量：
  - `UPSTREAM_BASE_URL=https://api.example.com/v1/chat/completions`
  - `UPSTREAM_API_KEY=sk-...`
  - `CLIENT_API_KEY=...`（可选）
  - `TIMEOUT_MS=60000`
- 启动：
  - `deno run --allow-net --allow-env server.ts`

## 测试思路
- 单元：角色映射、工具 schema 映射、提示构造、解析器（覆盖多函数、流式碎片、错误片段）。
- 集成：假上游返回预制触发文本，验证最终 Claude 响应包含 `tool_use`；流式模式下比对增量序列。
- 负面：上游 500、超时、触发缺失、JSON 解析失败，确认错误码与日志。

## 实施计划（当前 Sprint）
1. **代码骨架落地**  
   - 初始化 `main.ts`，引入 `serve`，实现 `/v1/messages`、`/healthz`。  
   - 加载配置（环境变量 + 可选 `config.json`），准备日志器与请求 ID。
2. **请求转换链路**  
   - `anthropic_to_openai.ts`：解析 Claude Body（含 `system`、`messages`、`tools`、`tool_choice` 等），输出标准结构。  
   - `prompt_inject.ts`：拼接 Toolify 模板、动态触发信号、历史 `<tool_result>`、`<function_list>`。
3. **上游调用与流式解析**  
   - `upstream.ts`：基于 `fetch`（`AbortController` 控制超时），支持 `stream:true`，透传 headers。  
   - `parser.ts`：按 Toolify 规则检测触发信号，解析 `<invoke>` 为结构化 `tool_calls`，并产出文本增量；实现“单字符处理 + 下游定时聚合”的策略。
4. **Claude SSE 输出**  
   - `openai_to_claude.ts`：根据解析产物生成 `message_start` → `content_block` → `message_delta/stop` 序列，`input_json_delta` 用于工具输入分块。  
   - 确保 stop_reason / usage 计算与错误分支覆盖（上游 4xx/5xx、解析失败）。
5. **验证与文档化**  
   - 使用 `deno test` 为 mapping/解析模块添加用例。  
   - 在 `docs/deno-server-examples.md` 基础上补充运行说明 & curl 示例；更新 README 或新增 `docs/deno-server-runbook.md` 记录部署步骤。
