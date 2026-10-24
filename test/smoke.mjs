import { createLogger } from "../lib/log.js";
import { normalizeConfig } from "../lib/config.js";
import { VoiceRuntime } from "../lib/runtime.js";
import { tempDir } from "./helpers.js";
import { join } from "node:path";

console.log("smoke: start");

const config = normalizeConfig({
  provider: "local-onnx",
  language: "ru",
  onnx: {
    modelPath: "C:/shared-data/reps/vscode-russion-dictate/.models/gigaam-v3",
    executablePath: "C:/shared-data/reps/vscode-russion-dictate/.models/sherpa/bin/sherpa-onnx-offline.exe",
    mode: "auto",
    precision: "auto",
    threads: 2,
  },
  audio: {
    ffmpegPath: "ffmpeg",
    cues: { start: false, end: false, volume: 0 },
    silenceMs: 600,
    minSegmentMs: 400,
    maxSegmentMs: 15000,
    noiseThreshold: 0,
    autoStopSilenceMs: 0,
    oneShotSilenceMs: 1400,
  },
  server: { port: 0, warmup: false, concurrency: 1 },
});

const logger = createLogger({ name: "smoke", file: join(tempDir(), "smoke.log") });
const runtime = new VoiceRuntime({ config, logger });

try {
  console.log("smoke: transcribing");
  const result = await runtime.transcribeAudioFile(process.env.OPENCODE_VOICE_TEST_AUDIO || "C:/Users/wmachine/AppData/Local/Temp/voice-test-ru.wav");
  console.log("smoke: result", JSON.stringify(result, null, 2));
} catch (error) {
  console.error("smoke: error", error);
  process.exitCode = 1;
} finally {
  runtime.dispose();
  console.log("smoke: disposed");
}
