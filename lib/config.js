import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc } from "./jsonc.js";
import {
  configCandidates,
  defaultConfigPath,
  expandHome,
  firstExistingConfigPath,
} from "./paths.js";

export const PLUGIN_ID = "opencode.voice";
export const PLUGIN_VERSION = "0.1.0";

export const PROVIDERS = [
  "auto",
  "local-onnx",
  "local-whisper",
  "openai-compatible",
  "salute",
  "command",
];

export const DEFAULTS = {
  /**
   * `auto`: local-onnx when a model path is configured, then local-whisper,
   * then the OpenAI-compatible endpoint.
   */
  provider: "auto",
  /** `auto` lets the model detect the language. */
  language: "auto",
  hotkey: "<leader>v",
  /** OS-wide hotkey for desktop/web (Windows), e.g. `ctrl+alt+d`. Empty disables it. */
  globalHotkey: "",
  /** After a global-hotkey recording, paste into the still-focused window (Ctrl+V). */
  globalHotkeyPaste: true,
  /** Insert a trailing space and optionally submit after the transcript. */
  insert: {
    autoSubmit: false,
    trailingSpace: true,
  },
  audio: {
    /** `ffmpeg`, or an absolute path. `ffmpeg-static` is used when installed. */
    ffmpegPath: "ffmpeg",
    /** auto | dshow | avfoundation | pulse | alsa */
    inputFormat: "auto",
    /** Friendly name, index, `@device_...` or ffmpeg id. Empty = first input. */
    device: "",
    cues: {
      start: true,
      end: true,
      volume: 15,
    },
    /** Pause that closes a phrase (phrase goes to the model immediately). */
    silenceMs: 600,
    /** Clips shorter than this are treated as noise. */
    minSegmentMs: 400,
    /** Hard cut for speech that never pauses. */
    maxSegmentMs: 15000,
    /** 0 = adaptive noise floor; 0.01 ~= -40 dBFS. */
    noiseThreshold: 0,
    /** Safety stop after N ms without speech. 0 disables it. */
    autoStopSilenceMs: 60000,
    /**
     * TUI one-shot mode: after speech was detected, stop once this much silence
     * follows. This is what makes a single <leader>v press enough.
     */
    oneShotSilenceMs: 1400,
    /**
     * Separate auto-stop for the global hotkey (`globalHotkey`), in ms.
     * Useful for long dictation with pauses. 0 = use oneShotSilenceMs.
     */
    hotkeyOneShotSilenceMs: 0,
  },
  openai: {
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "whisper-1",
    apiKey: "",
    extraBody: {},
    prompt: "",
    sendContextPrompt: true,
    requestTimeoutMs: 60000,
  },
  local: {
    /** whisper.cpp `.bin` model or a folder with several models. */
    modelPath: "",
    /** whisper-cli path; empty = auto-detect next to the model / on PATH. */
    executablePath: "",
    extraArgs: "",
  },
  onnx: {
    /** sherpa-onnx NeMo/CTC model: folder with model.onnx + tokens.txt, or the .onnx. */
    modelPath: "",
    /** sherpa-onnx-offline path; empty = auto-detect. */
    executablePath: "",
    /** auto | int8 | fp32 */
    precision: "auto",
    /** auto | server | cli — `server` keeps the model warm between phrases. */
    mode: "auto",
    extraArgs: "",
    /** Number of CPU threads for the warm websocket server. */
    threads: 2,
  },
  salute: {
    tokenUrl: "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
    recognizeUrl: "https://smartspeech.sber.ru/rest/v1/speech:recognize",
    scope: "SALUTE_SPEECH_PERS",
    clientId: "",
    clientSecret: "",
    authorizationKey: "",
    insecureTLS: false,
  },
  command: {
    /** Custom recorder: must write raw s16le / 16 kHz / mono to stdout. */
    capture: "",
    /** Custom recognizer: `${file}` is a WAV, `${out}` an optional text file. */
    transcribe: "",
  },
  /**
   * HTTP voice server used by the Chrome extension / web UI and by /voice doctor.
   * This is not the STT engine: the engine may be a warm sherpa-onnx subprocess.
   */
  server: {
    enabled: true,
    host: "127.0.0.1",
    port: 8765,
    /** Optional shared secret. When set, every route except /health needs X-Voice-Token. */
    token: "",
    maxUploadMb: 25,
    maxAudioSeconds: 300,
    concurrency: 1,
    /** Extra allowed origins (localhost, 127.0.0.1 and chrome-extension:// are always allowed). */
    allowedOrigins: [],
    /** Keep the STT engine warm between requests. */
    warmup: true,
  },
  ui: {
    /** auto | ru | en */
    language: "auto",
  },
};

/** Deep merge plain objects; arrays and primitives replace. */
export function mergeConfig(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfigFile(file) {
  const text = readFileSync(file, "utf8");
  const parsed = /\.jsonc$/i.test(file) ? parseJsonc(text) : JSON.parse(stripBom(text));
  if (!isPlainObject(parsed)) throw new Error(`${file}: expected a JSON object`);
  return parsed;
}

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, "");
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Environment variables win over files, like in the VS Code extension. */
export function applyEnv(config) {
  const env = process.env;
  const patch = {};

  if (env.OPENCODE_VOICE_PROVIDER) patch.provider = env.OPENCODE_VOICE_PROVIDER;
  if (env.OPENCODE_VOICE_LANGUAGE) patch.language = env.OPENCODE_VOICE_LANGUAGE;
  if (env.OPENCODE_VOICE_HOTKEY) patch.hotkey = env.OPENCODE_VOICE_HOTKEY;
  if (env.OPENCODE_VOICE_GLOBAL_HOTKEY) patch.globalHotkey = env.OPENCODE_VOICE_GLOBAL_HOTKEY;
  if (env.OPENCODE_VOICE_GLOBAL_HOTKEY_PASTE !== undefined) {
    patch.globalHotkeyPaste = boolFromEnv("OPENCODE_VOICE_GLOBAL_HOTKEY_PASTE", config.globalHotkeyPaste);
  }

  if (env.OPENCODE_VOICE_FFMPEG) patch.audio = { ...(patch.audio || {}), ffmpegPath: env.OPENCODE_VOICE_FFMPEG };
  if (env.OPENCODE_VOICE_INPUT_FORMAT) patch.audio = { ...(patch.audio || {}), inputFormat: env.OPENCODE_VOICE_INPUT_FORMAT };
  if (env.OPENCODE_VOICE_DEVICE) patch.audio = { ...(patch.audio || {}), device: env.OPENCODE_VOICE_DEVICE };
  if (env.OPENCODE_VOICE_SILENCE_MS) patch.audio = { ...(patch.audio || {}), silenceMs: numberFromEnv("OPENCODE_VOICE_SILENCE_MS", config.audio.silenceMs) };
  if (env.OPENCODE_VOICE_ONE_SHOT_SILENCE_MS) {
    patch.audio = { ...(patch.audio || {}), oneShotSilenceMs: numberFromEnv("OPENCODE_VOICE_ONE_SHOT_SILENCE_MS", config.audio.oneShotSilenceMs) };
  }
  if (env.OPENCODE_VOICE_HOTKEY_ONE_SHOT_SILENCE_MS) {
    patch.audio = {
      ...(patch.audio || {}),
      hotkeyOneShotSilenceMs: numberFromEnv("OPENCODE_VOICE_HOTKEY_ONE_SHOT_SILENCE_MS", config.audio.hotkeyOneShotSilenceMs),
    };
  }
  if (env.OPENCODE_VOICE_AUTO_STOP_SILENCE_MS) {
    patch.audio = { ...(patch.audio || {}), autoStopSilenceMs: numberFromEnv("OPENCODE_VOICE_AUTO_STOP_SILENCE_MS", config.audio.autoStopSilenceMs) };
  }

  if (env.OPENCODE_VOICE_OPENAI_BASE_URL) patch.openai = { ...(patch.openai || {}), baseUrl: env.OPENCODE_VOICE_OPENAI_BASE_URL };
  if (env.OPENCODE_VOICE_OPENAI_MODEL || env.OPENCODE_VOICE_MODEL) {
    patch.openai = { ...(patch.openai || {}), model: env.OPENCODE_VOICE_OPENAI_MODEL || env.OPENCODE_VOICE_MODEL };
  }
  if (env.OPENAI_API_KEY) patch.openai = { ...(patch.openai || {}), apiKey: env.OPENAI_API_KEY };
  if (env.OPENCODE_VOICE_OPENAI_PROMPT) patch.openai = { ...(patch.openai || {}), prompt: env.OPENCODE_VOICE_OPENAI_PROMPT };

  if (env.OPENCODE_VOICE_ONNX_MODEL) patch.onnx = { ...(patch.onnx || {}), modelPath: env.OPENCODE_VOICE_ONNX_MODEL };
  if (env.OPENCODE_VOICE_ONNX_EXE) patch.onnx = { ...(patch.onnx || {}), executablePath: env.OPENCODE_VOICE_ONNX_EXE };
  if (env.OPENCODE_VOICE_ONNX_MODE) patch.onnx = { ...(patch.onnx || {}), mode: env.OPENCODE_VOICE_ONNX_MODE };
  if (env.OPENCODE_VOICE_ONNX_PRECISION) patch.onnx = { ...(patch.onnx || {}), precision: env.OPENCODE_VOICE_ONNX_PRECISION };
  if (env.OPENCODE_VOICE_ONNX_EXTRA_ARGS) patch.onnx = { ...(patch.onnx || {}), extraArgs: env.OPENCODE_VOICE_ONNX_EXTRA_ARGS };

  if (env.OPENCODE_VOICE_WHISPER_MODEL) patch.local = { ...(patch.local || {}), modelPath: env.OPENCODE_VOICE_WHISPER_MODEL };
  if (env.OPENCODE_VOICE_WHISPER_EXE) patch.local = { ...(patch.local || {}), executablePath: env.OPENCODE_VOICE_WHISPER_EXE };
  if (env.OPENCODE_VOICE_WHISPER_ARGS) patch.local = { ...(patch.local || {}), extraArgs: env.OPENCODE_VOICE_WHISPER_ARGS };

  if (env.OPENCODE_VOICE_COMMAND_CAPTURE) patch.command = { ...(patch.command || {}), capture: env.OPENCODE_VOICE_COMMAND_CAPTURE };
  if (env.OPENCODE_VOICE_COMMAND_TRANSCRIBE) patch.command = { ...(patch.command || {}), transcribe: env.OPENCODE_VOICE_COMMAND_TRANSCRIBE };

  if (env.OPENCODE_VOICE_PORT) patch.server = { ...(patch.server || {}), port: numberFromEnv("OPENCODE_VOICE_PORT", config.server.port) };
  if (env.OPENCODE_VOICE_HOST) patch.server = { ...(patch.server || {}), host: env.OPENCODE_VOICE_HOST };
  if (env.OPENCODE_VOICE_TOKEN) patch.server = { ...(patch.server || {}), token: env.OPENCODE_VOICE_TOKEN };
  if (env.OPENCODE_VOICE_SERVER) patch.server = { ...(patch.server || {}), enabled: boolFromEnv("OPENCODE_VOICE_SERVER", config.server.enabled) };
  if (env.OPENCODE_VOICE_MAX_UPLOAD_MB) patch.server = { ...(patch.server || {}), maxUploadMb: numberFromEnv("OPENCODE_VOICE_MAX_UPLOAD_MB", config.server.maxUploadMb) };
  if (env.OPENCODE_VOICE_ALLOWED_ORIGINS) patch.server = { ...(patch.server || {}), allowedOrigins: parseList(env.OPENCODE_VOICE_ALLOWED_ORIGINS) };

  if (env.OPENCODE_VOICE_UI_LANG) patch.ui = { ...(patch.ui || {}), language: env.OPENCODE_VOICE_UI_LANG };

  return Object.keys(patch).length > 0 ? mergeConfig(config, patch) : config;
}

/** Clamp/normalize values so a hand-written config cannot crash the runtime. */
export function normalizeConfig(input) {
  const config = mergeConfig(DEFAULTS, input || {});
  const provider = String(config.provider || "auto").toLowerCase();
  config.provider = PROVIDERS.includes(provider) ? provider : "auto";
  config.language = String(config.language || "auto").trim() || "auto";
  config.hotkey = String(config.hotkey || DEFAULTS.hotkey).trim() || DEFAULTS.hotkey;
  config.globalHotkey = String(config.globalHotkey || "").trim().toLowerCase();
  config.globalHotkeyPaste = config.globalHotkeyPaste !== false;

  config.audio = mergeConfig(DEFAULTS.audio, config.audio || {});
  config.audio.ffmpegPath = String(config.audio.ffmpegPath || "ffmpeg").trim() || "ffmpeg";
  config.audio.inputFormat = String(config.audio.inputFormat || "auto").toLowerCase();
  if (!["auto", "dshow", "avfoundation", "pulse", "alsa"].includes(config.audio.inputFormat)) {
    config.audio.inputFormat = "auto";
  }
  config.audio.device = String(config.audio.device || "").trim();
  config.audio.silenceMs = clampNumber(config.audio.silenceMs, 150, 10000, DEFAULTS.audio.silenceMs);
  config.audio.minSegmentMs = clampNumber(config.audio.minSegmentMs, 100, 10000, DEFAULTS.audio.minSegmentMs);
  config.audio.maxSegmentMs = clampNumber(config.audio.maxSegmentMs, 2000, 300000, DEFAULTS.audio.maxSegmentMs);
  config.audio.noiseThreshold = clampNumber(config.audio.noiseThreshold, 0, 0.5, DEFAULTS.audio.noiseThreshold);
  config.audio.autoStopSilenceMs = clampNumber(config.audio.autoStopSilenceMs, 0, 3600000, DEFAULTS.audio.autoStopSilenceMs);
  config.audio.oneShotSilenceMs = clampNumber(config.audio.oneShotSilenceMs, 0, 60000, DEFAULTS.audio.oneShotSilenceMs);
  config.audio.hotkeyOneShotSilenceMs = clampNumber(
    config.audio.hotkeyOneShotSilenceMs,
    0,
    600000,
    DEFAULTS.audio.hotkeyOneShotSilenceMs,
  );
  config.audio.cues = mergeConfig(DEFAULTS.audio.cues, config.audio.cues || {});
  config.audio.cues.volume = clampNumber(config.audio.cues.volume, 0, 100, DEFAULTS.audio.cues.volume);

  config.openai = mergeConfig(DEFAULTS.openai, config.openai || {});
  config.openai.baseUrl = String(config.openai.baseUrl || DEFAULTS.openai.baseUrl).trim().replace(/\/+$/, "");
  config.openai.model = String(config.openai.model || DEFAULTS.openai.model).trim() || DEFAULTS.openai.model;
  config.openai.requestTimeoutMs = clampNumber(config.openai.requestTimeoutMs, 1000, 600000, DEFAULTS.openai.requestTimeoutMs);

  config.local = mergeConfig(DEFAULTS.local, config.local || {});
  config.onnx = mergeConfig(DEFAULTS.onnx, config.onnx || {});
  config.onnx.mode = ["auto", "server", "cli"].includes(String(config.onnx.mode)) ? config.onnx.mode : "auto";
  config.onnx.precision = ["auto", "int8", "fp32"].includes(String(config.onnx.precision)) ? config.onnx.precision : "auto";
  config.onnx.threads = clampNumber(config.onnx.threads, 1, 64, DEFAULTS.onnx.threads);

  config.salute = mergeConfig(DEFAULTS.salute, config.salute || {});
  config.command = mergeConfig(DEFAULTS.command, config.command || {});
  config.insert = mergeConfig(DEFAULTS.insert, config.insert || {});

  config.server = mergeConfig(DEFAULTS.server, config.server || {});
  config.server.port = clampNumber(config.server.port, 1, 65535, DEFAULTS.server.port);
  config.server.maxUploadMb = clampNumber(config.server.maxUploadMb, 1, 1024, DEFAULTS.server.maxUploadMb);
  config.server.maxAudioSeconds = clampNumber(config.server.maxAudioSeconds, 5, 3600, DEFAULTS.server.maxAudioSeconds);
  config.server.concurrency = clampNumber(config.server.concurrency, 1, 8, DEFAULTS.server.concurrency);
  config.server.allowedOrigins = Array.isArray(config.server.allowedOrigins) ? config.server.allowedOrigins.map(String) : [];
  config.server.host = String(config.server.host || DEFAULTS.server.host).trim() || DEFAULTS.server.host;
  config.server.token = String(config.server.token || "").trim();

  config.ui = mergeConfig(DEFAULTS.ui, config.ui || {});
  if (!["auto", "ru", "en"].includes(String(config.ui.language))) config.ui.language = "auto";

  return config;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

/**
 * Reads every applicable config file and applies env overrides.
 * Returns `{ config, files, errors, configPath }`.
 */
export function loadConfig(options = {}) {
  const directory = options.directory || process.cwd();
  const files = [];
  const errors = [];
  let merged = {};

  for (const file of configCandidates(directory)) {
    if (!existsSync(file)) continue;
    try {
      merged = mergeConfig(merged, readConfigFile(file));
      files.push(file);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let config = normalizeConfig(merged);
  config = applyEnv(config);
  config = normalizeConfig(config);

  return {
    config,
    files,
    errors,
    configPath: firstExistingConfigPath(directory) || defaultConfigPath(),
    globalConfigPath: defaultConfigPath(),
  };
}

/** Writes/merges settings into a config file (global by default). */
export function saveConfig(patch, options = {}) {
  const file = options.file || defaultConfigPath();
  let current = {};
  if (existsSync(file)) {
    try {
      current = readConfigFile(file);
    } catch {
      current = {};
    }
  }
  const next = mergeConfig(current, patch);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

/** Resolves `auto` to a concrete provider based on configured model paths. */
export function resolveProvider(config) {
  if (config.provider !== "auto") return config.provider;
  const onnxPath = expandHome(config.onnx?.modelPath || "");
  if (onnxPath && existsSync(onnxPath)) return "local-onnx";
  const whisperPath = expandHome(config.local?.modelPath || "");
  if (whisperPath && existsSync(whisperPath)) return "local-whisper";
  if (config.command?.transcribe) return "command";
  return "openai-compatible";
}

export function providerLabel(config, resolved = resolveProvider(config)) {
  switch (resolved) {
    case "local-onnx":
      return `sherpa-onnx (${config.onnx?.modelPath || "model not configured"})`;
    case "local-whisper":
      return `whisper.cpp (${config.local?.modelPath || "model not configured"})`;
    case "salute":
      return "SaluteSpeech (Sber)";
    case "command":
      return `command (${config.command?.transcribe || "not configured"})`;
    default:
      return `OpenAI-compatible ${config.openai?.baseUrl} (${config.openai?.model})`;
  }
}

/** Safe for /health: secrets are replaced by booleans. */
export function publicConfig(config) {
  return {
    provider: config.provider,
    resolvedProvider: resolveProvider(config),
    language: config.language,
    audio: {
      ffmpegPath: config.audio.ffmpegPath,
      inputFormat: config.audio.inputFormat,
      device: config.audio.device,
      silenceMs: config.audio.silenceMs,
      oneShotSilenceMs: config.audio.oneShotSilenceMs,
      hotkeyOneShotSilenceMs: config.audio.hotkeyOneShotSilenceMs,
      autoStopSilenceMs: config.audio.autoStopSilenceMs,
      cues: config.audio.cues,
    },
    openai: {
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      apiKey: config.openai.apiKey ? "set" : "",
    },
    local: {
      modelPath: config.local.modelPath,
      executablePath: config.local.executablePath,
    },
    onnx: {
      modelPath: config.onnx.modelPath,
      executablePath: config.onnx.executablePath,
      mode: config.onnx.mode,
      precision: config.onnx.precision,
    },
    server: {
      host: config.server.host,
      port: config.server.port,
      maxUploadMb: config.server.maxUploadMb,
      maxAudioSeconds: config.server.maxAudioSeconds,
      auth: Boolean(config.server.token),
    },
    hotkey: config.hotkey,
    globalHotkey: config.globalHotkey,
    globalHotkeyPaste: config.globalHotkeyPaste,
  };
}
