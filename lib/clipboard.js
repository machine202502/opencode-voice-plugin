import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POWERSHELL = "powershell.exe";

/** Clipboard writers in priority order. OpenCode 2 has no API to append to the prompt. */
export function clipboardCandidates(platform = process.platform) {
  if (platform === "win32") return [{ command: POWERSHELL, args: [] }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function run(command, args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, timeoutMs);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(String(input), "utf8");
    }
  });
}

/**
 * Windows: write a UTF-8 file and let PowerShell read it with -Encoding UTF8.
 *
 * Passing text through stdin is not reliable: Windows PowerShell decodes
 * redirected stdin with the console/OEM code page, so Cyrillic turns into
 * mojibake (UTF-8 bytes rendered as CP866). A temp file avoids the console
 * encoding entirely and also handles newlines, quotes and long transcripts.
 */
async function copyWindows(text, timeoutMs) {
  const directory = mkdtempSync(join(tmpdir(), "opencode-voice-clip-"));
  const file = join(directory, "clipboard.txt");
  try {
    writeFileSync(file, String(text), "utf8");
    const literal = file.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$text = Get-Content -Raw -Encoding UTF8 -LiteralPath '${literal}'`,
      "Set-Clipboard -Value $text",
    ].join("; ");
    return await run(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs });
  } catch {
    return false;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
}

/** Copies text to the system clipboard. Resolves false when every writer failed. */
export async function copyToClipboard(text, platform = process.platform, timeoutMs = 15000) {
  if (platform === "win32") return copyWindows(text, timeoutMs);
  for (const candidate of clipboardCandidates(platform)) {
    if (await run(candidate.command, candidate.args, { input: text, timeoutMs })) return true;
  }
  return false;
}
