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
import { copyToClipboard } from "./lib/clipboard.js";

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

async function recordTranscript(runtime, logger, command) {
  if (runtime.status().recording) throw new Error("Voice is already recording");
  logger.info(`${command} command started`);
  const session = await runtime.startRecording({ oneShot: true });
  const info = await session.done;
  if (info?.cancelled) throw new Error("Voice recording cancelled");
  if (info?.error) throw new Error(info.error.message || String(info.error));
  const text = String(info?.transcript || "").trim();
  if (!text) throw new Error("No speech was recognized");
  return text;
}

async function sendTranscript(ctx, sessionID, delivery, text) {
  if (delivery) await ctx.session.prompt({ sessionID, text, delivery });
  else await ctx.session.prompt({ sessionID, text });
}

/** Best-effort note in the session; commands must still work when synthetic messages are unavailable. */
async function note(ctx, sessionID, text) {
  if (typeof ctx.session?.synthetic !== "function") return false;
  await ctx.session.synthetic({ sessionID, text });
  return true;
}

export function commandList(ctx, runtime, logger, dependencies = {}) {
  const plugin = "opencode.voice";
  const copy = dependencies.copy ?? copyToClipboard;

  const dictate = (mode) => ({
    async execute({ sessionID, delivery }) {
      const text = await recordTranscript(runtime, logger, mode === "send" ? "voice-send" : "voice");
      logger.info("voice transcript ready", { chars: text.length, mode });

      if (mode === "send") {
        await sendTranscript(ctx, sessionID, delivery, text);
        return;
      }

      const copied = await copy(text).catch(() => false);
      if (copied) {
        // `/voice` is dictation into the prompt, not a chat message. Posting a
        // synthetic note here would make the client treat it as a user turn and
        // trigger the agent, so success is silent: the beep + clipboard are the
        // feedback. The text is only shown if it could not be copied, to avoid
        // losing it.
        logger.info("voice transcript copied to clipboard", { chars: text.length });
        return;
      }

      logger.warn("could not copy voice transcript to the clipboard", { chars: text.length });
      await note(ctx, sessionID, `⚠️ Не удалось скопировать текст в буфер обмена. Распознано:\n\n${text}`).catch(
        () => false,
      );
    },
  });

  return [
    {
      ...dictate("send"),
      name: "voice-send",
      description: "Record from the microphone, transcribe locally, and send the text as the next prompt",
    },
    {
      ...dictate("copy"),
      name: "voice",
      description: "Record from the microphone, transcribe locally, and copy the text to the clipboard",
    },
    {
      name: "voice-settings",
      description: "Show the OpenCode Voice provider, language, microphone, hotkey and config files",
      async execute({ sessionID }) {
        const config = runtime.config;
        const files = runtime.configFiles?.length ? runtime.configFiles.join("\n") : "(defaults, no voice.json)";
        await note(
          ctx,
          sessionID,
          [
            "🎤 OpenCode Voice",
            `Провайдер: ${config.provider} → ${runtime.provider}`,
            `Язык: ${config.language}`,
            `Микрофон: ${config.audio.device || "автоматически (первый вход)"}`,
            `Клавиша: ${config.hotkey}`,
            `HTTP-сервер: http://${config.server.host}:${config.server.port}`,
            "",
            "Конфигурация:",
            files,
            "",
            "Изменения применяются через /voice-reload или POST /reload.",
          ].join("\n"),
        );
      },
    },
    {
      name: "voice-doctor",
      description: "Show OpenCode Voice diagnostics: ffmpeg, microphones, model, engine and server",
      async execute({ sessionID }) {
        const report = await runtime.doctor();
        const shown = await note(ctx, sessionID, report);
        if (!shown) logger.info("voice doctor report", { report });
      },
    },
    {
      name: "voice-warmup",
      description: "Load the configured STT engine now instead of waiting for the first recording",
      async execute({ sessionID }) {
        const result = await runtime.warmup();
        await note(
          ctx,
          sessionID,
          result.ok
            ? `🔥 Движок прогрет: ${result.label || runtime.providerLabel}`
            : `⚠️ Не удалось прогреть движок: ${result.error || "unknown error"}`,
        );
      },
    },
    {
      name: "voice-reload",
      description: "Re-read voice.json, restart the STT engine and apply the new settings",
      async execute({ sessionID }) {
        runtime.reload();
        const files = runtime.configFiles?.length ? runtime.configFiles.join("\n") : "(defaults, no voice.json)";
        await note(
          ctx,
          sessionID,
          [
            "🔄 Конфигурация перечитана",
            `Провайдер: ${runtime.config.provider} → ${runtime.provider}`,
            `Язык: ${runtime.config.language}`,
            "Файлы:",
            files,
            "",
            "Движок запустится при следующей записи или через /voice-warmup.",
          ].join("\n"),
        );
      },
    },
  ].map((command) => ({ ...command, id: `${plugin}.${command.name}` }));
}

/**
 * Slash commands shown in the desktop/web client. Maintenance commands stay
 * implemented in commandList() for the terminal TUI and the HTTP API; add a
 * name here to expose it in desktop again.
 */
export const DESKTOP_COMMANDS = ["voice", "voice-send"];

export function desktopCommands(ctx, runtime, logger, dependencies) {
  return commandList(ctx, runtime, logger, dependencies).filter((command) => DESKTOP_COMMANDS.includes(command.name));
}

const definition = {
  id: "opencode.voice",
  async setup(ctx) {
    const directory = ctx.location?.directory || process.cwd();
    const logger = createLogger({ name: "voice" });
    const { runtime, dispose } = await startVoiceServer({ directory, logger });

    // V2 commands for clients without the TUI plugin (desktop/web UI).
    // Only the two dictation commands are exposed there; maintenance commands
    // remain available in the terminal TUI and over HTTP.
    try {
      if (ctx.command?.transform) {
        await ctx.command.transform((editor) => {
          for (const command of desktopCommands(ctx, runtime, logger)) editor.add(command);
        });
      }
    } catch (error) {
      logger.warn("could not register desktop voice commands", {
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
