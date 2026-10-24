import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, DEFAULTS, mergeConfig } from "../lib/config.js";
import { encodeWav } from "../lib/audio/wav.js";
import { createLogger } from "../lib/log.js";

export function tempDir(prefix = "opencode-voice-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testLogger() {
  return createLogger({ name: "test", file: join(tempDir(), "test.log") });
}

export function testConfig(patch = {}) {
  return normalizeConfig(
    mergeConfig(
      {
        ...DEFAULTS,
        provider: "command",
        command: { capture: "", transcribe: "echo test" },
        audio: { ...DEFAULTS.audio, silenceMs: 200, minSegmentMs: 80, oneShotSilenceMs: 200, autoStopSilenceMs: 0 },
        server: { ...DEFAULTS.server, port: 0, warmup: false },
      },
      patch,
    ),
  );
}

export class FakePcmSource {
  constructor() {
    this.onData = () => undefined;
    this.onError = () => undefined;
    this.onExit = () => undefined;
    this.started = false;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  pushPcm(pcm) {
    const buffer = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i], i * 2);
    this.onData(buffer);
  }

  pushSilence(ms, sampleRate = 16000) {
    this.pushPcm(new Int16Array(Math.round((sampleRate * ms) / 1000)));
  }

  pushTone(ms, { frequency = 220, amplitude = 0.35, sampleRate = 16000 } = {}) {
    const count = Math.round((sampleRate * ms) / 1000);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      pcm[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767);
    }
    this.pushPcm(pcm);
  }
}

export class FakeTranscriber {
  constructor(texts = ["привет"]) {
    this.texts = [...texts];
    this.calls = 0;
    this.provider = "fake";
    this.label = "fake transcriber";
  }

  async transcribe() {
    this.calls += 1;
    const text = this.texts.length > 1 ? this.texts.shift() : this.texts[0] ?? "";
    return `${text}`;
  }

  async warmup() {
    return { running: true, mode: "fake" };
  }

  dispose() {}

  info() {
    return { provider: this.provider, label: this.label, mode: "fake" };
  }
}

export function toneWav(ms = 600, frequency = 220, amplitude = 0.3) {
  const count = Math.round((16000 * ms) / 1000);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / 16000) * amplitude * 32767);
  }
  return encodeWav(pcm);
}
