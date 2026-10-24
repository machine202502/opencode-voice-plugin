// Manual check: put Cyrillic text on the Windows clipboard and read it back.
// Reads through base64 so the console output code page cannot corrupt the comparison.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyToClipboard } from "../lib/clipboard.js";

const sample = "Привет, это проверка буфера — ёжик, «кавычки», 123.\nВторая строка: it's a test; $variable.";

const b64 = execFileSync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$t = Get-Clipboard -Raw; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))",
  ],
  { encoding: "ascii" },
).trim();

// Read before writing too, so a stale clipboard cannot look like success.
const ok = await copyToClipboard(sample, "win32");

const b64After = execFileSync(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$t = Get-Clipboard -Raw; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))",
  ],
  { encoding: "ascii" },
).trim();

const back = Buffer.from(b64After, "base64").toString("utf8").replace(/\r?\n$/, "");
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

console.log("copied:  ", ok);
console.log("expected:", sample.replace(/\n/g, "\\n"));
console.log("actual:  ", back.replace(/\n/g, "\\n"));
console.log("hash:    ", digest(sample), digest(back));
console.log("match:   ", back === sample);
if (!ok || back !== sample) process.exitCode = 1;
