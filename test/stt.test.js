import test from "node:test";
import assert from "node:assert/strict";
import { buildMultipartBody, parseMultipartBody } from "../lib/stt/multipart.js";
import { parseTranscriptionResponse, transcriptionUrl } from "../lib/stt/openai.js";
import { extractSherpaText, pickModel, splitArgs, websocketServerBinary } from "../lib/stt/sherpa.js";
import { toShortLanguage, toBcp47, joinTranscript } from "../lib/stt/language.js";

test("multipart body round-trips fields and files", () => {
  const file = Buffer.from("hello-audio", "utf8");
  const { body, contentType } = buildMultipartBody(
    { model: "whisper-1", language: "ru" },
    [{ field: "audio", filename: "recording.webm", contentType: "audio/webm", data: file }],
  );
  const parsed = parseMultipartBody(body, contentType);
  assert.equal(parsed.fields.model, "whisper-1");
  assert.equal(parsed.fields.language, "ru");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, "recording.webm");
  assert.equal(parsed.files[0].data.toString("utf8"), "hello-audio");
});

test("OpenAI response parser accepts common shapes", () => {
  assert.equal(parseTranscriptionResponse('{"text":"привет"}'), "привет");
  assert.equal(parseTranscriptionResponse('[{"text":"one"},{"text":"two"}]'), "one two");
  assert.equal(parseTranscriptionResponse('"bare"'), "bare");
  assert.equal(parseTranscriptionResponse("plain text"), "plain text");
  assert.equal(transcriptionUrl("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000/v1/audio/transcriptions");
});

test("sherpa helpers parse output and choose the CTC int8 model", () => {
  assert.equal(extractSherpaText('ru.wav -- {"lang": "", "text": "привет мир", "timestamps": []}'), "привет мир");
  assert.equal(
    pickModel(["gigaam_v3_e2e_ctc.onnx", "gigaam_v3_e2e_ctc_int8.onnx", "encoder.onnx"], "auto"),
    "gigaam_v3_e2e_ctc_int8.onnx",
  );
  assert.equal(websocketServerBinary("C:\\sherpa\\sherpa-onnx-offline.exe"), "C:\\sherpa\\sherpa-onnx-offline-websocket-server.exe");
  assert.deepEqual(splitArgs('--num-threads=4 --hotwords "привет мир"'), ["--num-threads=4", "--hotwords", "привет мир"]);
});

test("language and transcript helpers", () => {
  assert.equal(toShortLanguage("ru-RU"), "ru");
  assert.equal(toShortLanguage("auto"), undefined);
  assert.equal(toBcp47("ru"), "ru-RU");
  assert.equal(toBcp47("en-US"), "en-US");
  assert.equal(joinTranscript("привет", " мир"), "привет мир");
});
