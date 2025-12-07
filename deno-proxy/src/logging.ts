type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (Deno.env.get("LOG_LEVEL")?.toLowerCase() as LogLevel) ?? "info";

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (levelOrder[level] < levelOrder[configuredLevel]) return;
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta ?? {}),
  };
  const line = JSON.stringify(payload);
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}
