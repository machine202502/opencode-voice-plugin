import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODIFIERS = {
  alt: 0x0001,
  ctrl: 0x0002,
  control: 0x0002,
  shift: 0x0004,
  win: 0x0008,
  meta: 0x0008,
  super: 0x0008,
};

const SPECIAL_KEYS = {
  space: 0x20,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
};

function virtualKey(name) {
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  const fKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
  if (fKey) return 0x70 + Number(fKey[1]) - 1;
  return SPECIAL_KEYS[name];
}

/**
 * Parses `ctrl+alt+d` into the Win32 RegisterHotKey arguments.
 * Returns null for empty or unsupported combinations.
 */
export function parseHotkey(value) {
  const parts = String(value ?? "")
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  let modifiers = 0;
  let key;
  for (const part of parts) {
    if (MODIFIERS[part] !== undefined) modifiers |= MODIFIERS[part];
    else if (key === undefined) key = part;
    else return null;
  }
  if (!modifiers || !key) return null;

  const code = virtualKey(key);
  if (!code) return null;
  return { modifiers, virtualKey: code, normalized: parts.join("+") };
}

// One listener per process: OpenCode may evaluate the plugin several times.
const REGISTRY = Symbol.for("opencode.voice.globalHotkey");
const shared = globalThis[REGISTRY] instanceof Map ? globalThis[REGISTRY] : (globalThis[REGISTRY] = new Map());

/**
 * Starts a small PowerShell listener for the configured hotkey on Windows.
 * The listener calls `POST <url>/hotkey` and optionally pastes the result into
 * the window that was focused when the hotkey was pressed.
 *
 * `onlyOpenCode` switches it to a low-level keyboard hook: the combination is
 * consumed only while OpenCode is in the foreground, and every other
 * application (editor, browser, terminal) still receives the keystroke. Without
 * it the combination is registered with `RegisterHotKey` and belongs to OpenCode
 * system-wide.
 */
export function startGlobalHotkey(options) {
  const { hotkey, url, token = "", paste = false, onlyOpenCode = true, logger } = options;
  if (process.platform !== "win32" || !hotkey) return { stop() {}, info: null };

  const parsed = parseHotkey(hotkey);
  if (!parsed) {
    logger?.warn?.("global hotkey is not supported", { hotkey });
    return { stop() {}, info: null };
  }

  // MOD_NOREPEAT: holding the combination must not queue one recording per
  // keyboard repeat. Without it a held Ctrl+Alt+D starts a new recording as
  // soon as the previous one finishes.
  const modifiers = parsed.modifiers | 0x4000;
  const key = `${url}|${parsed.normalized}|${paste ? "paste" : "copy"}|${onlyOpenCode ? "opencode" : "global"}`;
  const existing = shared.get(key);
  if (existing) return existing;

  const script = join(dirname(fileURLToPath(import.meta.url)), "hotkey.ps1");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Url",
    url,
    "-Modifiers",
    String(modifiers),
    "-VirtualKey",
    String(parsed.virtualKey),
  ];
  if (token) args.push("-Token", token);
  if (paste) args.push("-Paste");
  if (onlyOpenCode) args.push("-OnlyOpenCode");

  let child;
  try {
    child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    logger?.warn?.("could not start the global hotkey listener", { error: error?.message || String(error) });
    return { stop() {}, info: null };
  }

  const handle = {
    info: { hotkey: parsed.normalized, paste },
    stop() {
      shared.delete(key);
      try {
        child.kill();
      } catch {}
    },
  };
  shared.set(key, handle);

  child.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) logger?.info?.("global hotkey listener", { message: text, hotkey: parsed.normalized });
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) logger?.warn?.("global hotkey listener", { message: text, hotkey: parsed.normalized });
  });
  child.on("error", (error) => {
    shared.delete(key);
    logger?.warn?.("global hotkey listener failed", { error: error?.message || String(error) });
  });
  child.on("exit", (code) => {
    shared.delete(key);
    logger?.info?.("global hotkey listener stopped", { code, hotkey: parsed.normalized });
  });

  return handle;
}
