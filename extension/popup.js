// OpenCode Voice — popup logic. No frameworks, no build step.

const I18N = {
  ru: {
    statusChecking: "Проверяю сервер…",
    statusHint: "Локальный сервер плагина OpenCode Voice",
    statusOk: "Сервер доступен",
    statusErr: "Сервер не отвечает",
    statusFound: "Найден на порту {0}",
    statusProvider: "{0} · язык {1} · {2}",
    port: "Порт сервера",
    portHint: "По умолчанию 8765. Если занят, плагин берёт следующий свободный порт — кнопка «Проверить» найдёт его.",
    token: "Токен (необязательно)",
    tokenHint: "Совпадает с server.token в voice.json. Нужен только если сервер слушает не только localhost.",
    hotkey: "Push-to-talk на странице",
    sendHotkey: "Alt+X — записать и сразу отправить",
    beeps: "Звуковые сигналы",
    debug: "Лог в консоль (отладка)",
    save: "Сохранить",
    heal: "Перезапустить движок",
    usage: "Кнопка 🎤 появляется у поля ввода OpenCode. Запись идёт с микрофона браузера; если браузер не даёт доступ — с микрофона машины через ffmpeg.",
    saved: "Сохранено",
    test: "Проверить",
    healStarted: "Движок перезапускается…",
    healDone: "Готово — сервер отвечает",
    healFailed: "Не удалось перезапустить: {0}",
    auth: "токен задан",
    noAuth: "без токена",
    recording: "· идёт запись",
  },
  en: {
    statusChecking: "Checking the server…",
    statusHint: "Local server of the OpenCode Voice plugin",
    statusOk: "Server is reachable",
    statusErr: "Server is not responding",
    statusFound: "Found on port {0}",
    statusProvider: "{0} · language {1} · {2}",
    port: "Server port",
    portHint: "8765 by default. If it is busy, the plugin takes the next free port — press Check to find it.",
    token: "Token (optional)",
    tokenHint: "Must match server.token in voice.json. Only needed when the server listens beyond localhost.",
    hotkey: "In-page push-to-talk",
    sendHotkey: "Alt+X — record and send immediately",
    beeps: "Sound cues",
    debug: "Console log (debug)",
    save: "Save",
    heal: "Restart engine",
    usage: "The 🎤 button appears next to the OpenCode prompt. Audio is captured by the browser; if the browser blocks the mic, the local ffmpeg recorder is used.",
    saved: "Saved",
    test: "Check",
    healStarted: "Restarting the engine…",
    healDone: "Done — the server is back",
    healFailed: "Restart failed: {0}",
    auth: "token set",
    noAuth: "no token",
    recording: "· recording",
  },
};

const $ = (id) => document.getElementById(id);
let lang = "ru";

function t(key, ...args) {
  const template = (I18N[lang] || I18N.en)[key] ?? I18N.en[key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ""));
}

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  $("uiLang").value = lang;
}

function setMessage(text, kind = "") {
  const element = $("message");
  element.textContent = text || "";
  element.className = kind;
}

function setStatus(kind, title, detail = "") {
  $("statusDot").className = `dot ${kind}`;
  $("statusTitle").textContent = title;
  if (detail) $("statusDetail").textContent = detail;
}

async function probe(port, token, timeoutMs = 900) {
  const headers = token ? { "X-Voice-Token": token } : {};
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && (data.ok || data.name === "opencode-voice") ? data : null;
}

async function findServer(preferredPort, token) {
  const candidates = [Number(preferredPort) || 8765, ...Array.from({ length: 11 }, (_, index) => 8765 + index)];
  for (const port of [...new Set(candidates)]) {
    try {
      const health = await probe(port, token);
      if (health) return { port, health };
    } catch {
      // next port
    }
  }
  return null;
}

async function checkServer({ updateMessage = false } = {}) {
  setStatus("", t("statusChecking"), t("statusHint"));
  const token = $("token").value.trim();
  const found = await findServer($("port").value, token);
  if (!found) {
    setStatus("err", t("statusErr"), `http://127.0.0.1:${$("port").value}`);
    if (updateMessage) setMessage(t("statusErr"), "error");
    return null;
  }

  $("port").value = String(found.port);
  const health = found.health;
  const auth = health.auth ? t("auth") : t("noAuth");
  setStatus(
    "ok",
    t("statusOk"),
    t("statusProvider", health.label || health.provider || "?", health.language || "auto", auth) +
      (health.recording ? ` ${t("recording")}` : ""),
  );
  if (updateMessage) setMessage(t("statusFound", found.port), "ok");
  return health;
}

async function save() {
  const values = {
    sttPort: Number($("port").value) || 8765,
    token: $("token").value.trim(),
    hotkey: $("hotkey").value,
    sendHotkey: $("sendHotkey").checked,
    beeps: $("beeps").checked,
    ttsDebug: $("debug").checked,
    uiLang: lang,
  };
  await chrome.storage.local.set(values);
  setMessage(t("saved"), "ok");
  await checkServer();
}

async function heal() {
  const port = Number($("port").value) || 8765;
  const token = $("token").value.trim();
  const headers = token ? { "X-Voice-Token": token } : {};
  setMessage(t("healStarted"));
  try {
    await fetch(`http://127.0.0.1:${port}/heal`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15000),
    });
    // The server reloads config and re-warms the model; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const health = await checkServer();
    setMessage(health ? t("healDone") : t("healFailed", t("statusErr")), health ? "ok" : "error");
  } catch (error) {
    setMessage(t("healFailed", error?.message || String(error)), "error");
  }
}

async function init() {
  const stored = await chrome.storage.local.get({
    sttPort: 8765,
    token: "",
    hotkey: "alt+z",
    sendHotkey: true,
    beeps: true,
    ttsDebug: false,
    uiLang: "",
  });

  lang = stored.uiLang === "ru" || stored.uiLang === "en" ? stored.uiLang : (navigator.language || "").toLowerCase().startsWith("ru") ? "ru" : "en";
  $("port").value = String(stored.sttPort || 8765);
  $("token").value = stored.token || "";
  $("hotkey").value = stored.hotkey || "alt+z";
  $("sendHotkey").checked = stored.sendHotkey !== false;
  $("beeps").checked = stored.beeps !== false;
  $("debug").checked = stored.ttsDebug === true;

  applyLanguage();
  await checkServer();
}

$("uiLang").addEventListener("change", () => {
  lang = $("uiLang").value;
  applyLanguage();
  void chrome.storage.local.set({ uiLang: lang });
  void checkServer();
});
$("save").addEventListener("click", () => void save());
$("test").addEventListener("click", () => void checkServer({ updateMessage: true }));
$("heal").addEventListener("click", () => void heal());
void init();
