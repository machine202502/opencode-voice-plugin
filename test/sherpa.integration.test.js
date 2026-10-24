import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { convertFileToPcm } from "../lib/audio/capture.js";
import { int16FromBuffer } from "../lib/audio/wav.js";
import {
  getSharedSherpaServer,
  resolveOnnxModel,
  findSherpaExecutable,
  websocketServerBinary,
  resetSherpaServers,
} from "../lib/stt/sherpa.js";
import { testLogger } from "./helpers.js";

const MODEL = process.env.OPENCODE_VOICE_TEST_ONNX_MODEL || "C:/shared-data/reps/vscode-russion-dictate/.models/gigaam-v3";
const EXE =
  process.env.OPENCODE_VOICE_TEST_ONNX_EXE || "C:/shared-data/reps/vscode-russion-dictate/.models/sherpa/bin/sherpa-onnx-offline.exe";
const AUDIO = process.env.OPENCODE_VOICE_TEST_AUDIO || "C:/Users/wmachine/AppData/Local/Temp/voice-test-ru.wav";
const enabled = process.env.OPENCODE_VOICE_TEST_SHERPA === "1";

test(
  "sherpa-onnx warm server starts and transcribes a Russian WAV",
  { skip: !enabled ? "set OPENCODE_VOICE_TEST_SHERPA=1 to run the native integration test" : false },
  async () => {
    assert.ok(existsSync(MODEL), `model not found: ${MODEL}`);
    assert.ok(existsSync(EXE), `executable not found: ${EXE}`);
    assert.ok(existsSync(AUDIO), `audio not found: ${AUDIO}`);

    const model = resolveOnnxModel(MODEL, { precision: "auto" });
    assert.ok(model, "model could not be resolved");
    const executable = findSherpaExecutable({ explicit: EXE, modelFile: model.modelFile });
    assert.ok(executable, "sherpa executable could not be resolved");
    const serverBinary = websocketServerBinary(executable);
    assert.ok(existsSync(serverBinary), `websocket server not found: ${serverBinary}`);

    const pcm = int16FromBuffer(await convertFileToPcm(AUDIO));
    assert.ok(pcm.length > 16000);

    const server = getSharedSherpaServer(
      { executable: serverBinary, modelFile: model.modelFile, tokensFile: model.tokensFile, threads: 2 },
      testLogger(),
    );

    try {
      const status = await server.warmup();
      assert.equal(status.running, true);
      const text = await server.transcribe(pcm);
      assert.ok(text.length > 0, "empty transcript");
      assert.match(text.toLowerCase(), /привет|проверка|распознаван/);
    } finally {
      resetSherpaServers();
    }
  },
);
