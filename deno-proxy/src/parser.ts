import { ParsedInvokeCall, ParserEvent } from "./types.ts";
import { log } from "./logging.ts";

function parseInvokeXml(xml: string): ParsedInvokeCall | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");
    if (!doc) return null;
    const invoke = doc.querySelector("invoke");
    if (!invoke) return null;
    const name = invoke.getAttribute("name") ?? "";
    const params: Record<string, unknown> = {};
    doc.querySelectorAll("parameter").forEach((param) => {
      const key = param.getAttribute("name");
      if (!key) return;
      const rawValue = param.textContent ?? "";
      let value: unknown = rawValue;
      const trimmed = rawValue.trim();
      if (trimmed) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = trimmed;
        }
      }
      params[key] = value;
    });
    return { name, arguments: params };
  } catch (error) {
    log("warn", "Failed to parse invoke XML", { error: String(error) });
    return null;
  }
}

export class ToolifyParser {
  private readonly triggerSignal: string;
  private buffer = "";
  private captureBuffer = "";
  private capturing = false;
  private readonly events: ParserEvent[] = [];

  constructor(triggerSignal: string) {
    this.triggerSignal = triggerSignal;
  }

  feedChar(char: string) {
    if (this.capturing) {
      this.captureBuffer += char;
      this.tryEmitInvokes();
      return;
    }

    this.buffer += char;
    if (this.buffer.endsWith(this.triggerSignal)) {
      const textPortion = this.buffer.slice(0, -this.triggerSignal.length);
      if (textPortion) {
        this.events.push({ type: "text", content: textPortion });
      }
      this.buffer = "";
      this.capturing = true;
      this.captureBuffer = "";
    }
  }

  finish() {
    if (this.buffer) {
      this.events.push({ type: "text", content: this.buffer });
    }
    this.tryEmitInvokes(true);
    this.events.push({ type: "end" });
    this.buffer = "";
    this.captureBuffer = "";
  }

  consumeEvents(): ParserEvent[] {
    const pending = this.events.splice(0, this.events.length);
    return pending;
  }

  private tryEmitInvokes(force = false) {
    while (true) {
      const startIdx = this.captureBuffer.indexOf("<invoke");
      if (startIdx === -1) {
        if (force && this.captureBuffer) {
          this.events.push({ type: "text", content: this.captureBuffer });
          this.captureBuffer = "";
          this.capturing = false;
        }
        return;
      }

      const endIdx = this.captureBuffer.indexOf("</invoke>", startIdx);
      if (endIdx === -1) return;

      const endPos = endIdx + "</invoke>".length;
      const invokeXml = this.captureBuffer.slice(startIdx, endPos);
      const before = this.captureBuffer.slice(0, startIdx);
      if (before) {
        this.events.push({ type: "text", content: before });
      }

      this.captureBuffer = this.captureBuffer.slice(endPos);
      const parsed = parseInvokeXml(invokeXml);
      if (parsed) {
        this.events.push({ type: "tool_call", call: parsed });
      }
    }
  }
}
