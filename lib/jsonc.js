// Minimal JSON-with-comments parser: enough for opencode.jsonc / voice.jsonc.
// Removes // and /* */ comments and trailing commas while respecting strings.

export function parseJsonc(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        out += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    out += char;
  }

  // Remove trailing commas: `,}` / `,]` (again, only outside strings).
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i];
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    cleaned += char;
  }

  return JSON.parse(cleaned);
}
