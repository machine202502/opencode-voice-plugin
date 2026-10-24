import test from "node:test";
import assert from "node:assert/strict";
import { RecognitionPipeline } from "../lib/pipeline/recognition.js";
import { VoiceSession } from "../lib/pipeline/session.js";
import { FakePcmSource, FakeTranscriber, testConfig, testLogger } from "./helpers.js";

test("RecognitionPipeline transcribes phrases in parallel and keeps order", async () => {
  const source = new FakePcmSource();
  const transcriber = new FakeTranscriber(["one", "two"]);
  const pipeline = new RecognitionPipeline(
    source,
    transcriber,
    { segmenter: { silenceMs: 150, minSegmentMs: 100, maxSegmentMs: 5000 }, sendContextPrompt: false },
    testLogger(),
  );
  await pipeline.start({ onError: (error) => assert.fail(error.message) });
  source.pushTone(350);
  source.pushSilence(300);
  source.pushTone(350);
  source.pushSilence(300);
  const text = await pipeline.stop();
  assert.equal(transcriber.calls, 2);
  assert.equal(text, "one two");
});

test("RecognitionPipeline cancel aborts without text", async () => {
  const source = new FakePcmSource();
  const transcriber = new FakeTranscriber(["should not happen"]);
  const pipeline = new RecognitionPipeline(source, transcriber, { segmenter: { silenceMs: 100 } }, testLogger());
  await pipeline.start({ onError: () => undefined });
  source.pushTone(200);
  await pipeline.cancel();
  assert.equal(pipeline.text, "");
});

test("VoiceSession one-shot stops after silence and returns the transcript", async () => {
  const source = new FakePcmSource();
  const transcriber = new FakeTranscriber(["привет"]);
  const config = testConfig({
    audio: { cues: { start: false, end: false, volume: 0 }, silenceMs: 150, minSegmentMs: 80, oneShotSilenceMs: 200 },
  });
  const session = new VoiceSession(config, {}, testLogger(), { oneShot: true, source, transcriber });
  await session.start();
  assert.equal(session.state, "listening");
  source.pushTone(400);
  source.pushSilence(500);
  const info = await Promise.race([
    session.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("session did not finish")), 4000)),
  ]);
  assert.equal(info.transcript, "привет");
  assert.equal(info.reason, "one-shot");
  assert.equal(session.state, "idle");
  assert.equal(transcriber.calls, 1);
});

test("VoiceSession accepts a per-session one-shot silence override", async () => {
  const source = new FakePcmSource();
  const transcriber = new FakeTranscriber(["ок"]);
  const config = testConfig({
    audio: { cues: { start: false, end: false, volume: 0 }, oneShotSilenceMs: 5000 },
  });
  const session = new VoiceSession(config, {}, testLogger(), {
    oneShot: true,
    oneShotSilenceMs: 200,
    source,
    transcriber,
  });

  await session.start();
  source.pushTone(400);
  source.pushSilence(500);
  const info = await Promise.race([
    session.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("override was ignored")), 3000)),
  ]);
  assert.equal(info.transcript, "ок");
  assert.equal(info.reason, "one-shot");
});

test("VoiceSession cancel clears the transcript", async () => {
  const source = new FakePcmSource();
  const transcriber = new FakeTranscriber(["nope"]);
  const config = testConfig({ audio: { cues: { start: false, end: false, volume: 0 } } });
  const session = new VoiceSession(config, {}, testLogger(), { oneShot: true, source, transcriber });
  await session.start();
  source.pushTone(200);
  await session.cancel();
  assert.equal(session.transcript, "");
  assert.equal(session.state, "idle");
});
