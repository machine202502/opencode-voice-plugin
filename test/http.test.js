import test from "node:test";
import assert from "node:assert/strict";
import { VoiceRuntime } from "../lib/runtime.js";
import { VoiceHttpServer, probeServer } from "../lib/server/http.js";
import { FakePcmSource, FakeTranscriber, testConfig, testLogger, toneWav } from "./helpers.js";

async function startServer(patch = {}, { transcriber, source, copy } = {}) {
  const runtime = new VoiceRuntime({ config: testConfig(patch), logger: testLogger() });
  runtime.transcriber = transcriber || new FakeTranscriber(["привет"]);
  runtime.defaultTranscriber = runtime.transcriber;
  runtime.defaultSource = source || new FakePcmSource();
  const server = new VoiceHttpServer({ runtime, logger: runtime.logger, port: 0, copy });
  await server.start({ retryPorts: 1 });
  return { runtime, server, url: server.url };
}

async function close({ server, runtime }) {
  await server.stop();
  runtime.dispose();
}

test("HTTP /health reports the provider and limits", async () => {
  const context = await startServer();
  try {
    const response = await fetch(`${context.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, "opencode-voice");
    assert.equal(body.provider, "command");
    assert.equal(body.max_upload_mb, 25);
    assert.equal(body.auth, false);
  } finally {
    await close(context);
  }
});

test("HTTP /transcribe accepts a multipart audio upload", async () => {
  const context = await startServer();
  try {
    const form = new FormData();
    form.append("audio", new Blob([toneWav(700)], { type: "audio/wav" }), "test.wav");
    const response = await fetch(`${context.url}/transcribe`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.text, "привет");
    assert.ok(body.duration_ms > 500);
  } finally {
    await close(context);
  }
});

test("HTTP /transcribe accepts a raw audio body", async () => {
  const context = await startServer();
  try {
    const response = await fetch(`${context.url}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav", "x-voice-filename": "raw.wav" },
      body: toneWav(500),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, "привет");
  } finally {
    await close(context);
  }
});

test("HTTP /hotkey records one phrase and copies it without a session", async () => {
  const source = new FakePcmSource();
  const copied = [];
  const context = await startServer({}, { source, copy: async (text) => (copied.push(text), true) });
  try {
    const pending = fetch(`${context.url}/hotkey`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    source.pushTone(400);
    source.pushSilence(500);
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.text, "привет");
    assert.equal(body.chars, 6);
    assert.deepEqual(copied, ["привет"]);

    // A queued key-repeat must not start another recording immediately.
    const again = await fetch(`${context.url}/hotkey`, { method: "POST" });
    const againBody = await again.json();
    assert.equal(againBody.ok, true);
    assert.equal(againBody.ignored, true);
  } finally {
    await close(context);
  }
});

test("HTTP /record/start and /record/stop capture through the runtime", async () => {
  const source = new FakePcmSource();
  const context = await startServer({}, { source });
  try {
    const start = await fetch(`${context.url}/record/start`, { method: "POST" });
    assert.equal(start.status, 200);
    source.pushTone(400);
    source.pushSilence(350);
    const stop = await fetch(`${context.url}/record/stop`, { method: "POST" });
    assert.equal(stop.status, 200);
    const body = await stop.json();
    assert.equal(body.ok, true);
    assert.equal(body.text, "привет");
  } finally {
    await close(context);
  }
});

test("HTTP auth protects everything except /health", async () => {
  const context = await startServer({ server: { token: "secret", port: 0, warmup: false } });
  try {
    assert.equal((await fetch(`${context.url}/health`)).status, 200);
    assert.equal((await fetch(`${context.url}/config`)).status, 401);
    const allowed = await fetch(`${context.url}/config`, { headers: { "X-Voice-Token": "secret" } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.config.server.auth, true);
  } finally {
    await close(context);
  }
});

test("HTTP CORS allows extension origins and preflight", async () => {
  const context = await startServer();
  try {
    const origin = "chrome-extension://abcdefghijklmnop";
    const health = await fetch(`${context.url}/health`, { headers: { Origin: origin } });
    assert.equal(health.headers.get("access-control-allow-origin"), origin);
    const preflight = await fetch(`${context.url}/transcribe`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /X-Voice-Token/i);
  } finally {
    await close(context);
  }
});

test("probeServer recognises a running voice server", async () => {
  const context = await startServer();
  try {
    const health = await probeServer(context.url);
    assert.ok(health);
    assert.equal(health.name, "opencode-voice");
  } finally {
    await close(context);
  }
});
