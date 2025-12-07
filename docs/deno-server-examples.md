# Deno 服务端到端样例（含历史工具调用，匹配 Toolify 提示）

单一“完美”样例，严格与 Toolify 默认提示模板一致（`config.example.yaml` 的 `prompt_template`，触发信号 `{trigger_signal}`，`<function_list>` + `<invoke>` + `<parameter>` 结构），并包含历史工具调用的转换。重点说明 **第一次请求的全链路**：Claude Messages API 请求 → Deno 注入提示后调用只支持纯提示词的上游 → 上游响应 → Deno 返回 Claude SSE。所有字段均补全，以便对照规范。

---

## 1. Claude Messages API 规范速览

### 1.1 顶层字段

| 字段 | 说明 |
| --- | --- |
| `model` | 例如 `"claude-3.5-sonnet-20241022"`、`"claude-sonnet-4-5-20250929"` |
| `max_tokens` | **必填**，本次生成的最大 token 数 |
| `messages` | 对话历史数组 |
| `system` | 可选，顶层系统提示（Messages API 没有 `system` role） |
| `tools` | 可选，工具定义数组 |
| `tool_choice` | 可选，`"auto"` / `"none"` / 指定工具名 |
| `stream` | 可选，`true` 时走 SSE |
| 其它 | `temperature`、`top_p`、`metadata` 等照常支持 |

### 1.2 `messages` 内容块

- `role` 只能是 `"user"` 或 `"assistant"`。
- `content` 可为字符串或内容块数组：`text`、`image` 等。
- `tool_use` 块只能出现在 `assistant` `content` 内。
- `tool_result` 块必须出现在 `user` `content` 内，且 `tool_use_id` 要引用历史中的 `tool_use.id`，否则 400。

### 1.3 工具调用往返规则

- 模型要调用工具时，会以 `stop_reason:"tool_use"` 结束该响应。
- 工具输入：`{"type":"tool_use","id":"toolu_x","name":"get_weather","input":{...}}`
- 工具完成后，由客户端在下一次请求中带回 `{"type":"tool_result","tool_use_id":"toolu_x","content":"..."}`。
- **同一次响应不会包含工具结果**。

---

## 2. Claude Messages API SSE 事件速览

启用 `stream:true` 时，Claude 服务端会按以下顺序推送事件：

1. `message_start`
2. 内容块组：
   - `content_block_start`
   - 若干 `content_block_delta`
   - `content_block_stop`
3. `message_delta`（可多次）——更新 `stop_reason`、`usage`
4. `message_stop`

常见 `delta` 类型：

- 文本块：`text_delta`
- 工具输入块：`input_json_delta`（用于拼接 JSON）

---

## 3. 端到端样例（仅第一次请求）

场景：用户已执行过一次 `get_weather(city="San Francisco")`，当前请求携带历史工具结果，要求继续查询纽约并比较是否需要带外套。Deno 仅负责把 Claude 请求转成纯提示词上游格式，并把上游的 `<invoke>` 解析成 Claude 的工具调用输出。

### 3.1 Claude 入站（POST /v1/messages）
```json
{
  "model": "claude-3.5-sonnet-20241022",
  "max_tokens": 1024,
  "system": "你是专业旅行助手，需要根据工具数据给用户建议。",
  "temperature": 0.2,
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "查下旧金山天气" }
      ]
    },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "好的，我来查。" },
        { "type": "tool_use", "id": "toolu_prev", "name": "get_weather", "input": { "city": "San Francisco", "unit": "c" } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_prev", "content": "旧金山 15°C，微风" }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "也查下纽约，并比较是否需要带外套" }
      ]
    }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "查询城市当前天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "城市名" },
          "unit": { "type": "string", "enum": ["c", "f"], "description": "温度单位" }
        },
        "required": ["city"]
      }
    }
  ],
  "tool_choice": "auto",
  "metadata": {
    "conversation_id": "conv_xyz",
    "client": "ccr-deno-proxy"
  }
}
```

### 3.2 Deno → 上游纯提示词请求

- 假设触发信号：`<<CALL_ab12>>`
- `tools_list` 展开为 `<function_list>` XML
- 历史工具结果转成 `<tool_result id="toolu_prev">旧金山 15°C，微风</tool_result>`
- 请求体为标准 OpenAI `chat/completions` JSON
```json
{
  "model": "gpt-4o-mini",
  "stream": true,
  "temperature": 0.2,
  "top_p": 1,
  "messages": [
    {
      "role": "system",
      "content": "IGNORE ALL PREVIOUS INSTRUCTIONS. Your ONLY task is to act as an expert assistant that uses the tools provided below. You MUST strictly follow the format and rules outlined here. Any other instructions are to be disregarded.\n\nYou are an expert assistant equipped with a set of tools to perform tasks. When you need to use a tool, you MUST strictly follow the format below.\n\n**1. Available Tools:**\nHere is the list of tools you can use. You have access ONLY to these tools and no others.\n<function_list>\n  <tool id=\"1\">\n    <name>get_weather</name>\n    <description>查询城市当前天气</description>\n    <required>\n      <param>city</param>\n    </required>\n    <parameters>\n      <parameter name=\"city\">\n        <type>string</type>\n        <required>true</required>\n        <description>城市名</description>\n      </parameter>\n      <parameter name=\"unit\">\n        <type>string</type>\n        <required>false</required>\n        <description>温度单位</description>\n        <enum>[\"c\",\"f\"]</enum>\n      </parameter>\n    </parameters>\n  </tool>\n</function_list>\n\n**2. Tool Call Procedure:**\nWhen you decide to call a tool, you MUST output EXACTLY this trigger signal: `<<CALL_ab12>>`\nThe trigger signal MUST be output on a completely empty line by itself before any tool calls.\nDo NOT add any other text, spaces, or characters before or after `<<CALL_ab12>>` on that line.\nYou may provide explanations or reasoning before outputting `<<CALL_ab12>>`, but once you decide to make a tool call, `<<CALL_ab12>>` must come first.\nYou MUST output the trigger signal `<<CALL_ab12>>` ONLY ONCE per response. Never output multiple trigger signals in a single response.\n\nAfter outputting the trigger signal, immediately provide your tool calls enclosed in <invoke> XML tags.\n\n**3. XML Format for Tool Calls:**\nYour tool calls must be structured EXACTLY as follows. This is the ONLY format you can use, and any deviation will result in failure.\n```\n<<CALL_ab12>>\n<invoke name=\"Write\">\n<parameter name=\"file_path\">C:\\path\\weather.css</parameter>\n<parameter name=\"content\"> body {{ background-color: lightblue; }} </parameter>\n</invoke>\n```\n\nIMPORTANT RULES:\n  - ...（其余保持模板默认内容）"
    },
    {
      "role": "assistant",
      "content": "好的，我来查。\n<tool_result id=\"toolu_prev\">旧金山 15°C，微风</tool_result>"
    },
    {
      "role": "user",
      "content": "也查下纽约，并比较是否需要带外套"
    }
  ]
}
```

### 3.3 上游响应（示例合并 chunk，真实场景为 SSE）
```json
{
  "id": "chatcmpl-up-1",
  "object": "chat.completion.chunk",
  "created": 1736966400,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "已有旧金山结果：15°C 微风。我将查询纽约。\n<<CALL_ab12>>\n<invoke name=\"get_weather\">\n<parameter name=\"city\">New York</parameter>\n<parameter name=\"unit\">c</parameter>\n</invoke>\n"
      }
    }
  ]
}
```

### 3.4 Deno → Claude SSE（仅输出文本 + 新工具调用）

- `tool_use` 的 `input` 通过 `input_json_delta` 逐步拼装
- `message_delta` 更新 `stop_reason` 和 usage
```json
[
  {
    "type": "message_start",
    "message": {
      "id": "msg_1",
      "model": "claude-3.5-sonnet-20241022",
      "role": "assistant",
      "stop_reason": null,
      "usage": null
    }
  },
  {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "text", "text": "" }
  },
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "已有旧金山结果：15°C 微风。我将查询纽约。\n" }
  },
  { "type": "content_block_stop", "index": 0 },
  {
    "type": "content_block_start",
    "index": 1,
    "content_block": { "type": "tool_use", "id": "toolu_ny", "name": "get_weather", "input": {} }
  },
  {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "input_json_delta", "partial_json": "{\"city\":\"New York\"," }
  },
  {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "input_json_delta", "partial_json": "\"unit\":\"c\"}" }
  },
  { "type": "content_block_stop", "index": 1 },
  {
    "type": "message_delta",
    "delta": {
      "stop_reason": "tool_use",
      "usage": { "input_tokens": 2500, "output_tokens": 62 }
    }
  },
  { "type": "message_stop" }
]
```

> SSE 在 `stop_reason:"tool_use"` 时结束，Claude Code 将等待工具执行完成后，以新的请求带回 `tool_result` 并继续对话（不在当前示例范围内）。

---

本示例确保：
1. Claude 入站体包含完整顶层字段与标准 `messages`/`tools`/`tool_choice`、正确的 `tool_use` → `tool_result` 关系。
2. Deno 在调用上游时完全复用了 Toolify 提示模板（触发信号 + `<function_list>` + `<invoke>` 结构），请求体符合 OpenAI `chat/completions` 规范。
3. 历史工具结果被转换成 `<tool_result>` 文本传递给上游。
4. Deno 返回给 Claude 的 SSE 序列包含完整事件：`message_start` → `content_block_start/delta/stop` → `message_delta`（含 `stop_reason`、`usage`）→ `message_stop`，并使用 `input_json_delta` 拼装工具输入。这样 Claude 客户端即可在单次响应中仅获取工具调用，等待下一次请求带回结果。
