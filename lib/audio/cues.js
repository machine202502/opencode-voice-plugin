import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeToneWav } from "./wav.js";
import { resolveFfmpegPath } from "./capture.js";

/** `...\ffmpeg.exe` -> `...\ffplay.exe`; a bare `ffmpeg` stays a bare `ffplay`. */
export function siblingExecutable(ffmpegPath, name) {
  const value = String(ffmpegPath || "");
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separator < 0) return name;
  const directory = value.slice(0, separator + 1);
  const base = value.slice(separator + 1);
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot) : "";
  return `${directory}${name}${extension}`;
}

/**
 * Generates a short WAV tone and plays it fire-and-forget.
 * ffplay (ships with ffmpeg) is tried first; then the platform player.
 */
export function playTone({ frequency = 880, durationMs = 120, volume = 15, ffmpegPath = "ffmpeg" } = {}) {
  const gain = Math.max(0, Math.min(100, Number(volume) || 0));
  if (gain <= 0) return;
  const wav = makeToneWav({ frequency, durationMs, volume: (gain / 100) * 0.35 });
  playWavBuffer(wav, { ffmpegPath });
}

export function playWavBuffer(wav, { ffmpegPath = "ffmpeg" } = {}) {
  const file = join(tmpdir(), `opencode-voice-cue-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    const fd = openSync(file, "w");
    writeSync(fd, wav);
    closeSync(fd);
  } catch {
    return;
  }

  const resolvedFfmpeg = resolveFfmpegPath(ffmpegPath);
  const candidates = [
    {
      command: siblingExecutable(resolvedFfmpeg, "ffplay"),
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file],
    },
  ];

  if (process.platform === "win32") {
    candidates.push({
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
      ],
    });
  } else if (process.platform === "darwin") {
    candidates.push({ command: "afplay", args: [file] });
  } else {
    candidates.push({ command: "paplay", args: [file] });
    candidates.push({ command: "aplay", args: ["-q", file] });
  }

  void tryPlayers(candidates, file);
}

async function tryPlayers(candidates, file) {
  for (const candidate of candidates) {
    try {
      await spawnOnce(candidate);
      setTimeout(() => rmSync(file, { force: true }), 5000).unref?.();
      return;
    } catch {
      // next player
    }
  }
  setTimeout(() => rmSync(file, { force: true }), 1000).unref?.();
}

function spawnOnce(candidate) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.args], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Start/end cues with the same defaults as the VS Code extension. */
export class SoundCues {
  constructor(logger) {
    this.logger = logger;
    this.warned = false;
  }

  play(kind, ffmpegPath, settings = {}) {
    const enabled = kind === "start" ? settings.start !== false : settings.end !== false;
    if (!enabled) return;
    const volume = Number(settings.volume ?? 15);
    if (volume <= 0) return;
    try {
      playTone({
        frequency: kind === "start" ? 880 : 520,
        durationMs: kind === "start" ? 110 : 150,
        volume,
        ffmpegPath,
      });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.logger?.warn?.(`sound cue unavailable: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
