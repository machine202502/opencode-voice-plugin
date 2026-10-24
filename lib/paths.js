// Paths used by the plugin. Everything is cross-platform; no WSL paths.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

/** `~` / `~/x` / `~\x` -> absolute path. */
export function expandHome(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
    return join(homeDir(), text.slice(1).replace(/^[\\/]/, ""));
  }
  return text;
}

export function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homeDir(), ".config");
}

export function opencodeConfigDir() {
  return join(configHome(), "opencode");
}

export function dataHome() {
  return process.env.XDG_DATA_HOME || join(homeDir(), ".local", "share");
}

export function cacheHome() {
  return process.env.XDG_CACHE_HOME || join(homeDir(), ".cache");
}

export function voiceDataDir() {
  return join(dataHome(), "opencode", "voice");
}

export function voiceCacheDir() {
  return join(cacheHome(), "opencode", "voice");
}

export function logFile() {
  return process.env.OPENCODE_VOICE_LOG || join(voiceDataDir(), "voice.log");
}

export function ensureDir(directory) {
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // best effort
  }
  return directory;
}

/**
 * Config search order (later files win):
 *   1. <global>/opencode/voice.json
 *   2. <project>/.opencode/voice.json
 *   3. OPENCODE_VOICE_CONFIG
 */
export function configCandidates(directory = process.cwd()) {
  const list = [
    join(opencodeConfigDir(), "voice.json"),
    join(opencodeConfigDir(), "voice.jsonc"),
  ];
  if (directory) {
    list.push(join(directory, ".opencode", "voice.json"));
    list.push(join(directory, ".opencode", "voice.jsonc"));
  }
  const explicit = process.env.OPENCODE_VOICE_CONFIG;
  if (explicit) list.push(resolve(expandHome(explicit)));
  return [...new Set(list)];
}

export function defaultConfigPath() {
  return join(opencodeConfigDir(), "voice.json");
}

export function firstExistingConfigPath(directory = process.cwd()) {
  return configCandidates(directory).find((candidate) => existsSync(candidate)) || null;
}
