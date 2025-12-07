import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { SSEWriter } from "./sse.ts";
import { TextAggregator } from "./aggregator.ts";
import { ProxyConfig } from "./config.ts";

interface StreamContext {
  requestId: string;
  aggregator: TextAggregator;
  writer: SSEWriter;
  nextBlockIndex: number;
  textBlockOpen: boolean;
  finished: boolean;
}

export class ClaudeStream {
  private context: StreamContext;

  constructor(private writer: SSEWriter, config: ProxyConfig, requestId: string) {
    this.context = {
      requestId,
      writer,
      aggregator: new TextAggregator(config.aggregationIntervalMs, (text) => this.flushText(text)),
      nextBlockIndex: 0,
      textBlockOpen: false,
      finished: false,
    };
    this.writer.send({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${requestId}`,
          model: "claude-proxy",
          role: "assistant",
        },
      },
    });
  }

  handleEvents(events: ParserEvent[]) {
    for (const event of events) {
      if (event.type === "text") {
        this.context.aggregator.add(event.content);
      } else if (event.type === "tool_call") {
        this.context.aggregator.flush();
        this.emitToolCall(event.call);
      } else if (event.type === "end") {
        this.finish();
      }
    }
  }

  private ensureTextBlock() {
    if (!this.context.textBlockOpen) {
      const index = this.context.nextBlockIndex++;
      this.context.textBlockOpen = true;
      this.writer.send({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      });
    }
  }

  private flushText(text: string) {
    if (!text) return;
    this.ensureTextBlock();
    this.writer.send({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: this.context.nextBlockIndex - 1,
        delta: { type: "text_delta", text },
      },
    });
  }

  private endTextBlock() {
    if (!this.context.textBlockOpen) return;
    this.context.textBlockOpen = false;
    const index = this.context.nextBlockIndex - 1;
    this.writer.send({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    });
  }

  private emitToolCall(call: ParsedInvokeCall) {
    this.endTextBlock();
    const index = this.context.nextBlockIndex++;
    const toolId = `toolu_${index}`;
    this.writer.send({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
      },
    });

    const inputJson = JSON.stringify(call.arguments);
    // split input JSON into two chunks for clarity
    const mid = Math.floor(inputJson.length / 2) || inputJson.length;
    const parts = [inputJson.slice(0, mid), inputJson.slice(mid)];
    for (const part of parts) {
      if (!part) continue;
      this.writer.send({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: part },
        },
      });
    }

    this.writer.send({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index,
      },
    });

    this.writer.send({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
        },
      },
    });
  }

  private finish() {
    if (this.context.finished) return;
    this.context.finished = true;
    this.context.aggregator.flush();
    this.endTextBlock();
    this.writer.send({
      event: "message_stop",
      data: { type: "message_stop" },
    });
  }
}
