import { serve } from "https://deno.land/std/http/server.ts";
import { loadConfig, ProxyConfig } from "./config.ts";
import { log } from "./logging.ts";
import { mapClaudeToOpenAI } from "./anthropic_to_openai.ts";
import { injectPrompt } from "./prompt_inject.ts";
import { callUpstream } from "./upstream.ts";
import { ToolifyParser } from "./parser.ts";
import { ClaudeStream } from "./openai_to_claude.ts";
import { SSEWriter } from "./sse.ts";
import { ClaudeRequest } from "./types.ts";

const config = loadConfig();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized() {
  return jsonResponse({ error: "unauthorized" }, 401);
}

function validateClientKey(req: Request, config: ProxyConfig): boolean {
  if (!config.clientApiKey) return true;
  const header = req.headers.get("x-api-key") || req.headers.get("authorization");
  if (!header) return false;
  if (header.startsWith("Bearer ")) {
    return header.slice(7) === config.clientApiKey;
  }
  return header === config.clientApiKey;
}

async function handleMessages(req: Request, requestId: string) {
  if (!validateClientKey(req, config)) {
    return unauthorized();
  }

  let body: ClaudeRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  try {
    const openaiBase = mapClaudeToOpenAI(body, config);
    const injected = injectPrompt(openaiBase, body.tools ?? []);
    const upstreamReq = { ...openaiBase, messages: injected.messages };
    const upstreamRes = await callUpstream(upstreamReq, config, requestId);

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text();
      return jsonResponse(
        { error: "upstream_error", status: upstreamRes.status, body: errorText },
        502,
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer = new SSEWriter(controller);
        const claudeStream = new ClaudeStream(writer, config, requestId);
        const parser = new ToolifyParser(injected.triggerSignal);
        const decoder = new TextDecoder();
        const reader = upstreamRes.body!.getReader();

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const char of text) {
              parser.feedChar(char);
              claudeStream.handleEvents(parser.consumeEvents());
            }
          }
          parser.finish();
          claudeStream.handleEvents(parser.consumeEvents());
        } catch (error) {
          log("error", "Streaming failure", { requestId, error: String(error) });
          controller.error(error);
          return;
        } finally {
          writer.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  } catch (error) {
    log("error", "Failed to process request", { requestId, error: String(error) });
    return jsonResponse({ error: "internal_error", details: String(error) }, 500);
  }
}

serve((req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({ status: "ok" });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-api-key",
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const requestId = crypto.randomUUID();
    log("info", "Handling Claude message", { requestId });
    return handleMessages(req, requestId);
  }

  return new Response("Not Found", { status: 404 });
}, { hostname: config.host, port: config.port });
