import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolveLanguage, toBcp47, toShortLanguage } from "./language.js";
import { transcribeWithCommand } from "./command.js";
import { buildLocalWhisperCommand, findWhisperExecutable, resolveModelFile } from "./localWhisper.js";
import {
  buildSherpaCommand,
  extractSherpaText,
  findSherpaExecutable,
  getSharedSherpaServer,
  resolveOnnxModel,
  websocketServerBinary,
} from "./sherpa.js";
import { transcribePcmOpenAiCompatible } from "./openai.js";
import { SaluteTranscriber } from "./salute.js";
import { providerLabel, resolveProvider } from "../config.js";

/**
 * Builds the recognizer described by voice.json. `provider: "auto"` resolves to
 * local-onnx -> local-whisper -> command -> OpenAI-compatible.
 */
export function createTranscriber(config, logger, options = {}) {
  const provider = resolveProvider(config);
  const language = resolveLanguage(config.language);

  switch (provider) {
    case "local-onnx":
      return createOnnxTranscriber(config, logger);
    case "local-whisper":
      return createWhisperTranscriber(config);
    case "salute":
      return createSaluteTranscriber(config, language);
    case "command":
      return createCommandTranscriber(config);
    default:
      return createOpenAiTranscriber(config, language);
  }
}

function createOnnxTranscriber(config, logger) {
  const model = resolveOnnxModel(config.onnx.modelPath, { precision: config.onnx.precision });
  if (!model) {
    throw new Error(
      `No sherpa-onnx model found at "${config.onnx.modelPath || "(not set)"}". ` +
        `Set onnx.modelPath to a folder with model.onnx + tokens.txt (e.g. GigaAM-v3) or to the .onnx file.`,
    );
  }

  const executable = findSherpaExecutable({
    explicit: config.onnx.executablePath,
    modelFile: model.modelFile,
  });
  if (!executable) {
    throw new Error(
      "sherpa-onnx was not found. Set onnx.executablePath to sherpa-onnx-offline.exe " +
        "(or keep it next to the model / on PATH).",
    );
  }

  const serverBinary = websocketServerBinary(executable);
  const wantsServer = config.onnx.mode !== "cli" && serverBinary !== executable;
  const serverAvailable = wantsServer && existsSync(serverBinary);

  const serverOptions = {
    executable: serverBinary,
    modelFile: model.modelFile,
    tokensFile: model.tokensFile,
    threads: config.onnx.threads,
    extraArgs: config.onnx.extraArgs,
  };
  const server = serverAvailable ? getSharedSherpaServer(serverOptions, logger) : undefined;
  const command = buildSherpaCommand({
    executable,
    modelFile: model.modelFile,
    tokensFile: model.tokensFile,
    extraArgs: config.onnx.extraArgs,
  });

  let useCli = !server;
  const label = server
    ? `sherpa-onnx server (${basename(model.modelFile)})`
    : `sherpa-onnx CLI (${basename(model.modelFile)})`;

  return {
    provider: "local-onnx",
    label,
    model: model.modelFile,
    mode: server ? "server" : "cli",
    async transcribe({ pcm, signal }) {
      if (!useCli && server) {
        try {
          return await server.transcribe(pcm, signal);
        } catch (error) {
          if (config.onnx.mode === "server") throw error;
          useCli = true;
          logger?.warn?.(`sherpa-onnx server failed, falling back to CLI: ${error instanceof Error ? error.message : error}`);
        }
      }
      return transcribeWithCommand(
        pcm,
        { command, timeoutMs: config.openai.requestTimeoutMs, parse: extractSherpaText },
        signal,
      );
    },
    async warmup() {
      if (!useCli && server) return server.warmup();
      return { running: false, mode: "cli" };
    },
    dispose() {
      // The shared server stays warm on purpose; /voice heal resets it.
    },
    info() {
      return {
        provider: "local-onnx",
        label,
        model: model.modelFile,
        mode: useCli ? "cli" : "server",
        language: resolveLanguage(config.language),
      };
    },
  };
}

function createWhisperTranscriber(config) {
  const modelFile = resolveModelFile(config.local.modelPath);
  if (!modelFile) {
    throw new Error(
      `No whisper.cpp model found at "${config.local.modelPath || "(not set)"}". ` +
        `Set local.modelPath to a ggml-*.bin file or a folder with models.`,
    );
  }
  const executable = findWhisperExecutable({ explicit: config.local.executablePath, modelFile });
  if (!executable) {
    throw new Error(
      'whisper-cli was not found. Set local.executablePath to whisper-cli.exe or keep it next to the model / on PATH.',
    );
  }

  const command = buildLocalWhisperCommand({
    executable,
    modelFile,
    language: toShortLanguage(config.language),
    extraArgs: config.local.extraArgs,
  });

  return {
    provider: "local-whisper",
    label: `whisper.cpp (${basename(modelFile)})`,
    model: modelFile,
    async transcribe({ pcm, signal }) {
      return transcribeWithCommand(pcm, { command, timeoutMs: config.openai.requestTimeoutMs }, signal);
    },
    async warmup() {
      return { running: false, mode: "cli" };
    },
    dispose() {},
    info() {
      return { provider: "local-whisper", label: `whisper.cpp (${basename(modelFile)})`, model: modelFile, mode: "cli" };
    },
  };
}

function createSaluteTranscriber(config, language) {
  const client = new SaluteTranscriber({
    tokenUrl: config.salute.tokenUrl,
    recognizeUrl: config.salute.recognizeUrl,
    scope: config.salute.scope,
    clientId: config.salute.clientId,
    clientSecret: config.salute.clientSecret,
    authorizationKey: config.salute.authorizationKey,
    language: toBcp47(language),
    insecureTLS: config.salute.insecureTLS,
    timeoutMs: config.openai.requestTimeoutMs,
  });

  return {
    provider: "salute",
    label: "SaluteSpeech (Sber)",
    async transcribe({ pcm, signal }) {
      return client.transcribePcm(pcm, signal);
    },
    async warmup() {
      return { running: true, mode: "cloud" };
    },
    dispose() {},
    info() {
      return { provider: "salute", label: "SaluteSpeech", mode: "cloud" };
    },
  };
}

function createCommandTranscriber(config) {
  return {
    provider: "command",
    label: "command",
    async transcribe({ pcm, signal }) {
      return transcribeWithCommand(
        pcm,
        { command: config.command.transcribe, timeoutMs: config.openai.requestTimeoutMs },
        signal,
      );
    },
    async warmup() {
      return { running: false, mode: "cli" };
    },
    dispose() {},
    info() {
      return { provider: "command", label: "command", mode: "cli" };
    },
  };
}

function createOpenAiTranscriber(config, language) {
  return {
    provider: "openai-compatible",
    label: `OpenAI-compatible ${config.openai.baseUrl} (${config.openai.model})`,
    model: config.openai.model,
    async transcribe({ pcm, prompt, signal }) {
      return transcribePcmOpenAiCompatible(
        pcm,
        {
          baseUrl: config.openai.baseUrl,
          model: config.openai.model,
          apiKey: config.openai.apiKey,
          language: toShortLanguage(language),
          prompt: prompt ?? config.openai.prompt,
          extraBody: config.openai.extraBody,
          timeoutMs: config.openai.requestTimeoutMs,
        },
        signal,
      );
    },
    async warmup() {
      return { running: true, mode: "http" };
    },
    dispose() {},
    info() {
      return {
        provider: "openai-compatible",
        label: `OpenAI-compatible ${config.openai.baseUrl}`,
        model: config.openai.model,
        mode: "http",
      };
    },
  };
}

export { providerLabel };
