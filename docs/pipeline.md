# Claude Code Router + Toolify 工作流程详解

本文串联两个项目的原理，说明标准 Claude Code 客户端请求如何经由 Claude Code Router（CCR）转换为带工具调用的 OpenAI Chat 兼容格式，再通过 Toolify 注入提示词以适配不原生支持 function calling 的上游模型，最后将响应逐步转换回 Claude 工具响应。

## 组件角色
- **Claude Code 客户端**：遵循 Anthropic/Claude Code 协议发出请求与工具列表。
- **Claude Code Router**：在本地监听 Anthropic 兼容接口（默认 `http://127.0.0.1:3456`），根据路由配置挑选提供方与模型，并用内置/自定义 transformer 对请求与响应做格式转换（见 `claude-code-router/README.md`）。
- **Toolify**：一个 OpenAI 兼容中间件（`Toolify/README.md`），将 OpenAI 工具调用请求转写为“提示词驱动”的调用协议，并把上游文本响应解析回标准 `tool_calls`。
- **上游 LLM 服务**：可以是不支持原生 function calling 的 OpenAI 接口或其他兼容 `chat/completions` 的推理端点。

## 端到端时序（请求方向）
1) **Claude Code → CCR（Anthropic 入口）**  
   客户端按 Anthropic 规格提交 `messages`、工具定义与 `tool_choice`。CCR 接受后读取路由配置（`Router.default/think/longContext/...`），选择目标提供方与模型。
2) **CCR → Toolify（OpenAI Chat + tool_calls）**  
   CCR 使用相应 transformer（如 `openrouter`、`deepseek` 等）将 Anthropic 风格请求改写为 OpenAI `chat/completions` 结构，包含 `messages`、`tools`、`tool_choice`，并按配置设置 base_url/api_key。此处将提供方指向 Toolify，使 CCR 输出的就是标准 OpenAI 工具调用请求。
3) **Toolify → 上游（纯提示词的 OpenAI Chat）**  
   Toolify 拦截到含 `tools` 的请求后，生成一段系统提示词，说明如何用特定 XML/触发符号描述函数调用（见 “How It Works” 第 2 步）。随后移除原生工具调用字段，只携带提示词与原始对话内容，将修改后的 `chat/completions` 请求转发到配置好的上游服务（`config.yaml` 的 `upstream_services`）。

## 端到端时序（响应方向）
4) **上游 → Toolify（提示词输出）**  
   上游模型按照注入提示词返回纯文本，其中包含 Toolify 约定的触发信号与 XML 结构来表达函数名与参数。
5) **Toolify → CCR（OpenAI tool_calls 响应）**  
   Toolify 解析上游文本，提取出函数名、参数并封装为标准 OpenAI `tool_calls` 响应（流式时逐 token 解析）。这样 CCR 收到的就是原生 function calling 结果，无需了解提示词细节。
6) **CCR → Claude Code（Claude 工具响应）**  
   CCR 的响应 transformer 将 OpenAI `tool_calls` 转回 Claude Code 需要的工具消息格式（如 `type: "tool_use"` 的 message 及 `tool_result`），同时保留模型输出内容，最终返回给 Claude Code 客户端。

## 关键转换点拆解
- **路由与 provider 选择（CCR）**：`config.json` 的 `Providers`/`Router` 字段决定把 Anthropic 请求送往何处，并可叠加 transformer 做字段映射、max_tokens 调整、工具兼容性增强等（参考 `claude-code-router/README.md` 的 Transformer 列表）。
- **工具调用保持（CCR → Toolify）**：CCR 将 Claude 的工具定义映射到 OpenAI `tools`，确保 `tool_choice` 等策略在传入 Toolify 时仍然生效。
- **提示词注入（Toolify）**：依据 `Toolify/README.md`，“Inject Prompt” 阶段会写入结构化指令，允许模型在不支持原生 function calling 的情况下产生可解析的工具调用描述。
- **多函数与流式支持（Toolify）**：Toolify 支持一次多函数调用与流式解析，逐块将触发信号转换成 OpenAI `tool_calls` 结构，避免等待完整文本再解析。
- **回传格式化（CCR）**：CCR 的 transformer 负责把 OpenAI 响应重塑成 Claude Code 所需的工具消息，并在必要时做字段裁剪（如清理不支持的参数），保证客户端无需关心中间转换细节。

## 示例链路（概念性）
1. 开发者在终端运行 `ccr code`，Claude Code CLI 把用户消息与工具 schema 发到本地 CCR。  
2. CCR 依据路由把请求送往 `base_url = http://localhost:8000/v1`（假设 Toolify 部署在此），并转换为 OpenAI `chat/completions` + `tools`。  
3. Toolify 把工具 schema 变成系统提示，转发给上游（如某个只接受纯对话的模型）。  
4. 上游返回带触发标记的文本；Toolify 解析为 `tool_calls`。  
5. CCR 将 `tool_calls` 回复翻译回 Claude Code 工具响应，客户端即可按常规工具流继续执行。

## 落地配置提示
- **CCR 指向 Toolify**：在 CCR `Providers` 中配置一个 provider，`api_base_url` 为 Toolify 地址，`models` 包含要暴露给 Claude Code 的模型别名；`Router.default` 指向该 provider/model，必要时启用与目标上游对应的 transformer 以做字段兼容。
- **Toolify 指向上游**：在 `config.yaml` 的 `upstream_services` 中设置真实上游的 `base_url`、`api_key` 与 `models`，并在 `client_authentication.allowed_keys` 列表加入给 CCR 使用的密钥。
- **校验链路**：先用 OpenAI SDK/`curl` 命中 Toolify 确认能得到 `tool_calls`，再用 `ccr activate` 让 Claude Code 走 CCR，观察日志或流式输出确保工具调用与结果均被正确转译。
