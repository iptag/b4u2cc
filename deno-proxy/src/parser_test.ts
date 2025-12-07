import { ToolifyParser } from "./parser.ts";

function feed(parser: ToolifyParser, text: string) {
  for (const char of text) {
    parser.feedChar(char);
  }
}

Deno.test("ToolifyParser emits text and tool_call events", () => {
  const parser = new ToolifyParser("<<CALL_aa11>>");
  const input =
    `Thoughts...<<CALL_aa11>>\n<invoke name="get_weather">\n<parameter name="city">"New York"</parameter>\n<parameter name="unit">"c"</parameter>\n</invoke>\n`;
  feed(parser, input);
  parser.finish();
  const events = parser.consumeEvents();

  const textEvent = events.find((e) => e.type === "text");
  if (!textEvent || textEvent.type !== "text") {
    throw new Error("Expected text event");
  }
  if (!textEvent.content.includes("Thoughts")) {
    throw new Error("Text event missing content");
  }

  const toolEvent = events.find((e) => e.type === "tool_call");
  if (!toolEvent || toolEvent.type !== "tool_call") {
    throw new Error("Expected tool call event");
  }
  if (toolEvent.call.name !== "get_weather") {
    throw new Error("Tool call name mismatch");
  }
  if (toolEvent.call.arguments.city !== "New York") {
    throw new Error("Tool arguments not parsed");
  }
});
