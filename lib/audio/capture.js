import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveCaptureFormat, listAudioDevices, resolveDevice, defaultCaptureFormat } from "./devices.js";

const require = createRequire(import.meta.url);

/** Prefer a bundled ffmpeg-static when the config keeps the default `ffmpeg`. */
export function resolveFfmpegPath(configured = "ffmpeg") {
  const explicit = String(configured || "ffmpeg").trim() || "ffmpeg";
  if (explicit !== "ffmpeg") return explicit;
  try {
    const bundled = require("ffmpeg-static");
    if (typeof bundled === "string" && bundled) return bundled;
  } catch {
    // not installed; use PATH
  }
  return "ffmpeg";
}

export function buildFfmpegArgs(format, device) {
  const base = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  const output = ["-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"];

  switch (format) {
    case "dshow":
      // 100 ms buffers keep dictation responsive without dropping samples.
      return [...base, "-f", "dshow", "-audio_buffer_size", "100", "-i", `audio=${device || ""}`, ...output];
    case "avfoundation":
      return [...base, "-f", "avfoundation", "-i", `:${device || "0"}`, ...output];
    case "pulse":
      return [...base, "-f", "pulse", "-i", device || "default", ...output];
    case "alsa":
      return [...base, "-f", "alsa", "-i", device || "default", ...output];
    default:
      return [...base, "-f", defaultCaptureFormat(), "-i", device || "default", ...output];
  }
}

/**
 * A process that writes raw s16le / 16 kHz / mono PCM to stdout.
 * Ported from the VS Code extension so Windows, macOS and Linux share one path.
 */
export class ProcessPcmSource {
  constructor(logger) {
    this.logger = logger;
    this.onData = () => undefined;
    this.onError = () => undefined;
    this.onExit = () => undefined;
    this.stopping = false;
    this.child = undefined;
    this.stderrTail = "";
  }

  async start() {
    if (this.child) return;
    const prepared = await this.prepare();
    await new Promise((resolve, reject) => {
      let started = false;
      const child = spawn(prepared.command, prepared.args, {
        windowsHide: true,
        shell: prepared.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.stderrTail = "";

      child.once("error", (error) => {
        const decorated = this.decorate(error);
        if (!started) {
          started = true;
          this.child = undefined;
          reject(decorated);
        } else {
          this.onError(decorated);
        }
      });

      child.once("spawn", () => {
        started = true;
        resolve();
      });

      child.stdout?.on("data", (chunk) => {
        if (!this.stopping) this.onData(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
      });

      child.once("close", (code) => {
        if (this.child === child) this.child = undefined;
        this.onExit(code, this.stderrTail.trim());
      });
    });

    this.logger?.info?.(`recorder started: ${prepared.command} ${prepared.args.join(" ")}`);
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish();
      }, 1500);

      child.once("close", finish);
      try {
        child.kill();
      } catch {
        finish();
      }
    });

    this.child = undefined;
    this.stopping = false;
  }

  decorate(error) {
    if (error.code === "ENOENT") {
      return new Error(
        `Cannot start "${error.path ?? "the recorder"}": executable not found. ` +
          `Install ffmpeg or set audio.ffmpegPath in voice.json.`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export class FfmpegSource extends ProcessPcmSource {
  constructor(options, logger) {
    super(logger);
    this.options = options;
  }

  async prepare() {
    const format = resolveCaptureFormat(this.options.format);
    const ffmpegPath = resolveFfmpegPath(this.options.ffmpegPath);
    const devices = await listAudioDevices(ffmpegPath, format).catch(() => []);
    const device = resolveDevice(devices, this.options.device);

    if (devices.length > 0) {
      this.logger?.info?.(`audio devices (${format}): ${devices.map((entry) => `${entry.name} [${entry.id}]`).join(" | ")}`);
    }
    if (!device) this.logger?.warn?.("no audio input device was detected; starting ffmpeg with an empty device name");

    return { command: ffmpegPath, args: buildFfmpegArgs(format, device), shell: false };
  }
}

/** Runs a user supplied recorder that writes raw s16le/16 kHz/mono PCM to stdout. */
export class CommandSource extends ProcessPcmSource {
  constructor(commandLine, logger) {
    super(logger);
    this.commandLine = commandLine;
  }

  async prepare() {
    return { command: this.commandLine, args: [], shell: true };
  }
}

/** Decodes any audio file (webm/opus/mp3/wav/ogg/flac) into 16 kHz mono PCM. */
export function convertFileToPcm(inputPath, options = {}) {
  const ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
  const timeoutMs = options.timeoutMs ?? 120000;
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      fail(new Error(`ffmpeg did not finish within ${timeoutMs} ms`));
    }, timeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    child.stdout?.on("data", (chunk) => chunks.push(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (code === 0) done(Buffer.concat(chunks));
      else fail(new Error(`ffmpeg failed with code ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}
