import test from "node:test";
import assert from "node:assert/strict";
import { commandList } from "../index.js";
import { DEFAULTS, normalizeConfig } from "../lib/config.js";

function fakeContext() {
  const events = [];
  return {
    events,
    session: {
      prompt: async (props) => events.push(["prompt", props]),
      synthetic: async (props) => events.push(["synthetic", props]),
    },
  };
}

function fakeRuntime(transcript = "привет мир") {
  const config = normalizeConfig({
    ...DEFAULTS,
    provider: "local-onnx",
    language: "ru",
    server: { ...DEFAULTS.server, port: 8765 },
  });
  return {
    config,
    configFiles: ["C:/config/voice.json"],
    provider: "local-onnx",
    doctor: async () => "# diagnostics\n- ffmpeg: ok",
    warmup: async () => ({ ok: true, label: "fake engine" }),
    reload: () => undefined,
    status: () => ({ recording: false }),
    startRecording: async () => ({
      done: Promise.resolve({ transcript, reason: "one-shot" }),
    }),
  };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("server commands expose voice, voice-send and maintenance commands", () => {
  const commands = commandList(fakeContext(), fakeRuntime(), logger);
  assert.deepEqual(
    commands.map((command) => command.name),
    ["voice-send", "voice", "voice-settings", "voice-doctor", "voice-warmup", "voice-reload"],
  );
  for (const command of commands) {
    assert.equal(typeof command.execute, "function", `${command.name} has no execute`);
    assert.equal(command.id, `opencode.voice.${command.name}`);
  }
});

test("/voice copies silently and does not trigger the agent", async () => {
  const ctx = fakeContext();
  const copied = [];
  const commands = commandList(ctx, fakeRuntime("диктовка"), logger, {
    copy: async (text) => {
      copied.push(text);
      return true;
    },
  });

  await commands.find((command) => command.name === "voice").execute({ sessionID: "ses_0" });

  assert.deepEqual(copied, ["диктовка"]);
  assert.deepEqual(ctx.events, [], "no synthetic message on success");
});

test("/voice falls back to a session message when copying fails", async () => {
  const ctx = fakeContext();
  const commands = commandList(ctx, fakeRuntime("диктовка"), logger, { copy: async () => false });

  await commands.find((command) => command.name === "voice").execute({ sessionID: "ses_0" });

  assert.equal(ctx.events.length, 1);
  assert.match(ctx.events[0][1].text, /Не удалось скопировать/);
  assert.match(ctx.events[0][1].text, /диктовка/);
});

test("/voice-send records and sends the transcript", async () => {
  const ctx = fakeContext();
  const commands = commandList(ctx, fakeRuntime("тест"), logger);
  const send = commands.find((command) => command.name === "voice-send");
  await send.execute({ sessionID: "ses_1" });
  assert.deepEqual(ctx.events, [["prompt", { sessionID: "ses_1", text: "тест" }]]);
});

test("/voice-settings and /voice-doctor report through synthetic messages", async () => {
  const ctx = fakeContext();
  const commands = commandList(ctx, fakeRuntime(), logger);

  await commands.find((command) => command.name === "voice-settings").execute({ sessionID: "ses_2" });
  await commands.find((command) => command.name === "voice-doctor").execute({ sessionID: "ses_2" });

  assert.equal(ctx.events.length, 2);
  const settings = ctx.events[0][1].text;
  assert.match(settings, /local-onnx/);
  assert.match(settings, /voice\.json/);
  assert.match(settings, /127\.0\.0\.1:8765/);
  assert.equal(ctx.events[1][1].text, "# diagnostics\n- ffmpeg: ok");
});

test("/voice-warmup and /voice-reload report their result", async () => {
  const ctx = fakeContext();
  const commands = commandList(ctx, fakeRuntime(), logger);

  await commands.find((command) => command.name === "voice-warmup").execute({ sessionID: "ses_3" });
  await commands.find((command) => command.name === "voice-reload").execute({ sessionID: "ses_3" });

  assert.match(ctx.events[0][1].text, /fake engine/);
  assert.match(ctx.events[1][1].text, /Конфигурация перечитана/);
  assert.match(ctx.events[1][1].text, /local-onnx/);
});
