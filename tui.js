// OpenCode Voice — TUI plugin.
//
// Loaded by the OpenCode CLI (package export "./tui"). Registers the /voice
// commands and the leader hotkey, records with ffmpeg, recognizes with the
// configured local engine and appends the text to the prompt.
//
// It supports the V1 TUI plugin API (api.keymap.registerLayer + api.client.tui)
// used by OpenCode 1.x and the V2 CLI plugin shape when available.

import { VoiceRuntime } from "./lib/runtime.js";
import { createLogger } from "./lib/log.js";
import { saveConfig, PROVIDERS } from "./lib/config.js";
import { defaultConfigPath } from "./lib/paths.js";
import { listAudioDevices, resolveCaptureFormat } from "./lib/audio/devices.js";
import { resolveFfmpegPath } from "./lib/audio/capture.js";
import { createTranslator, detectUiLanguage } from "./lib/i18n.js";
import { createTuiV2 } from "./lib/tui-v2.js";

const LANGUAGES = ["auto", "ru", "en", "de", "fr", "es", "it", "pt", "uk", "kk", "pl", "nl", "tr", "ja", "ko", "zh"];
const HOTKEYS = ["<leader>v", "ctrl+r", "alt+r", "ctrl+space", "f9"];

function createTui(api, options = {}) {
  const logger = createLogger({ name: "voice-tui" });
  const directory = options.directory || api.cwd || process.cwd();
  const runtime = new VoiceRuntime({ directory, logger });
  let t = createTranslator(detectUiLanguage(runtime.config.ui.language));
  const state = {
    session: null,
    submitNext: false,
    disposeCommands: undefined,
    lastError: undefined,
  };

  const toast = (message, variant = "info") => {
    try {
      if (typeof api.ui?.toast === "function") {
        api.ui.toast({ title: t("voice.title"), message, variant });
      } else if (typeof api.ui?.toast?.show === "function") {
        api.ui.toast.show({ title: t("voice.title"), message, variant });
      } else {
        console.log(`[voice] ${message}`);
      }
    } catch {
      // UI is best effort
    }
  };

  const dialog = {
    set(size, render) {
      try {
        if (api.ui?.dialog?.setSize) api.ui.dialog.setSize(size);
        if (api.ui?.dialog?.replace) {
          api.ui.dialog.replace(render);
          return true;
        }
      } catch {}
      return false;
    },
    clear() {
      try {
        api.ui?.dialog?.clear?.();
      } catch {}
    },
    alert(title, message) {
      if (dialog.set("xlarge", () => api.ui.DialogAlert({ title, message }))) return true;
      if (typeof api.ui?.dialog?.alert === "function") {
        void api.ui.dialog.alert({ title, message }).catch(() => undefined);
        return true;
      }
      toast(message);
      return false;
    },
    select(props) {
      if (dialog.set("large", () => api.ui.DialogSelect(props))) return true;
      return false;
    },
    prompt(props) {
      if (dialog.set("medium", () => api.ui.DialogPrompt(props))) return true;
      return false;
    },
  };

  const notifyServerReload = async () => {
    const config = runtime.config;
    const host = config.server.host === "0.0.0.0" || config.server.host === "::" ? "127.0.0.1" : config.server.host;
    const base = host.includes(":") ? `http://[${host}]:${config.server.port}` : `http://${host}:${config.server.port}`;
    try {
      const headers = {};
      if (config.server.token) headers["X-Voice-Token"] = config.server.token;
      await fetch(`${base}/reload`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // the server plugin may not be running
    }
  };

  const applySettings = async (patch) => {
    const file = saveConfig(patch);
    runtime.reload();
    t = createTranslator(detectUiLanguage(runtime.config.ui.language));
    registerCommands();
    await notifyServerReload();
    toast(`${t("voice.saved")}: ${file}`);
  };

  const appendText = async (text) => {
    const clean = String(text || "").trim();
    if (!clean) return false;
    const client = api.client?.tui;
    const suffix = runtime.config.insert.trailingSpace === false ? "" : " ";
    try {
      if (typeof client?.appendPrompt === "function") {
        await client.appendPrompt({ text: clean.endsWith(" ") ? clean : `${clean}${suffix}` });
        return true;
      }
    } catch (error) {
      logger.error("appendPrompt failed", { error: error?.message || String(error) });
    }

    // No prompt API (e.g. a read-only client): never lose the text.
    dialog.alert(t("voice.title"), clean);
    return false;
  };

  const submitPrompt = async () => {
    try {
      if (typeof api.client?.tui?.submitPrompt === "function") await api.client.tui.submitPrompt();
    } catch (error) {
      logger.warn("submitPrompt failed", { error: error?.message || String(error) });
    }
  };

  const handleEnd = async (info) => {
    state.session = null;
    if (info?.cancelled) {
      toast(t("voice.cancelled"), "info");
      return;
    }
    if (info?.error) {
      state.lastError = info.error.message;
      toast(t("voice.error", info.error.message), "error");
      return;
    }
    const text = String(info?.transcript || "").trim();
    if (!text) {
      toast(t("voice.noSpeech"), "warning");
      return;
    }
    const inserted = await appendText(text);
    if (inserted && (state.submitNext || runtime.config.insert.autoSubmit)) await submitPrompt();
    state.submitNext = false;
    toast(inserted ? t("voice.inserted", `${text.length} chars`) : t("voice.ready"), inserted ? "success" : "info");
  };

  const startVoice = async (submit = false) => {
    if (state.session) {
      toast(t("voice.alreadyRecording"), "warning");
      return;
    }
    state.submitNext = submit;
    try {
      const session = await runtime.startRecording({ oneShot: true });
      state.session = session;
      toast(t("voice.listening"));
      void session.done.then((info) => handleEnd(info));
    } catch (error) {
      state.session = null;
      state.lastError = error?.message || String(error);
      logger.error("start recording failed", { error: state.lastError });
      toast(t("voice.startFailed", state.lastError), "error");
    }
  };

  const stopVoice = async () => {
    const session = state.session;
    if (!session) return;
    toast(t("voice.transcribing"));
    try {
      await session.stop("hotkey");
    } catch (error) {
      toast(t("voice.error", error?.message || String(error)), "error");
    }
  };

  const cancelVoice = async () => {
    const session = state.session;
    if (!session) return;
    state.session = null;
    state.submitNext = false;
    await session.cancel("hotkey");
    toast(t("voice.cancelled"));
  };

  const toggleVoice = async (submit = false) => {
    if (state.session) {
      state.submitNext = submit;
      await stopVoice();
      return;
    }
    await startVoice(submit);
  };

  const showDoctor = async () => {
    toast("🩺 …");
    try {
      const text = await runtime.doctor();
      dialog.alert(t("voice.doctor"), text);
    } catch (error) {
      toast(t("voice.error", error?.message || String(error)), "error");
    }
  };

  const warmup = async () => {
    toast(t("voice.warming"));
    const result = await runtime.warmup();
    if (result.ok) toast(t("voice.warm", result.label || result.provider || "ok"), "success");
    else toast(t("voice.error", result.error || "warmup failed"), "error");
  };

  const reload = async () => {
    runtime.reload();
    t = createTranslator(detectUiLanguage(runtime.config.ui.language));
    registerCommands();
    toast(t("voice.reloaded"), "success");
  };

  const showConfig = () => {
    const files = runtime.configFiles?.length ? runtime.configFiles.join("\n") : t("voice.configMissing");
    const message = [
      files,
      "",
      `${t("voice.provider")}: ${runtime.config.provider} -> ${runtime.provider}`,
      `${t("voice.language")}: ${runtime.config.language}`,
      `${t("voice.microphone")}: ${runtime.config.audio.device || t("voice.automatic")}`,
      `${t("voice.hotkey")}: ${runtime.config.hotkey}`,
      `Server: http://${runtime.config.server.host}:${runtime.config.server.port}`,
      "",
      t("voice.hint", runtime.config.hotkey),
    ].join("\n");
    dialog.alert(t("voice.settings"), message);
  };

  const showProviderPicker = () => {
    dialog.select({
      title: t("voice.provider"),
      current: runtime.config.provider,
      options: PROVIDERS.map((provider) => ({
        title: provider,
        value: provider,
        description: provider === "auto" ? "local-onnx -> local-whisper -> OpenAI-compatible" : undefined,
        category: provider === runtime.config.provider ? "Current" : undefined,
      })),
      onSelect: async (option) => {
        await applySettings({ provider: option.value });
        dialog.clear();
      },
    });
  };

  const showLanguagePicker = () => {
    dialog.select({
      title: t("voice.language"),
      current: runtime.config.language,
      options: LANGUAGES.map((language) => ({
        title: language === "auto" ? "auto (model detects)" : language,
        value: language,
      })),
      onSelect: async (option) => {
        await applySettings({ language: option.value });
        dialog.clear();
      },
    });
  };

  const showMicrophonePicker = async () => {
    const ffmpeg = resolveFfmpegPath(runtime.config.audio.ffmpegPath);
    const format = resolveCaptureFormat(runtime.config.audio.inputFormat);
    const devices = await listAudioDevices(ffmpeg, format).catch(() => []);
    dialog.select({
      title: t("voice.microphone"),
      current: runtime.config.audio.device || "",
      options: [
        { title: t("voice.automatic"), value: "", description: "Use the first available input" },
        ...devices.map((device) => ({
          title: device.name,
          value: device.id,
          description: device.id === device.name ? undefined : device.id,
        })),
      ],
      onSelect: async (option) => {
        await applySettings({ audio: { device: option.value } });
        dialog.clear();
      },
    });
  };

  const showHotkeyPicker = () => {
    dialog.select({
      title: t("voice.hotkey"),
      current: runtime.config.hotkey,
      options: [
        ...HOTKEYS.map((hotkey) => ({ title: hotkey, value: hotkey })),
        { title: t("voice.custom"), value: "__custom" },
      ],
      onSelect: (option) => {
        if (option.value === "__custom") {
          dialog.prompt({
            title: t("voice.hotkey"),
            placeholder: "ctrl+alt+v",
            value: runtime.config.hotkey,
            onConfirm: async (value) => {
              const hotkey = String(value || "").trim();
              if (hotkey) await applySettings({ hotkey });
              dialog.clear();
            },
            onCancel: () => showSettings(),
          });
          return;
        }
        void applySettings({ hotkey: option.value }).then(() => dialog.clear());
      },
    });
  };

  const showSettings = () => {
    dialog.select({
      title: t("voice.settings"),
      options: [
        { title: `🎙 ${t("voice.provider")}`, value: "provider", description: runtime.providerLabel },
        { title: `🌐 ${t("voice.language")}`, value: "language", description: runtime.config.language },
        { title: `🎤 ${t("voice.microphone")}`, value: "microphone", description: runtime.config.audio.device || t("voice.automatic") },
        { title: `⌨ ${t("voice.hotkey")}`, value: "hotkey", description: runtime.config.hotkey },
        { title: `🩺 ${t("voice.doctor")}`, value: "doctor", category: "Advanced" },
        { title: `🔥 ${t("voice.warmup")}`, value: "warmup", category: "Advanced" },
        { title: `🔄 ${t("voice.reload")}`, value: "reload", category: "Advanced" },
        { title: `📄 ${t("voice.configFile")}`, value: "config", category: "Advanced", description: defaultConfigPath() },
      ],
      onSelect: (option) => {
        switch (option.value) {
          case "provider":
            return showProviderPicker();
          case "language":
            return showLanguagePicker();
          case "microphone":
            void showMicrophonePicker();
            return;
          case "hotkey":
            return showHotkeyPicker();
          case "doctor":
            void showDoctor();
            return;
          case "warmup":
            void warmup();
            return;
          case "reload":
            void reload();
            return;
          case "config":
            return showConfig();
          default:
            return undefined;
        }
      },
    });
  };

  const buildV1Commands = () => [
    {
      name: "voice.record",
      title: t("voice.command.record"),
      desc: t("voice.command.record"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice",
      slashAliases: ["voice-record"],
      run: () => toggleVoice(false),
    },
    {
      name: "voice.submit",
      title: t("voice.command.submit"),
      desc: t("voice.command.submit"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-submit",
      run: () => toggleVoice(true),
    },
    {
      name: "voice.stop",
      title: t("voice.command.stop"),
      desc: t("voice.command.stop"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-stop",
      run: () => cancelVoice(),
    },
    {
      name: "voice.settings",
      title: t("voice.command.settings"),
      desc: t("voice.command.settings"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-settings",
      run: () => showSettings(),
    },
    {
      name: "voice.doctor",
      title: t("voice.command.doctor"),
      desc: t("voice.command.doctor"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-doctor",
      run: () => showDoctor(),
    },
    {
      name: "voice.reload",
      title: t("voice.command.reload"),
      desc: t("voice.command.reload"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-reload",
      run: () => reload(),
    },
    {
      name: "voice.warmup",
      title: t("voice.command.warmup"),
      desc: t("voice.command.warmup"),
      category: t("voice.category"),
      namespace: "palette",
      slashName: "voice-warmup",
      run: () => warmup(),
    },
  ];

  function registerCommands() {
    try {
      state.disposeCommands?.();
    } catch {}
    state.disposeCommands = undefined;

    const bindings = runtime.config.hotkey
      ? [{ key: runtime.config.hotkey, cmd: "voice.record", desc: t("voice.command.record") }]
      : [];

    try {
      if (typeof api.keymap?.registerLayer === "function") {
        state.disposeCommands = api.keymap.registerLayer({
          priority: 100,
          commands: buildV1Commands(),
          bindings,
        });
      }
    } catch (error) {
      logger.error("could not register keymap layer", { error: error?.message || String(error) });
    }
  }

  registerCommands();
  const dispose = () => {
    try {
      state.disposeCommands?.();
    } catch {}
    void state.session?.cancel("dispose");
    runtime.dispose();
  };
  try {
    api.lifecycle?.onDispose?.(dispose);
  } catch {}

  return {
    runtime,
    dispose,
    showSettings,
    toggle: toggleVoice,
  };
}

const plugin = {
  id: "opencode.voice.tui",
  // V1 TUI plugin shape (OpenCode 1.x).
  tui: createTui,
  // V2 CLI plugin shape (OpenCode 2.x).
  setup: createTuiV2,
};

export default plugin;
