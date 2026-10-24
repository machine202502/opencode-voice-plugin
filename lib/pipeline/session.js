import { createTranscriber } from "../stt/createTranscriber.js";
import { FfmpegSource, CommandSource } from "../audio/capture.js";
import { SoundCues } from "../audio/cues.js";
import { RecognitionPipeline } from "./recognition.js";

/**
 * One voice-input run. Recognition happens in parallel with recording; text is
 * returned on stop. `oneShot` makes a single hotkey press enough: after speech was
 * detected, 1.4 s of silence closes the session automatically.
 */
export class VoiceSession {
  constructor(config, hooks = {}, logger, options = {}) {
    this.config = config;
    this.hooks = hooks;
    this.logger = logger;
    this.options = options;
    this.state = "idle";
    this.transcript = "";
    this.level = 0;
    this.startedAt = 0;
    this.lastVoicedAt = 0;
    this.sawVoice = false;
    this.ticker = undefined;
    this.finishPromise = undefined;
    this.transcriber = undefined;
    this.pipeline = undefined;
    this.cues = new SoundCues(logger);
    this.endCuePlayed = false;
    this.oneShot = options.oneShot === true;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.endInfo = undefined;
  }

  get active() {
    return this.state === "listening" || this.state === "working";
  }

  get recording() {
    return this.state === "listening";
  }

  elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  status() {
    return {
      state: this.state,
      recording: this.state === "listening",
      elapsed_ms: this.elapsedMs(),
      level: this.level,
      transcript: this.transcript,
    };
  }

  async start() {
    if (this.active) return;
    this.startedAt = Date.now();
    this.lastVoicedAt = this.startedAt;
    this.sawVoice = false;
    this.transcript = "";
    this.level = 0;
    this.endCuePlayed = false;
    this.finishPromise = undefined;

    const transcriber = this.options.transcriber ?? createTranscriber(this.config, this.logger);
    const source =
      this.options.source ??
      (this.config.command?.capture
        ? new CommandSource(this.config.command.capture, this.logger)
        : new FfmpegSource(
            {
              ffmpegPath: this.config.audio.ffmpegPath,
              format: this.config.audio.inputFormat,
              device: this.config.audio.device,
            },
            this.logger,
          ));

    this.transcriber = transcriber;
    this.pipeline = new RecognitionPipeline(
      source,
      transcriber,
      {
        segmenter: {
          silenceMs: this.config.audio.silenceMs,
          minSegmentMs: this.config.audio.minSegmentMs,
          maxSegmentMs: this.config.audio.maxSegmentMs,
          noiseThreshold: this.config.audio.noiseThreshold,
        },
        promptPrefix: this.config.openai.prompt,
        sendContextPrompt: this.config.openai.sendContextPrompt,
        concurrency: this.config.server.concurrency,
      },
      this.logger,
    );

    this.state = "listening";
    this.cues.play("start", this.config.audio.ffmpegPath, this.config.audio.cues);
    this.hooks.onState?.("listening", this);

    try {
      await this.pipeline.start({
        onLevel: (level) => {
          this.level = level;
          if (level > 0.004) {
            this.lastVoicedAt = Date.now();
            this.sawVoice = true;
          }
        },
        onTranscript: (text) => {
          this.transcript = text;
          this.hooks.onTranscript?.(text, this);
        },
        onError: (error) => this.hooks.onError?.(error, this),
        onRecorderEnded: () => {
          if (this.state === "listening") void this.stop("recorder-ended");
        },
      });
    } catch (error) {
      this.state = "idle";
      this.stopTicker();
      this.cues.play("end", this.config.audio.ffmpegPath, this.config.audio.cues);
      throw error;
    }

    this.ticker = setInterval(() => this.tick(), 100);
  }

  tick() {
    if (this.state !== "listening") return;
    this.hooks.onUpdate?.(this.status(), this);

    const silentFor = Date.now() - this.lastVoicedAt;
    const oneShotMs = Number(this.config.audio.oneShotSilenceMs) || 0;
    const autoStopMs = Number(this.config.audio.autoStopSilenceMs) || 0;

    if (this.oneShot && this.sawVoice && oneShotMs > 0 && silentFor >= oneShotMs) {
      void this.stop("one-shot");
      return;
    }
    if (autoStopMs > 0 && silentFor >= autoStopMs) {
      void this.stop("auto-stop");
    }
  }

  /** Mic off immediately, then wait for phrases still in flight. */
  stop(reason = "manual") {
    this.finishPromise ??= this.doFinish(reason);
    return this.finishPromise;
  }

  async doFinish(reason) {
    if (this.state === "idle") return this.transcript;
    this.state = "working";
    this.hooks.onState?.("working", this);
    this.stopTicker();
    this.playEndCue();

    let error;
    try {
      this.transcript = (await this.pipeline?.stop()) ?? this.transcript;
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
      this.hooks.onError?.(error, this);
    } finally {
      this.state = "idle";
      this.playEndCue();
      this.endInfo = {
        transcript: this.transcript,
        cancelled: false,
        reason,
        error,
        provider: this.transcriber?.provider,
        label: this.transcriber?.label,
        durationMs: this.elapsedMs(),
      };
      this.hooks.onEnd?.(this.endInfo, this);
      this.resolveDone?.(this.endInfo);
    }
    return this.transcript;
  }

  async cancel(reason = "cancelled") {
    if (this.state === "idle") return;
    this.state = "cancelling";
    this.stopTicker();
    this.playEndCue();
    await this.pipeline?.cancel();
    this.state = "idle";
    this.transcript = "";
    this.endInfo = {
      transcript: "",
      cancelled: true,
      reason,
      provider: this.transcriber?.provider,
      label: this.transcriber?.label,
      durationMs: this.elapsedMs(),
    };
    this.hooks.onEnd?.(this.endInfo, this);
    this.resolveDone?.(this.endInfo);
  }

  playEndCue() {
    if (this.endCuePlayed) return;
    this.endCuePlayed = true;
    this.cues.play("end", this.config.audio.ffmpegPath, this.config.audio.cues);
  }

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }
}
