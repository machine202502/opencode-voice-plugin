import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logFile } from "./paths.js";

export function snippet(text, limit = 400) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}...` : single;
}

export function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Small file logger. OpenCode captures stdout/stderr, but a dedicated file is what
 * makes /voice doctor useful after the fact.
 */
export function createLogger(options = {}) {
  const file = options.file ?? logFile();
  const name = options.name ?? "voice";
  const echo = options.echo === true;

  const write = (level, message, extra) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${name}] ${message}${
      extra === undefined ? "" : ` ${safeJson(extra)}`
    }\n`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line, "utf8");
    } catch {
      // logging must never break dictation
    }
    if (echo || level === "error") {
      const sink = level === "error" ? console.error : console.log;
      sink(`[${name}] ${message}`);
    }
  };

  return {
    file,
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
