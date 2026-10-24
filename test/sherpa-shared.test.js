import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// Emulate OpenCode evaluating the plugin module twice in one process.
const first = await import("../lib/stt/sherpa.js?copy=1");
const second = await import("../lib/stt/sherpa.js?copy=2");

test("warm sherpa servers are shared between copies of the module", () => {
  const options = {
    executable: join("C:", "sherpa", "sherpa-onnx-offline-websocket-server.exe"),
    modelFile: join("C:", "models", "model.onnx"),
    tokensFile: join("C:", "models", "tokens.txt"),
    threads: 2,
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const a = first.getSharedSherpaServer(options, logger);
  const b = second.getSharedSherpaServer(options, logger);
  assert.equal(a, b, "both copies must reuse the same warm server");
  assert.equal(second.sherpaServersStatus().length, 1);
});
