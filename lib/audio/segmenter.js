import { concatInt16, PCM_SAMPLE_RATE, rmsOf } from "./wav.js";

/**
 * Splits a continuous PCM stream into phrases at natural pauses so each phrase
 * can go to the recognizer while the user keeps talking.
 *
 * Ported from the VS Code dictation extension (same tuning and behavior):
 * adaptive noise floor, 200 ms lead-in/trailing padding, 40 ms onset.
 */
export class Segmenter {
  constructor(options = {}) {
    this.opts = {
      sampleRate: PCM_SAMPLE_RATE,
      frameMs: 20,
      silenceMs: 600,
      minSegmentMs: 400,
      maxSegmentMs: 15000,
      leadInMs: 200,
      trailingMs: 200,
      noiseThreshold: 0,
      noiseMultiplier: 3,
      minSpeechMs: 120,
      ...stripUndefined(options),
    };
    this.frameSamples = Math.max(1, Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000));
    this.remainder = new Int16Array(0);
    this.prebuffer = [];
    this.frames = [];
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silenceRun = 0;
    this.voicedFrames = 0;
    this.peak = 0;
    this.noiseFloor = 0.0015;
  }

  get threshold() {
    if (this.opts.noiseThreshold > 0) return this.opts.noiseThreshold;
    return Math.max(0.004, this.noiseFloor * this.opts.noiseMultiplier);
  }

  push(chunk) {
    if (chunk.length === 0) return [];

    const data = this.remainder.length > 0 ? concatInt16([this.remainder, chunk]) : chunk;
    const frameCount = Math.floor(data.length / this.frameSamples);
    const segments = [];

    for (let i = 0; i < frameCount; i++) {
      const frame = data.subarray(i * this.frameSamples, (i + 1) * this.frameSamples);
      const segment = this.consumeFrame(frame);
      if (segment) segments.push(segment);
    }

    this.remainder = data.slice(frameCount * this.frameSamples);
    return segments;
  }

  /** Closes an open phrase, e.g. when the user stops dictating. */
  flush() {
    if (this.remainder.length > 0) {
      if (this.inSpeech) this.frames.push(this.remainder);
      else this.pushPrebuffer(this.remainder);
      this.remainder = new Int16Array(0);
    }

    const segments = [];
    if (this.inSpeech) {
      const segment = this.endSegment(false, true);
      if (segment) segments.push(segment);
    }
    this.reset();
    return segments;
  }

  reset() {
    this.remainder = new Int16Array(0);
    this.prebuffer = [];
    this.frames = [];
    this.inSpeech = false;
    this.voicedRun = 0;
    this.silenceRun = 0;
    this.voicedFrames = 0;
    this.peak = 0;
  }

  consumeFrame(frame) {
    const level = rmsOf(frame);
    const voiced = level >= this.threshold;

    if (!this.inSpeech) {
      this.pushPrebuffer(frame);
      if (voiced) {
        this.voicedRun++;
        if (this.voicedRun >= 2) this.beginSpeech();
      } else {
        this.voicedRun = 0;
        this.adaptNoise(level);
      }
      return undefined;
    }

    this.frames.push(frame);
    this.peak = Math.max(this.peak, level);

    if (voiced) {
      this.voicedFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
      this.adaptNoise(level);
    }

    if (this.silenceRun * this.opts.frameMs >= this.opts.silenceMs) return this.endSegment(false);
    if (this.frames.length * this.opts.frameMs >= this.opts.maxSegmentMs) return this.endSegment(true);
    return undefined;
  }

  beginSpeech() {
    this.inSpeech = true;
    this.frames = this.prebuffer.slice();
    this.prebuffer = [];
    this.voicedFrames = 2;
    this.silenceRun = 0;
    this.peak = 0;
  }

  endSegment(force, final = false) {
    let frames = this.frames;

    if (!force) {
      const trailingFrames = Math.max(0, Math.round(this.opts.trailingMs / this.opts.frameMs));
      const drop = Math.max(0, this.silenceRun - trailingFrames);
      if (drop > 0) frames = frames.slice(0, Math.max(0, frames.length - drop));
    }

    const durationMs = Math.round((frames.length * this.frameSamples * 1000) / this.opts.sampleRate);
    const voicedMs = this.voicedFrames * this.opts.frameMs;
    const peak = this.peak;

    this.inSpeech = false;
    this.frames = [];
    this.voicedFrames = 0;
    this.silenceRun = 0;
    this.voicedRun = 0;
    this.peak = 0;
    this.prebuffer = [];

    if (final ? frames.length === 0 : durationMs < this.opts.minSegmentMs || voicedMs < this.opts.minSpeechMs) {
      if (peak < this.threshold * 2) this.adaptNoise(peak, 0.3);
      return undefined;
    }

    return { pcm: concatInt16(frames), durationMs, peakRms: peak };
  }

  pushPrebuffer(frame) {
    this.prebuffer.push(frame);
    const maxFrames = Math.max(1, Math.round(this.opts.leadInMs / this.opts.frameMs));
    if (this.prebuffer.length > maxFrames) this.prebuffer.shift();
  }

  adaptNoise(level, rate = 0.05) {
    if (level >= this.threshold) return;
    this.noiseFloor = Math.max(0.0002, this.noiseFloor * (1 - rate) + level * rate);
  }
}

function stripUndefined(options) {
  const result = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
