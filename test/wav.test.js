import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav, int16FromBuffer, makeToneWav, rmsOf, PCM_SAMPLE_RATE } from "../lib/audio/wav.js";
import { Segmenter } from "../lib/audio/segmenter.js";

function tone(ms, { frequency = 220, amplitude = 0.35 } = {}) {
  const count = Math.round((PCM_SAMPLE_RATE * ms) / 1000);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / PCM_SAMPLE_RATE) * amplitude * 32767);
  }
  return pcm;
}

function silence(ms) {
  return new Int16Array(Math.round((PCM_SAMPLE_RATE * ms) / 1000));
}

test("encodeWav writes a valid RIFF header and round-trips PCM", () => {
  const pcm = tone(100);
  const wav = encodeWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), PCM_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), pcm.length * 2);
  const decoded = int16FromBuffer(wav.subarray(44));
  assert.equal(decoded.length, pcm.length);
  assert.equal(decoded[100], pcm[100]);
});

test("rmsOf returns normalized energy", () => {
  assert.equal(rmsOf(new Int16Array(100)), 0);
  const level = rmsOf(tone(100, { amplitude: 0.5 }));
  assert.ok(level > 0.2 && level < 0.5, `unexpected RMS ${level}`);
});

test("makeToneWav produces the requested duration", () => {
  const wav = makeToneWav({ frequency: 880, durationMs: 100 });
  const dataBytes = wav.readUInt32LE(40);
  assert.ok(Math.abs(dataBytes / 2 / PCM_SAMPLE_RATE - 0.1) < 0.01);
});

test("Segmenter splits phrases at pauses", () => {
  const segmenter = new Segmenter({ silenceMs: 200, minSegmentMs: 150, maxSegmentMs: 5000 });
  const segments = [];
  segments.push(...segmenter.push(tone(500)));
  segments.push(...segmenter.push(silence(400)));
  segments.push(...segmenter.push(tone(500)));
  segments.push(...segmenter.flush());
  assert.equal(segments.length, 2, `expected 2 phrases, got ${segments.length}`);
  assert.ok(segments[0].durationMs >= 300);
  assert.ok(segments[1].durationMs >= 300);
});

test("Segmenter ignores silence-only input", () => {
  const segmenter = new Segmenter({ silenceMs: 150, minSegmentMs: 100 });
  const segments = segmenter.push(silence(1000)).concat(segmenter.flush());
  assert.equal(segments.length, 0);
});
