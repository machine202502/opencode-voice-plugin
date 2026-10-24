import { int16FromBuffer, PCM_SAMPLE_RATE, rmsOf } from "../audio/wav.js";
import { Segmenter } from "../audio/segmenter.js";
import { joinTranscript } from "../stt/language.js";

const DEFAULT_CONCURRENCY = 2;

/**
 * Capture -> voice activity segmentation -> recognition.
 *
 * Recognition runs while the user speaks: every finished phrase goes to the model
 * right away, so only the tail is left when the user stops. Stopping the recording
 * never cancels requests already in flight.
 */
export class RecognitionPipeline {
  constructor(source, transcriber, options = {}, logger) {
    this.source = source;
    this.transcriber = transcriber;
    this.options = options;
    this.logger = logger;
    this.segmenter = new Segmenter(options.segmenter || {});
    this.controller = new AbortController();
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.results = [];
    this.queue = [];
    this.inFlight = new Set();
    this.handlers = undefined;
    this.state = "idle";
    this.cancelled = false;
    this.scheduled = 0;
    this.stopPromise = undefined;
    this.sampleCount = 0;
  }

  get durationMs() {
    return Math.round((this.sampleCount / PCM_SAMPLE_RATE) * 1000);
  }

  get text() {
    return joinAll(this.results);
  }

  async start(handlers) {
    if (this.state !== "idle") return;
    this.handlers = handlers;
    this.state = "running";

    this.source.onData = (chunk) => {
      if (this.state === "idle" || this.cancelled) return;
      const pcm = int16FromBuffer(chunk);
      this.sampleCount += pcm.length;
      handlers.onLevel?.(rmsOf(pcm));
      for (const segment of this.segmenter.push(pcm)) this.enqueue(segment);
    };
    this.source.onError = (error) => {
      if (this.state === "running") {
        this.logger?.error?.("capture failed", { error: error.message });
        handlers.onError?.(error);
      }
    };
    this.source.onExit = (code, stderr) => {
      if (this.state !== "running") return;
      this.logger?.error?.(`recorder exited unexpectedly (code ${code})`, { stderr });
      handlers.onError?.(new Error(stderr || `The audio recorder exited with code ${code ?? "?"}.`));
      handlers.onRecorderEnded?.();
    };

    try {
      await this.source.start();
    } catch (error) {
      this.state = "idle";
      throw error;
    }
  }

  async stop() {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  async cancel() {
    this.cancelled = true;
    this.state = "stopping";
    this.queue.length = 0;
    this.segmenter.reset();
    this.controller.abort();
    await this.source.stop().catch(() => undefined);
    await drainAll(this.inFlight);
    this.state = "idle";
    this.logger?.info?.("voice input cancelled");
  }

  async doStop() {
    if (this.state === "idle") return this.text;
    this.state = "stopping";

    await this.source.stop().catch((error) => this.logger?.warn?.(`stopping the recorder failed: ${error.message}`));
    for (const segment of this.segmenter.flush()) this.enqueue(segment);

    const pendingSince = Date.now();
    await drainAll(this.inFlight);
    const waited = Date.now() - pendingSince;
    this.state = "idle";

    const transcript = this.text;
    this.logger?.info?.(`voice stopped: ${this.scheduled} phrase(s), ${transcript.length} chars (waited ${waited} ms)`);
    return transcript;
  }

  enqueue(segment) {
    this.results.push("");
    this.queue.push({ index: this.scheduled++, segment });
    this.pump();
  }

  pump() {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) return;
      const job = this.runTask(task).finally(() => {
        this.inFlight.delete(job);
        this.pump();
      });
      this.inFlight.add(job);
    }
  }

  buildPrompt() {
    const prefix = this.options.promptPrefix?.trim() ?? "";
    if (!this.options.sendContextPrompt) return prefix || undefined;
    const tail = this.text.slice(-200).trim();
    return [prefix, tail].filter(Boolean).join(" ").trim() || undefined;
  }

  async runTask(task) {
    if (this.cancelled) return;
    try {
      const text = (
        await this.transcriber.transcribe({
          pcm: task.segment.pcm,
          prompt: this.buildPrompt(),
          signal: this.controller.signal,
        })
      ).trim();

      if (this.cancelled || !text) return;
      this.results[task.index] = text;
      this.logger?.info?.(`phrase ${task.index + 1} (${task.segment.durationMs} ms): ${text}`);
      this.handlers?.onPhrase?.(text);
      this.handlers?.onTranscript?.(this.text);
    } catch (error) {
      if (this.cancelled) return;
      this.logger?.error?.(`transcription of phrase ${task.index + 1} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.handlers?.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

async function drainAll(inFlight) {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function joinAll(results) {
  let text = "";
  for (const part of results) text = joinTranscript(text, part);
  return text;
}
