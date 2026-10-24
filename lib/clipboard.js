import { spawn } from "node:child_process";

const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
];

/** Clipboard writers in priority order. OpenCode 2 has no API to append to the prompt. */
export function clipboardCandidates(platform = process.platform) {
  if (platform === "win32") return [{ command: "powershell.exe", args: POWERSHELL_ARGS }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function writeToCandidate(candidate, text, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(candidate.command, candidate.args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
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
    child.stdin.on("error", () => {});
    child.stdin.end(String(text), "utf8");
  });
}

/** Copies text to the system clipboard. Resolves false when every writer failed. */
export async function copyToClipboard(text, platform = process.platform, timeoutMs = 5000) {
  for (const candidate of clipboardCandidates(platform)) {
    if (await writeToCandidate(candidate, text, timeoutMs)) return true;
  }
  return false;
}
