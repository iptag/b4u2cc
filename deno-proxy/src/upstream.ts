import { ProxyConfig } from "./config.ts";
import { OpenAIChatRequest } from "./types.ts";
import { log } from "./logging.ts";

export async function callUpstream(
  body: OpenAIChatRequest,
  config: ProxyConfig,
  requestId: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  const headers = new Headers({
    "content-type": "application/json",
  });
  if (config.upstreamApiKey) {
    headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  }

  let response: Response;
  try {
    response = await fetch(config.upstreamBaseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  log("debug", "Upstream response received", { requestId, status: response.status });
  if (!response.body) {
    throw new Error("Upstream response has no body");
  }

  return response;
}
