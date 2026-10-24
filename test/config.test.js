import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../lib/jsonc.js";
import { normalizeConfig, applyEnv, mergeConfig, resolveProvider, loadConfig, saveConfig, DEFAULTS } from "../lib/config.js";
import { tempDir } from "./helpers.js";

test("parseJsonc removes comments and trailing commas but preserves strings", () => {
  const value = parseJsonc(`{
    // line comment
    "a": "http://x//y",
    "b": [1, 2, /* block */ 3,],
  }`);
  assert.deepEqual(value, { a: "http://x//y", b: [1, 2, 3] });
});

test("normalizeConfig clamps and fills defaults", () => {
  const config = normalizeConfig({
    provider: "nonsense",
    audio: { silenceMs: 1, oneShotSilenceMs: 999999, cues: { volume: 900 } },
    server: { port: 99999, concurrency: 99 },
  });
  assert.equal(config.provider, "auto");
  assert.equal(config.audio.silenceMs, 150);
  assert.equal(config.audio.oneShotSilenceMs, 60000);
  assert.equal(config.audio.cues.volume, 100);
  assert.equal(config.server.port, 65535);
  assert.equal(config.server.concurrency, 8);
});

test("env overrides win over file values", () => {
  const previous = { ...process.env };
  try {
    process.env.OPENCODE_VOICE_PROVIDER = "local-onnx";
    process.env.OPENCODE_VOICE_LANGUAGE = "ru";
    process.env.OPENCODE_VOICE_PORT = "9010";
    process.env.OPENCODE_VOICE_SERVER = "0";
    process.env.OPENCODE_VOICE_TOKEN = "secret";
    const config = applyEnv(normalizeConfig({ provider: "openai-compatible" }));
    assert.equal(config.provider, "local-onnx");
    assert.equal(config.language, "ru");
    assert.equal(config.server.port, 9010);
    assert.equal(config.server.enabled, false);
    assert.equal(config.server.token, "secret");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("resolveProvider auto picks local-onnx when the model path exists", () => {
  const directory = tempDir();
  const modelDir = join(directory, "gigaam");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "model.int8.onnx"), "fake");
  writeFileSync(join(modelDir, "tokens.txt"), "fake");
  const config = normalizeConfig({ provider: "auto", onnx: { modelPath: modelDir } });
  assert.equal(resolveProvider(config), "local-onnx");
});

test("loadConfig merges files and saveConfig writes JSON", () => {
  const directory = tempDir();
  const file = join(directory, "voice.json");
  saveConfig({ provider: "local-whisper", audio: { device: "test-mic" } }, { file });
  const previous = process.env.OPENCODE_VOICE_CONFIG;
  try {
    process.env.OPENCODE_VOICE_CONFIG = file;
    const loaded = loadConfig({ directory });
    assert.ok(loaded.files.includes(file));
    assert.equal(loaded.config.provider, "local-whisper");
    assert.equal(loaded.config.audio.device, "test-mic");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_VOICE_CONFIG;
    else process.env.OPENCODE_VOICE_CONFIG = previous;
  }
});

test("mergeConfig keeps nested defaults", () => {
  const merged = mergeConfig(DEFAULTS, { audio: { device: "mic" } });
  assert.equal(merged.audio.device, "mic");
  assert.equal(merged.audio.silenceMs, DEFAULTS.audio.silenceMs);
  assert.equal(merged.server.port, DEFAULTS.server.port);
});
