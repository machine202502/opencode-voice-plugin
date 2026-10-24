import { FfmpegSource } from "../lib/audio/capture.js";
import { int16FromBuffer, rmsOf } from "../lib/audio/wav.js";
import { createLogger } from "../lib/log.js";
import { tempDir } from "./helpers.js";
import { join } from "node:path";

const logger = createLogger({ name: "mic-smoke", file: join(tempDir(), "mic.log") });
const source = new FfmpegSource({ ffmpegPath: "ffmpeg", format: "auto", device: "" }, logger);
const chunks = [];
source.onData = (chunk) => chunks.push(chunk);
source.onError = (error) => console.error("capture error", error.message);
source.onExit = (code, stderr) => console.log("capture exit", code, stderr.slice(0, 400));

console.log("mic: start");
await source.start();
await new Promise((resolve) => setTimeout(resolve, 2500));
await source.stop();
const pcm = int16FromBuffer(Buffer.concat(chunks));
console.log("mic: samples", pcm.length, "rms", rmsOf(pcm).toFixed(5));
