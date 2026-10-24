import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { voiceDataDir } from "../paths.js";
import { parseMultipartBody } from "../stt/multipart.js";
import { withTempFile } from "../runtime.js";
import { playTone } from "../audio/cues.js";
import { copyToClipboard } from "../clipboard.js";

const BODY_LIMIT_FACTOR = 1.1;

/**
 * Local HTTP API for the Chrome extension / web UI and for diagnostics.
 *
 * Routes (compatible with the OpenCode-Voice browser extension):
 *   GET  /health
 *   POST /transcribe        (multipart "audio" or raw audio body)
 *   POST /hotkey            (global hotkey: record one phrase, copy to clipboard)
 *   POST /record/start      (server-side ffmpeg capture, one recording at a time)
 *   POST /record/stop
 *   GET  /record/status
 *   POST /record/cancel
 *   GET  /beep?freq=880
 *   POST /warmup
 *   POST /heal
 *   GET  /config
 *   GET  /doctor
 *   POST /reload
 */
export class VoiceHttpServer {
  constructor({ runtime, logger, port, host, token, allowedOrigins, copy } = {}) {
    this.runtime = runtime;
    this.logger = logger ?? runtime.logger;
    this.config = runtime.config;
    this.copy = copy ?? copyToClipboard;
    this.server = undefined;
    this.port = port ?? this.config.server.port;
    this.host = host ?? this.config.server.host;
    this.activeUploads = 0;
    this.startedAt = 0;
    this.discoveryFile = join(voiceDataDir(), "server.json");
  }

  get url() {
    const host = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
    return `http://${host}:${this.port}`;
  }

  get token() {
    return this.config.server.token || "";
  }

  get allowedOrigins() {
    return this.config.server.allowedOrigins || [];
  }

  async start({ retryPorts = 8 } = {}) {
    if (this.server) return this.url;

    for (let attempt = 0; attempt < retryPorts; attempt++) {
      try {
        await this.listen(this.port);
        this.startedAt = Date.now();
        this.writeDiscovery();
        this.logger.info(`voice HTTP server listening on ${this.url}`);
        return this.url;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        if (attempt === 0) {
          const existing = await probeServer(this.url);
          if (existing) {
            this.logger.info(`voice HTTP server already running on ${this.url}`);
            this.external = true;
            return this.url;
          }
        }
        this.port += 1;
      }
    }

    throw new Error(`could not bind the voice HTTP server on ports ${this.config.server.port}-${this.port}`);
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          this.logger.error("unhandled request error", { error: error?.message || String(error) });
          if (!response.headersSent) this.sendJson(response, 500, { ok: false, error: "internal error" });
          else response.destroy();
        });
      });
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        this.server = server;
        const address = server.address();
        if (port === 0 && address && typeof address === "object") this.port = address.port;
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = undefined;
    try {
      rmSync(this.discoveryFile, { force: true });
    } catch {}
  }

  writeDiscovery() {
    try {
      mkdirSync(voiceDataDir(), { recursive: true });
      writeFileSync(
        this.discoveryFile,
        `${JSON.stringify({ name: "opencode-voice", url: this.url, port: this.port, pid: process.pid, startedAt: this.startedAt }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // discovery is a convenience only
    }
  }

  async handle(request, response) {
    const url = new URL(request.url || "/", this.url);
    const origin = request.headers.origin;

    this.applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const route = url.pathname.replace(/\/+$/, "") || "/";
    this.logger.info(`${request.method} ${route}`);

    if (route === "/health") {
      this.sendJson(response, 200, {
        ok: true,
        name: "opencode-voice",
        version: "0.1.0",
        provider: this.runtime.provider,
        label: this.runtime.providerLabel,
        backend: this.runtime.provider,
        device: this.runtime.config.audio.device || "auto",
        language: this.runtime.config.language,
        auth: Boolean(this.token),
        max_upload_mb: this.runtime.config.server.maxUploadMb,
        max_audio_seconds: this.runtime.config.server.maxAudioSeconds,
        recording: this.runtime.status().recording,
        uptime_s: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
        pid: process.pid,
      });
      return;
    }

    if (!this.authorized(request)) {
      this.sendJson(response, 401, { ok: false, error: "unauthorized: X-Voice-Token is required" });
      return;
    }

    if (route === "/beep") {
      const freq = Number(url.searchParams.get("freq") ?? "880");
      if (freq > 0) playTone({ frequency: freq, durationMs: 90, volume: 15, ffmpegPath: this.runtime.config.audio.ffmpegPath });
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (route === "/config") {
      this.sendJson(response, 200, { ok: true, config: this.runtime.publicConfig(), files: this.runtime.configFiles });
      return;
    }

    if (route === "/hotkey") {
      if (this.runtime.status().recording) {
        await this.runtime.cancelRecording();
        this.sendJson(response, 200, { ok: true, cancelled: true });
        return;
      }
      try {
        const session = await this.runtime.startRecording({ oneShot: true });
        const info = await session.done;
        if (info?.cancelled) {
          this.sendJson(response, 200, { ok: false, cancelled: true });
          return;
        }
        if (info?.error) {
          this.sendJson(response, 500, { ok: false, error: info.error.message || String(info.error) });
          return;
        }
        const text = String(info?.transcript || "").trim();
        if (!text) {
          this.sendJson(response, 200, { ok: false, error: "no speech was recognized" });
          return;
        }
        const copied = await this.copy(text).catch(() => false);
        this.sendJson(response, 200, { ok: true, text, chars: text.length, copied });
      } catch (error) {
        this.sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
      }
      return;
    }

    if (route === "/record/start") {
      if (this.runtime.status().recording) {
        this.sendJson(response, 409, { ok: false, error: "already recording" });
        return;
      }
      const oneShot = ["1", "true", "yes"].includes(String(url.searchParams.get("oneShot") ?? "").toLowerCase());
      try {
        const session = await this.runtime.startRecording({ oneShot });
        this.sendJson(response, 200, { ok: true, ...session.status(), provider: this.runtime.provider });
      } catch (error) {
        this.sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
      }
      return;
    }

    if (route === "/record/stop") {
      try {
        const result = await this.runtime.stopRecording();
        this.sendJson(response, 200, {
          ok: true,
          text: result.text,
          duration_ms: result.info?.durationMs ?? 0,
          provider: result.info?.provider,
        });
      } catch (error) {
        this.sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
      }
      return;
    }

    if (route === "/record/status") {
      this.sendJson(response, 200, { ok: true, ...this.runtime.status() });
      return;
    }

    if (route === "/record/cancel") {
      const cancelled = await this.runtime.cancelRecording();
      this.sendJson(response, 200, { ok: true, cancelled });
      return;
    }

    if (route === "/transcribe") {
      await this.handleTranscribe(request, response);
      return;
    }

    if (route === "/warmup") {
      const result = await this.runtime.warmup();
      this.sendJson(response, result.ok ? 200 : 500, result);
      return;
    }

    if (route === "/heal") {
      await this.runtime.cancelRecording();
      this.runtime.reload();
      const result = await this.runtime.warmup();
      this.sendJson(response, 200, { ok: true, reloaded: true, warmup: result });
      return;
    }

    if (route === "/reload") {
      this.runtime.reload();
      this.sendJson(response, 200, { ok: true, config: this.runtime.publicConfig() });
      return;
    }

    if (route === "/doctor") {
      const text = await this.runtime.doctor();
      this.sendJson(response, 200, { ok: true, text });
      return;
    }

    if (route === "/" || route === "") {
      this.sendJson(response, 200, {
        ok: true,
        name: "opencode-voice",
        hint: "GET /health, POST /transcribe, POST /record/start|stop, GET /doctor",
      });
      return;
    }

    this.sendJson(response, 404, { ok: false, error: `unknown route: ${route}` });
  }

  async handleTranscribe(request, response) {
    const maxBytes = Math.round(this.runtime.config.server.maxUploadMb * 1024 * 1024);
    const maxConcurrent = Math.max(1, this.runtime.config.server.concurrency);
    if (this.activeUploads >= maxConcurrent) {
      this.sendJson(response, 429, { ok: false, error: "server is busy, try again" });
      return;
    }

    let body;
    try {
      body = await readBody(request, Math.round(maxBytes * BODY_LIMIT_FACTOR));
    } catch (error) {
      this.sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    const contentType = String(request.headers["content-type"] || "");
    let buffer = body;
    let extension = ".webm";
    let filename = "recording.webm";

    if (/multipart\/form-data/i.test(contentType)) {
      try {
        const parsed = parseMultipartBody(body, contentType);
        const file = parsed.files.find((entry) => entry.field === "audio") || parsed.files.find((entry) => entry.field === "file") || parsed.files[0];
        if (!file) {
          this.sendJson(response, 400, { ok: false, error: 'multipart body has no file field (expected "audio")' });
          return;
        }
        buffer = file.data;
        filename = file.name || filename;
        extension = extensionOf(filename, file.type);
      } catch (error) {
        this.sendJson(response, 400, { ok: false, error: `cannot parse multipart body: ${error.message}` });
        return;
      }
    } else {
      extension = extensionOf(String(request.headers["x-voice-filename"] || filename), contentType);
    }

    if (buffer.length === 0) {
      this.sendJson(response, 400, { ok: false, error: "empty audio body" });
      return;
    }
    if (buffer.length > maxBytes) {
      this.sendJson(response, 413, { ok: false, error: `audio is larger than ${this.runtime.config.server.maxUploadMb} MB` });
      return;
    }

    this.activeUploads += 1;
    const started = Date.now();
    try {
      const result = await withTempFile(buffer, extension, (file) =>
        this.runtime.transcribeAudioFile(file, { timeoutMs: this.runtime.config.openai.requestTimeoutMs }),
      );
      this.sendJson(response, 200, {
        ok: true,
        text: result.text,
        duration_ms: result.durationMs,
        took_ms: Date.now() - started,
        phrases: result.phrases,
        provider: result.provider,
        filename,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("transcribe failed", { error: message });
      this.sendJson(response, 500, { ok: false, error: message });
    } finally {
      this.activeUploads -= 1;
    }
  }

  authorized(request) {
    if (!this.token) return true;
    const header = request.headers["x-voice-token"];
    const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return header === this.token || bearer === this.token;
  }

  applyCors(request, response) {
    const origin = request.headers.origin;
    if (origin && this.originAllowed(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Voice-Token, X-Voice-Source, X-Voice-Filename, Authorization");
    response.setHeader("Access-Control-Max-Age", "86400");
  }

  originAllowed(origin) {
    if (origin === "null") return true;
    if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
    if (this.allowedOrigins.includes(origin)) return true;

    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const host = parsed.hostname;
    if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
    if (isPrivateHost(host)) return true;
    return false;
  }

  sendJson(response, status, payload) {
    if (response.headersSent) return;
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

export async function probeServer(url, timeoutMs = 1200) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.name === "opencode-voice" ? data : null;
  } catch {
    return null;
  }
}

/** Probes a small port range, so the browser extension can find a shifted server. */
export async function discoverServers(host, ports) {
  const results = [];
  for (const port of ports) {
    const url = `http://${host}:${port}`;
    const health = await probeServer(url, 400);
    if (health) results.push({ url, port, health });
  }
  return results;
}

function isPrivateHost(host) {
  if (!host) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host.endsWith(".local");
}

function extensionOf(filename, contentType) {
  const name = String(filename || "").toLowerCase();
  const match = /\.(wav|webm|ogg|opus|mp3|m4a|mp4|flac|aac|aiff|amr)$/i.exec(name);
  if (match) return `.${match[1]}`;
  const type = String(contentType || "").toLowerCase();
  if (type.includes("wav")) return ".wav";
  if (type.includes("ogg") || type.includes("opus")) return ".ogg";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  if (type.includes("flac")) return ".flac";
  return ".webm";
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.statusCode = status;
      reject(error);
      request.destroy();
    };

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        fail(413, "request body is too large");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => fail(400, error.message));
  });
}
