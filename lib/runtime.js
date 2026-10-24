import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";
import { loadConfig, normalizeConfig, providerLabel, resolveProvider, publicConfig } from "./config.js";
import { createTranscriber } from "./stt/createTranscriber.js";
import { resolveOnnxModel, findSherpaExecutable, websocketServerBinary, sherpaServersStatus, resetSherpaServers } from "./stt/sherpa.js";
import { resolveModelFile, findWhisperExecutable } from "./stt/localWhisper.js";
import { convertFileToPcm, resolveFfmpegPath } from "./audio/capture.js";
import { listAudioDevices, resolveCaptureFormat } from "./audio/devices.js";
import { Segmenter } from "./audio/segmenter.js";
import { int16FromBuffer, rmsOf } from "./audio/wav.js";
import { VoiceSession } from "./pipeline/session.js";
import { joinTranscript } from "./stt/language.js";
import { execFileText } from "./audio/devices.js";

/**
 * Process-wide voice runtime: config + current recording + warm STT engine.
 * The TUI plugin and the HTTP server both use this class, so /voice (terminal)
 * and the web microphone button share the same settings and warm model.
 */
export class VoiceRuntime {
  constructor(options = {}) {
    this.directory = options.directory || process.cwd();
    this.logger = options.logger || createLogger();
    const loaded = options.config ? null : loadConfig({ directory: this.directory });
    this.config = options.config ? normalizeConfig(options.config) : loaded.config;
    this.configFiles = loaded?.files || [];
    this.configErrors = loaded?.errors || [];
    this.transcriber = undefined;
    this.session = undefined;
    this.lastError = undefined;
    this.lastSession = undefined;
    this.onChange = options.onChange;
    /** Test / advanced hooks: used when startRecording() gets no explicit source/transcriber. */
    this.defaultSource = options.source;
    this.defaultTranscriber = options.transcriber;
  }

  reload() {
    const loaded = loadConfig({ directory: this.directory });
    this.config = loaded.config;
    this.configFiles = loaded.files;
    this.configErrors = loaded.errors;
    this.transcriber = undefined;
    resetSherpaServers();
    this.logger.info("config reloaded", { files: loaded.files, errors: loaded.errors });
    this.onChange?.(this.config);
    return this.config;
  }

  get provider() {
    return resolveProvider(this.config);
  }

  get providerLabel() {
    return providerLabel(this.config, this.provider);
  }

  publicConfig() {
    return publicConfig(this.config);
  }

  getTranscriber() {
    if (!this.transcriber) {
      this.transcriber = createTranscriber(this.config, this.logger);
      this.logger.info("transcriber ready", this.transcriber.info?.());
    }
    return this.transcriber;
  }

  async warmup() {
    try {
      const transcriber = this.getTranscriber();
      const result = await transcriber.warmup?.();
      return { ok: true, provider: transcriber.provider, label: transcriber.label, ...result };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("warmup failed", { error: this.lastError });
      return { ok: false, error: this.lastError };
    }
  }

  status() {
    return {
      ...(this.session ? this.session.status() : { state: "idle", recording: false, elapsed_ms: 0, level: 0, transcript: "" }),
      provider: this.provider,
      label: this.providerLabel,
      warm: sherpaServersStatus(),
      lastError: this.lastError,
    };
  }

  async startRecording(options = {}) {
    if (this.session?.active) {
      const error = new Error("already recording");
      error.statusCode = 409;
      throw error;
    }
    this.lastError = undefined;
    const session = new VoiceSession(
      this.config,
      {
        onState: (state) => this.onChange?.({ type: "state", state }),
        onTranscript: (text) => this.onChange?.({ type: "transcript", text }),
        onUpdate: (status) => this.onChange?.({ type: "status", status }),
        onError: (error) => {
          this.lastError = error.message;
          this.logger.error("voice session error", { error: error.message });
        },
        onEnd: (info) => {
          this.lastSession = info;
          if (info.transcript) {
            this.logger.info("recognized", {
              provider: info.provider,
              chars: info.transcript.length,
              reason: info.reason,
            });
          }
          this.onChange?.({ type: "end", info });
        },
      },
      this.logger,
      {
        oneShot: options.oneShot === true,
        oneShotSilenceMs: options.oneShotSilenceMs,
        transcriber: options.transcriber ?? this.defaultTranscriber,
        source: options.source ?? this.defaultSource,
      },
    );

    this.session = session;
    await session.start();
    return session;
  }

  async stopRecording() {
    const session = this.session;
    if (!session || !session.active) {
      const error = new Error("not recording");
      error.statusCode = 409;
      throw error;
    }
    const text = await session.stop("api");
    return { text, info: this.lastSession };
  }

  async cancelRecording() {
    const session = this.session;
    if (!session || !session.active) return false;
    await session.cancel("api");
    return true;
  }

  /**
   * Transcribes an uploaded audio file (browser MediaRecorder -> /transcribe).
   * Converts with ffmpeg, splits into phrases and recognizes them in parallel.
   */
  async transcribeAudioFile(file, options = {}) {
    const started = Date.now();
    const pcm = await convertFileToPcm(file, {
      ffmpegPath: this.config.audio.ffmpegPath,
      timeoutMs: options.timeoutMs ?? this.config.openai.requestTimeoutMs,
    });
    return this.transcribePcm(int16FromBuffer(pcm), { ...options, started });
  }

  async transcribePcm(pcm, options = {}) {
    const started = options.started ?? Date.now();
    if (!pcm.length) return { text: "", durationMs: 0, phrases: 0 };

    const transcriber = this.getTranscriber();
    const segmenter = new Segmenter({
      silenceMs: this.config.audio.silenceMs,
      minSegmentMs: this.config.audio.minSegmentMs,
      maxSegmentMs: this.config.audio.maxSegmentMs,
      noiseThreshold: this.config.audio.noiseThreshold,
    });

    let segments = segmenter.push(pcm);
    segments = segments.concat(segmenter.flush());

    // If VAD found nothing but the clip has audible energy, send it as one phrase:
    // the user pressed stop, so the model should decide, not the silence gate.
    if (segments.length === 0) {
      const level = rmsOf(pcm);
      if (level >= Math.max(0.0015, segmenter.threshold * 0.5)) {
        segments = [{ pcm, durationMs: Math.round((pcm.length / 16000) * 1000), peakRms: level }];
      } else {
        return { text: "", durationMs: Math.round((pcm.length / 16000) * 1000), phrases: 0 };
      }
    }

    const results = new Array(segments.length).fill("");
    let cursor = 0;
    let transcript = "";
    const concurrency = Math.max(1, this.config.server.concurrency);

    const worker = async () => {
      while (cursor < segments.length) {
        const index = cursor++;
        const segment = segments[index];
        try {
          const prompt = this.config.openai.sendContextPrompt
            ? [this.config.openai.prompt, transcript.slice(-200)].filter(Boolean).join(" ").trim() || undefined
            : this.config.openai.prompt || undefined;
          const text = (
            await transcriber.transcribe({
              pcm: segment.pcm,
              prompt,
              signal: options.signal,
            })
          ).trim();
          results[index] = text;
          transcript = joinTranscript(transcript, text);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.logger.error(`uploaded phrase ${index + 1} failed`, { error: this.lastError });
          throw error;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));
    const text = joinTranscript("", results.filter(Boolean).join(" "));
    return {
      text,
      durationMs: Math.round((pcm.length / 16000) * 1000),
      phrases: segments.length,
      tookMs: Date.now() - started,
      provider: transcriber.provider,
      label: transcriber.label,
    };
  }

  async doctor() {
    const loaded = loadConfig({ directory: this.directory });
    const config = loaded.config;
    const provider = resolveProvider(config);
    const lines = [];
    const push = (line = "") => lines.push(line);

    push("# OpenCode Voice diagnostics");
    push();
    push(`- Plugin: opencode-voice (${providerLabel(config, provider)})`);
    push(`- Platform: ${process.platform} (${process.arch}), Node ${process.version}`);
    push(`- Directory: ${this.directory}`);
    push(`- Config files: ${loaded.files.length ? loaded.files.join(", ") : "(none — defaults are used)"}`);
    if (loaded.errors.length) push(`- Config errors: ${loaded.errors.join("; ")}`);
    push(`- Provider: ${config.provider} -> ${provider}`);
    push(`- Language: ${config.language}`);
    push(`- Hotkey: ${config.hotkey}`);
    push();

    push("## Audio capture");
    const ffmpeg = resolveFfmpegPath(config.audio.ffmpegPath);
    const version = await execFileText(ffmpeg, ["-version"], 5000);
    const versionLine = version.split(/\r?\n/).find((line) => /ffmpeg version/i.test(line));
    push(`- ffmpeg: ${versionLine ? versionLine.trim() : `not available (${version.slice(0, 200)})`}`);
    push(`- Capture format: ${resolveCaptureFormat(config.audio.inputFormat)}`);
    const devices = await listAudioDevices(ffmpeg, resolveCaptureFormat(config.audio.inputFormat)).catch(() => []);
    push(`- Microphones: ${devices.length}`);
    for (const device of devices.slice(0, 20)) push(`  - ${device.name} -> ${device.id}`);
    push(`- Selected: ${config.audio.device || "automatic (first input)"}`);
    push(`- VAD: silence ${config.audio.silenceMs} ms, one-shot ${config.audio.oneShotSilenceMs} ms, threshold ${config.audio.noiseThreshold || "adaptive"}`);
    push();

    push("## Recognition");
    if (provider === "local-onnx") {
      const model = resolveOnnxModel(config.onnx.modelPath, { precision: config.onnx.precision });
      push(`- Model: ${model ? model.modelFile : `not found (${config.onnx.modelPath || "not set"})`}`);
      push(`- Tokens: ${model ? model.tokensFile : "not found"}`);
      const executable = model ? findSherpaExecutable({ explicit: config.onnx.executablePath, modelFile: model.modelFile }) : undefined;
      push(`- sherpa-onnx CLI: ${executable || "not found"}`);
      const server = executable ? websocketServerBinary(executable) : "";
      push(`- Warm server: ${server ? server : "n/a"} (mode ${config.onnx.mode})`);
      const status = sherpaServersStatus();
      push(`- Running warm servers: ${status.length ? JSON.stringify(status) : "none yet"}`);
    } else if (provider === "local-whisper") {
      const model = resolveModelFile(config.local.modelPath);
      const executable = model ? findWhisperExecutable({ explicit: config.local.executablePath, modelFile: model }) : undefined;
      push(`- Model: ${model || `not found (${config.local.modelPath || "not set"})`}`);
      push(`- whisper-cli: ${executable || "not found"}`);
    } else if (provider === "openai-compatible") {
      push(`- Endpoint: ${config.openai.baseUrl}`);
      push(`- Model: ${config.openai.model}`);
      push(`- API key: ${config.openai.apiKey ? "set" : "not set"}`);
      try {
        const response = await fetch(`${config.openai.baseUrl.replace(/\/+$/, "")}/models`, {
          signal: AbortSignal.timeout(5000),
        });
        push(`- Reachability: HTTP ${response.status}`);
      } catch (error) {
        push(`- Reachability: failed (${error instanceof Error ? error.message : error})`);
      }
    } else if (provider === "salute") {
      push(`- Token URL: ${config.salute.tokenUrl}`);
      push(`- Recognize URL: ${config.salute.recognizeUrl}`);
      push(`- Credentials: ${config.salute.authorizationKey || (config.salute.clientId && config.salute.clientSecret) ? "set" : "missing"}`);
    } else {
      push(`- Command: ${config.command.transcribe || "not configured"}`);
    }
    push();

    push("## HTTP server");
    push(`- Enabled: ${config.server.enabled}`);
    push(`- Address: http://${config.server.host}:${config.server.port}`);
    push(`- Token: ${config.server.token ? "set" : "not set"}`);
    push(`- Limits: ${config.server.maxUploadMb} MB, ${config.server.maxAudioSeconds} s, concurrency ${config.server.concurrency}`);
    push();
    push("Tip: `/voice-warmup` starts the local engine now; `/voice-reload` re-reads voice.json (or POST /warmup, /reload).");

    return lines.join("\n");
  }

  dispose() {
    void this.session?.cancel("dispose");
    resetSherpaServers();
    this.transcriber = undefined;
  }
}

/** Helper used by tests and by /transcribe when no file is on disk. */
export async function withTempFile(data, extension, callback) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-voice-"));
  const file = join(directory, `audio${extension || ".wav"}`);
  await writeFile(file, data);
  try {
    return await callback(file);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
