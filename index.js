// OpenCode Voice — server plugin.
//
// This file is loaded by OpenCode's server. It starts the local HTTP voice server
// used by the Chrome extension / web UI and keeps the STT engine warm. The TUI
// part lives in ./tui.js and is loaded automatically by the CLI for this package.
//
// The plugin deliberately has no npm dependencies: audio capture uses ffmpeg,
// recognition uses whisper.cpp / sherpa-onnx / OpenAI-compatible HTTP, and the
// HTTP API is implemented with node:http.

import { createLogger } from "./lib/log.js";
import { VoiceRuntime } from "./lib/runtime.js";
import { VoiceHttpServer } from "./lib/server/http.js";

let Plugin;
try {
  ({ Plugin } = await import("@opencode/plugin"));
} catch {
  // V1 runtimes do not have @opencode/plugin; the object below also exposes
  // the legacy `server()` entrypoint.
}

async function startVoiceServer({ directory, logger }) {
  const runtime = new VoiceRuntime({ directory, logger });
  runtime.configFiles = runtime.configFiles || [];
  const config = runtime.config;

  let server;
  if (config.server.enabled) {
    server = new VoiceHttpServer({ runtime, logger });
    try {
      await server.start();
    } catch (error) {
      logger.error("could not start the voice HTTP server", {
        error: error instanceof Error ? error.message : String(error),
        port: config.server.port,
      });
    }
  } else {
    logger.info("voice HTTP server disabled in config");
  }

  // Warming up loads a 300 MB ONNX model / whisper model. Do it after the server
  // is responsive, and never block OpenCode startup on it.
  let warmupTimer;
  if (config.server.warmup) {
    warmupTimer = setTimeout(() => {
      void runtime.warmup().then((result) => {
        if (result.ok) logger.info("voice engine warm", result);
        else logger.warn("voice engine warmup failed", result);
      });
    }, 2500);
    warmupTimer.unref?.();
  }

  const dispose = async () => {
    if (warmupTimer) clearTimeout(warmupTimer);
    await server?.stop().catch(() => undefined);
    runtime.dispose();
  };

  return { runtime, server, dispose };
}

function voiceCommand(ctx, runtime, logger) {
  return {
    name: "voice-send",
    description:
      "Record from the microphone, transcribe with the configured local engine, and send the text as the next prompt",
    async execute({ sessionID, delivery }) {
      if (runtime.status().recording) throw new Error("Voice is already recording");
      logger.info("voice-send command started", { sessionID });
      const session = await runtime.startRecording({ oneShot: true });
      const info = await session.done;
      if (info?.cancelled) throw new Error("Voice recording cancelled");
      if (!info?.transcript) throw new Error(info?.error?.message || "No speech was recognized");
      await ctx.session.prompt(delivery ? { sessionID, text: info.transcript, delivery } : { sessionID, text: info.transcript });
      logger.info("voice-send command sent transcript", { chars: info.transcript.length });
    },
  };
}

const definition = {
  id: "opencode.voice",
  async setup(ctx) {
    const directory = ctx.location?.directory || process.cwd();
    const logger = createLogger({ name: "voice" });
    const { runtime, dispose } = await startVoiceServer({ directory, logger });

    // V2 command fallback for clients without the TUI plugin (desktop/web UI).
    // It records and sends the transcript; the TUI plugin appends to the composer.
    try {
      if (ctx.command?.transform) {
        await ctx.command.transform((editor) => {
          editor.add(voiceCommand(ctx, runtime, logger));
        });
      }
    } catch (error) {
      logger.warn("could not register /voice-send command", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return () => {
      void dispose();
    };
  },
};

// V1 compatibility: V1 plugins export a `server()` method that returns hooks.
definition.server = async () => {
  const logger = createLogger({ name: "voice" });
  const { runtime } = await startVoiceServer({ directory: process.cwd(), logger });
  return {
    // A V1 command hook is intentionally not registered: V1 clients use the
    // TUI plugin (./tui.js), which appends text to the prompt instead of sending it.
    async dispose() {
      runtime.dispose();
    },
  };
};

export default Plugin?.define ? Plugin.define(definition) : definition;
