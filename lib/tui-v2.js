// OpenCode 2 CLI plugin implementation (the V1 implementation lives in ../tui.js).
//
// OpenCode 2 has no API to append text to the composer, so `/voice` copies the
// transcript to the system clipboard and asks the user to paste it. `/voice-send`
// sends it straight to the active session with context.client.session.prompt().

import { VoiceRuntime } from "./runtime.js";
import { createLogger } from "./log.js";
import { saveConfig, PROVIDERS } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { listAudioDevices, resolveCaptureFormat } from "./audio/devices.js";
import { resolveFfmpegPath } from "./audio/capture.js";
import { copyToClipboard } from "./clipboard.js";
import { createTranslator, detectUiLanguage } from "./i18n.js";

const LANGUAGES = ["auto", "ru", "en", "de", "fr", "es", "it", "pt", "uk", "kk", "pl", "nl", "tr", "ja", "ko", "zh"];
const HOTKEYS = ["<leader>v", "ctrl+r", "ctrl+alt+r", "alt+r", "f9"];

export function createTuiV2(context) {
  const logger = createLogger({ name: "voice-tui" });
  const directory = context.location?.directory || process.cwd();
  const runtime = new VoiceRuntime({ directory, logger });
  let t = createTranslator(detectUiLanguage(runtime.config.ui.language));
  let session = null;
  let disposed = false;

  const toast = (message, variant = "info", duration) => {
    if (disposed) return;
    try {
      context.ui.toast.show({ title: "Voice", message, variant, duration: duration ?? (variant === "error" ? 12000 : 5000) });
    } catch {
      // UI is best effort
    }
  };

  const alert = (title, message) => {
    if (disposed) return;
    try {
      void context.ui.dialog.alert({ title, message }).catch(() => undefined);
    } catch {}
  };

  const select = async (props) => {
    try {
      return await context.ui.dialog.select(props);
    } catch {
      return undefined;
    }
  };

  const prompt = async (props) => {
    try {
      return await context.ui.dialog.prompt(props);
    } catch {
      return undefined;
    }
  };

  const activeSessionID = () => {
    try {
      const route = context.ui.router?.current?.();
      return route?.type === "session" ? route.sessionID : undefined;
    } catch {
      return undefined;
    }
  };

  const applySettings = (patch) => {
    const file = saveConfig(patch);
    runtime.reload();
    t = createTranslator(detectUiLanguage(runtime.config.ui.language));
    toast(`${t("voice.saved")}: ${file}`, "success");
  };

  const deliver = async (text, submit) => {
    const clean = String(text || "").trim();
    if (!clean) return;
    const copied = await copyToClipboard(clean);
    const shouldSubmit = submit || runtime.config.insert.autoSubmit;
    const sessionID = activeSessionID();

    if (shouldSubmit && sessionID) {
      try {
        await context.client.session.prompt({ sessionID, text: clean });
        toast(`📨 ${t("voice.inserted", `${clean.length} chars`)}`, "success", 7000);
        return;
      } catch (error) {
        logger.warn("session.prompt failed", { error: error?.message || String(error) });
      }
    }

    if (shouldSubmit && !sessionID) {
      toast(`${copied ? "📋 " : ""}Нет активной сессии — текст скопирован, вставьте Ctrl+V`, "warning", 9000);
      return;
    }

    toast(
      copied
        ? `📋 ${t("voice.inserted", `${clean.length} chars`)} — вставьте Ctrl+V`
        : `🎤 ${clean.slice(0, 180)}`,
      "success",
      9000,
    );
  };

  const handleEnd = async (info, submit) => {
    session = null;
    if (info?.cancelled) {
      toast(t("voice.cancelled"));
      return;
    }
    if (info?.error) {
      toast(t("voice.error", info.error.message), "error");
      return;
    }
    const text = String(info?.transcript || "").trim();
    if (!text) {
      toast(t("voice.noSpeech"), "warning");
      return;
    }
    await deliver(text, submit);
  };

  const startVoice = async (submit) => {
    if (session) {
      toast(t("voice.alreadyRecording"), "warning");
      return;
    }
    try {
      session = await runtime.startRecording({ oneShot: true });
      toast(t("voice.listening"));
      void session.done.then((info) => handleEnd(info, submit));
    } catch (error) {
      session = null;
      logger.error("start recording failed", { error: error?.message || String(error) });
      toast(t("voice.startFailed", error?.message || String(error)), "error");
    }
  };

  const stopVoice = async () => {
    if (!session) return;
    toast(t("voice.transcribing"));
    try {
      await session.stop("hotkey");
    } catch (error) {
      toast(t("voice.error", error?.message || String(error)), "error");
    }
  };

  const toggleVoice = async (submit = false) => {
    if (session) {
      await stopVoice();
      return;
    }
    await startVoice(submit);
  };

  const cancelVoice = async () => {
    if (!session) return;
    const current = session;
    session = null;
    await current.cancel("hotkey");
    toast(t("voice.cancelled"));
  };

  const showProviderPicker = async () => {
    const choice = await select({
      title: t("voice.provider"),
      current: runtime.config.provider,
      options: PROVIDERS.map((provider) => ({
        title: provider,
        value: provider,
        description: provider === "auto" ? "local-onnx -> local-whisper -> OpenAI-compatible" : undefined,
        category: provider === runtime.config.provider ? "Current" : undefined,
      })),
    });
    if (choice !== undefined) applySettings({ provider: choice });
  };

  const showLanguagePicker = async () => {
    const choice = await select({
      title: t("voice.language"),
      current: runtime.config.language,
      options: LANGUAGES.map((language) => ({ title: language === "auto" ? "auto (model detects)" : language, value: language })),
    });
    if (choice !== undefined) applySettings({ language: choice });
  };

  const showMicrophonePicker = async () => {
    const devices = await listAudioDevices(
      resolveFfmpegPath(runtime.config.audio.ffmpegPath),
      resolveCaptureFormat(runtime.config.audio.inputFormat),
    ).catch(() => []);
    const choice = await select({
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
    });
    if (choice !== undefined) applySettings({ audio: { device: choice } });
  };

  const showHotkeyPicker = async () => {
    const choice = await select({
      title: t("voice.hotkey"),
      current: runtime.config.hotkey,
      options: [...HOTKEYS.map((hotkey) => ({ title: hotkey, value: hotkey })), { title: t("voice.custom"), value: "__custom" }],
    });
    if (choice === undefined) return;
    if (choice !== "__custom") {
      applySettings({ hotkey: choice });
      return;
    }
    const value = await prompt({
      title: t("voice.hotkey"),
      placeholder: "ctrl+alt+v",
      value: runtime.config.hotkey,
    });
    if (value !== undefined && String(value).trim()) applySettings({ hotkey: String(value).trim() });
  };

  const showDoctor = async () => {
    toast("🩺 …");
    try {
      const text = await runtime.doctor();
      alert(t("voice.doctor"), text);
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

  const reload = () => {
    runtime.reload();
    t = createTranslator(detectUiLanguage(runtime.config.ui.language));
    toast(t("voice.reloaded"), "success");
  };

  const showConfig = () => {
    const files = runtime.configFiles?.length ? runtime.configFiles.join("\n") : t("voice.configMissing");
    alert(
      t("voice.settings"),
      [
        files,
        "",
        `${t("voice.provider")}: ${runtime.config.provider} -> ${runtime.provider}`,
        `${t("voice.language")}: ${runtime.config.language}`,
        `${t("voice.microphone")}: ${runtime.config.audio.device || t("voice.automatic")}`,
        `${t("voice.hotkey")}: ${runtime.config.hotkey}`,
        `Server: http://${runtime.config.server.host}:${runtime.config.server.port}`,
        "",
        t("voice.hint", runtime.config.hotkey),
      ].join("\n"),
    );
  };

  const showSettings = async () => {
    const choice = await select({
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
    });

    switch (choice) {
      case "provider":
        return showProviderPicker();
      case "language":
        return showLanguagePicker();
      case "microphone":
        return showMicrophonePicker();
      case "hotkey":
        return showHotkeyPicker();
      case "doctor":
        return showDoctor();
      case "warmup":
        return warmup();
      case "reload":
        return reload();
      case "config":
        return showConfig();
      default:
        return undefined;
    }
  };

  const disposeLayer = context.keymap.layer(() => {
    const bind = runtime.config.hotkey || false;
    return {
      mode: "global",
      priority: 100,
      commands: [
        {
          id: "voice.record",
          title: t("voice.command.record"),
          description: t("voice.command.record"),
          group: t("voice.category"),
          bind,
          palette: true,
          slash: { name: "voice" },
          run: () => toggleVoice(false),
        },
        {
          id: "voice.send",
          title: t("voice.command.submit"),
          description: t("voice.command.submit"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-send" },
          run: () => toggleVoice(true),
        },
        {
          id: "voice.stop",
          title: t("voice.command.stop"),
          description: t("voice.command.stop"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-stop" },
          run: () => cancelVoice(),
        },
        {
          id: "voice.settings",
          title: t("voice.command.settings"),
          description: t("voice.command.settings"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-settings" },
          run: () => showSettings(),
        },
        {
          id: "voice.doctor",
          title: t("voice.command.doctor"),
          description: t("voice.command.doctor"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-doctor" },
          run: () => showDoctor(),
        },
        {
          id: "voice.reload",
          title: t("voice.command.reload"),
          description: t("voice.command.reload"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-reload" },
          run: () => reload(),
        },
        {
          id: "voice.warmup",
          title: t("voice.command.warmup"),
          description: t("voice.command.warmup"),
          group: t("voice.category"),
          bind: false,
          palette: true,
          slash: { name: "voice-warmup" },
          run: () => warmup(),
        },
      ],
      bindings: ["voice.record"],
    };
  });

  return () => {
    disposed = true;
    try {
      disposeLayer?.();
    } catch {}
    void session?.cancel("dispose");
    runtime.dispose();
  };
}
