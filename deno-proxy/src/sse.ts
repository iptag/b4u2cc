import { logRequest } from "./logging.ts";

const encoder = new TextEncoder();

export interface SSEEvent<T = unknown> {
  event: string;
  data: T;
}

export class SSEWriter {
  constructor(
    private controller: ReadableStreamDefaultController<Uint8Array>,
    private requestId: string,
  ) {}
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  async send(event: SSEEvent, critical = false): Promise<boolean> {
    if (this.closed) {
      await logRequest(this.requestId, "warn", "Attempted to send on closed SSE stream", {
        event: event.event,
      });
      return false;
    }
    // 不要阻塞在日志写入上，否则会拖慢流式下发；日志异步写入即可
    logRequest(this.requestId, "debug", "Sending downstream SSE event", {
      event: event.event,
      dataPreview: JSON.stringify(event.data).slice(0, 20480),
    });
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

    // 关键事件（如 message_start, content_block_start/stop, message_delta, message_stop）有更多重试
    // 非关键事件（如 content_block_delta 文本增量）重试次数较少但也不能为 0
    const maxRetries = critical ? 5 : 3;
    const maxBackpressureWaits = 10;  // 背压等待上限，避免无限等待
    let backpressureWaits = 0;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // 检查背压：如果队列满，等待后重试（不消耗 retry 计数）
        while (this.controller.desiredSize !== null && this.controller.desiredSize <= 0) {
          if (backpressureWaits >= maxBackpressureWaits) {
            await logRequest(this.requestId, "warn", "Max backpressure waits exceeded", {
              event: event.event,
              waits: backpressureWaits,
            });
            break;  // 超出背压等待上限，尝试强制 enqueue
          }
          backpressureWaits++;
          await new Promise(resolve => setTimeout(resolve, 10));
        }

        this.controller.enqueue(encoder.encode(payload));
        return true;
      } catch (error) {
        const isLastRetry = retry === maxRetries - 1;
        if (isLastRetry) {
          this.closed = true;
          await logRequest(
            this.requestId,
            "error",
            "Failed to enqueue SSE payload after retries",
            {
              error: error instanceof Error ? error.message : String(error),
              event: event.event,
              retries: retry + 1,
              critical,
            },
          );
          return false;
        }
        await logRequest(this.requestId, "warn", "SSE enqueue failed, retrying", {
          error: error instanceof Error ? error.message : String(error),
          retry: retry + 1,
          maxRetries,
        });
        await new Promise(resolve => setTimeout(resolve, 5 * (retry + 1)));  // 递增退避
      }
    }
    return false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}
