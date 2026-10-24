// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// OpenCode Voice - Content Script
// Injects 🎤 button into OpenCode web UI

// STT-сервер доступен по тому же хосту, что и веб-UI (важно при доступе по
// LAN/IP). Порт по умолчанию 8765, меняется в popup (chrome.storage: sttPort).
// Если порт занят, плагин пробует 8766..8775 — content script находит его сам.
const DEFAULT_STT_PORT = 8765;
let STT_PORT = DEFAULT_STT_PORT;
// Перезаписывается значением max_upload_mb из /health (единый источник — сервер).
let MAX_UPLOAD_MB = 25;
// localhost на Windows может резолвиться в IPv6 ::1, а сервер слушает 127.0.0.1 —
// поэтому для локального случая всегда используем 127.0.0.1 (для LAN/IP не меняем).
const STT_HOST = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
let STT_SERVER = `${location.protocol}//${STT_HOST}:${STT_PORT}`;
// Запоминаем хост, чтобы popup ходил на тот же сервер (важно при доступе по LAN/IP).
try { chrome.storage.local.set({ sttHost: STT_HOST }); } catch {}
function applyPort(p) {
  const port = Number(p) || DEFAULT_STT_PORT;
  if (port !== STT_PORT) {
    STT_PORT = port;
    STT_SERVER = `${location.protocol}//${STT_HOST}:${STT_PORT}`;
  }
}
try {
  chrome.storage.local.get({ sttPort: DEFAULT_STT_PORT }, (v) => applyPort(v.sttPort));
  // Порт меняют в popup уже после загрузки страницы — подхватываем без F5.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sttPort) {
      applyPort(changes.sttPort.newValue);
      serverReady = null;
    }
  });
} catch {}
const LOG_PREFIX = '[OpenCode Voice]';

// «Лог в консоль (отладка)» из popup: без галочки — тихо, ошибки идут
// через console.error и видны всегда.
let debugLog = false;
try {
  chrome.storage.local.get({ ttsDebug: false }, (v) => { debugLog = v.ttsDebug === true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ttsDebug) debugLog = changes.ttsDebug.newValue === true;
  });
} catch {}

function log(...args) {
  if (debugLog) console.log(LOG_PREFIX, ...args);
}

function showToast(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.opencode-voice-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `opencode-voice-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Store found input to avoid re-searching (which might find terminal)
let foundInput = null;

function findPromptInput() {
  // Get ALL contenteditable elements and pick the real prompt input.
  // Terminal input has data-component="terminal" and class "font-mono" - exclude it.
  const all = document.querySelectorAll('[contenteditable="true"]');

  for (const el of all) {
    const component = el.getAttribute('data-component') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const cls = typeof el.className === 'string' ? el.className : '';

    // Explicitly skip terminal
    if (component === 'terminal') continue;
    if (/terminal/i.test(ariaLabel)) continue;
    if (/font-mono/.test(cls)) continue;

    // Prefer the real prompt input
    const isPrompt = component === 'prompt-input' ||
                     /Промпт|Prompt/i.test(ariaLabel) ||
                     /min-h-\[60px\]/.test(cls) ||
                     /whitespace-pre-wrap/.test(cls);

    if (!isPrompt) continue;

    // Skip hidden elements
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const isVisible = rect.width > 50 &&
                      rect.height > 20 &&
                      style.opacity !== '0' &&
                      style.visibility !== 'hidden' &&
                      style.display !== 'none' &&
                      !style.clipPath?.includes('inset');

    if (isVisible) {
      log('Found prompt input:', el);
      foundInput = el;
      return el;
    }
  }
  return null;
}

function findContainer(input) {
  // Prefer the prompt form
  const form = input.closest('form[data-component="prompt-input-v2"]') ||
               input.closest('form') ||
               input.closest('[data-component="prompt-input-v2"]');
  if (form) return form;

  let el = input.parentElement;
  for (let i = 0; i < 10 && el; i++) {
    const classes = typeof el.className === 'string' ? el.className : '';
    if (
      classes.includes('prompt') ||
      classes.includes('composer') ||
      el.tagName === 'FORM'
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return input.parentElement;
}

function insertText(text) {
  const input = foundInput || findPromptInput();
  if (!input) {
    showToast('Поле ввода не найдено', 'error');
    return false;
  }

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (input.isContentEditable) {
    // Place caret at the end so caret-based insertion works
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // execCommand triggers proper input events the UI framework listens to
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }

    if (!ok) {
      // Fallback: manual DOM insert + input event
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    return true;
  }
  return false;
}

// Найти панель инструментов (где кнопка «Отправить») внутри формы
function findToolbar(input) {
  const form = input.closest('form') || input.closest('[data-component="prompt-input-v2"]') || input.parentElement;

  // Кнопка отправки — самый надёжный ориентир
  const submit =
    form.querySelector('button[type="submit"]') ||
    form.querySelector('button[aria-label*="Отправ"]') ||
    form.querySelector('button[aria-label*="Send"]') ||
    form.querySelector('button[title*="Отправ"]') ||
    form.querySelector('button[title*="Send"]');

  if (submit && submit.parentElement) {
    return { parent: submit.parentElement, before: submit };
  }

  // Иначе — последняя кнопка в форме
  const buttons = form.querySelectorAll('button');
  if (buttons.length) {
    const last = buttons[buttons.length - 1];
    return { parent: last.parentElement, before: last };
  }

  // Fallback: сама форма
  return { parent: form, before: null };
}

// Отправить текущее содержимое поля ввода (кнопка «Отправить» или Enter).
// Используется хоткеем Alt+X, чтобы не набирать текст руками.
async function submitPrompt() {
  const input = foundInput || findPromptInput();
  if (!input) return false;
  // Дать фреймворку включить кнопку отправки после события input.
  await new Promise((r) => setTimeout(r, 300));
  const { before } = findToolbar(input);
  if (before && !before.disabled && before.getAttribute('aria-disabled') !== 'true') {
    before.click();
    return true;
  }
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  input.dispatchEvent(new KeyboardEvent('keydown', opts));
  input.dispatchEvent(new KeyboardEvent('keypress', opts));
  input.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
}

// --- Гибридная запись: микрофон браузера, при неудаче — локальный сервер ---

// Звуковая индикация (как в /voice): сигнал проигрывает локальный сервер
// (880 Гц — старт, 520 Гц — конец записи, 660 Гц — распознавание завершено).
// Отключается переключателем в popup расширения (chrome.storage.local.beeps).
let beepsEnabled = true;
try {
  chrome.storage.local.get({ beeps: true }, (v) => { beepsEnabled = v.beeps !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.beeps) beepsEnabled = changes.beeps.newValue !== false;
  });
} catch {}

// Опциональный токен доступа (если на сервере задан OPENCODE_VOICE_TOKEN).
let voiceToken = '';
const tokenReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get({ token: '' }, (v) => { voiceToken = v.token || ''; resolve(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.token) voiceToken = changes.token.newValue || '';
    });
  } catch { resolve(); }
});

function authHeaders() {
  const h = { 'X-Voice-Source': 'button' };
  if (voiceToken) h['X-Voice-Token'] = voiceToken;
  return h;
}

// --- Поиск сервера: порт по умолчанию, затем 8766..8775 ---
let serverReady = null;
async function probeHealth(port) {
  const url = `${location.protocol}//${STT_HOST}:${port}`;
  const res = await fetch(`${url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(700) });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && (data.ok || data.name === 'opencode-voice') ? { port, data } : null;
}
async function discoverServer() {
  const stored = await new Promise((resolve) => {
    try { chrome.storage.local.get({ sttPort: DEFAULT_STT_PORT }, (v) => resolve(Number(v.sttPort) || DEFAULT_STT_PORT)); }
    catch { resolve(DEFAULT_STT_PORT); }
  });
  const candidates = [stored, ...Array.from({ length: 11 }, (_, i) => DEFAULT_STT_PORT + i)];
  for (const port of [...new Set(candidates)]) {
    try {
      const found = await probeHealth(port);
      if (!found) continue;
      applyPort(port);
      if (Number.isFinite(found.data.max_upload_mb) && found.data.max_upload_mb > 0) {
        MAX_UPLOAD_MB = found.data.max_upload_mb;
      }
      log(`STT server found on port ${port}`, found.data);
      return true;
    } catch {}
  }
  applyPort(stored);
  log('STT server not found; will use configured port', STT_PORT);
  return false;
}
async function ensureServer() {
  if (!serverReady) serverReady = discoverServer();
  const ok = await serverReady;
  if (!ok) serverReady = null; // retry on the next request
  return ok;
}

function beep(freq = 880) {
  if (!beepsEnabled) return;
  try {
    void tokenReady.then(() =>
      fetch(`${STT_SERVER}/beep?freq=${freq}`, { method: 'GET', headers: authHeaders() }).catch(() => {})
    );
  } catch {}
}

async function startCapture() {
  // 1. Микрофон браузера (работает, когда Windows/RDP отдаёт микрофон)
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(250);
      log('Запись: микрофон браузера');
      return { mode: 'browser', stream, recorder, chunks };
    } catch (e) {
      console.error(LOG_PREFIX, 'Микрофон браузера недоступен:', e.name, e.message);
    }
  }

  // 2. Запись на сервере (ffmpeg DirectShow/AVFoundation/Pulse)
  const startReq = async () => { await ensureServer(); await tokenReady; return fetch(`${STT_SERVER}/record/start`, { method: 'POST', headers: authHeaders() }); };
  const stopReq = async () => { await ensureServer(); await tokenReady; return fetch(`${STT_SERVER}/record/stop`, { method: 'POST', headers: authHeaders() }); };

  let res;
  try {
    res = await startReq();
  } catch (e) {
    throw new Error(`нет микрофона — браузер недоступен, STT-сервер не отвечает (${e.message})`);
  }

  // 409 = на сервере осталась «зависшая» запись с прошлого раза (клиент не вызвал
  // /record/stop). Сбрасываем её и пробуем стартовать заново.
  if (res.status === 409) {
    log('Сервер уже пишет — сбрасываю зависшую запись и пробую снова');
    try { await stopReq(); } catch {}
    try {
      res = await startReq();
    } catch (e) {
      throw new Error(`STT-сервер не отвечает (${e.message})`);
    }
  }

  if (res.status === 409) {
    const err = new Error('на сервере уже идёт запись');
    err.alreadyRecording = true;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  log('Запись: локальный сервер');
  return { mode: 'server' };
}

function stopBrowserCapture(session) {
  return new Promise((resolve) => {
    session.recorder.onstop = () => {
      session.stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(session.chunks, { type: session.recorder.mimeType || 'audio/webm' }));
    };
    session.recorder.stop();
  });
}

// Понятные сообщения на защитные ответы сервера (лимиты/таймауты).
function friendlyError(status, fallback) {
  if (status === 413) return `Запись слишком большая (лимит ${MAX_UPLOAD_MB} МБ)`;
  if (status === 429) return 'Сервер занят — попробуй ещё раз через пару секунд';
  if (status === 504) return 'Распознавание заняло слишком долго';
  if (status === 403) return 'Запрос отклонён (origin) — перезагрузи расширение';
  return fallback;
}

async function transcribeBlob(blob) {
  if (blob.size > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`Запись слишком большая (лимит ${MAX_UPLOAD_MB} МБ)`);
  }
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  await ensureServer();
  await tokenReady;
  const res = await fetch(`${STT_SERVER}/transcribe`, { method: 'POST', body: fd, headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(res.status, data.error || `HTTP ${res.status}`));
  return (data.text || '').trim();
}

async function stopServerCapture() {
  await ensureServer();
  await tokenReady;
  const res = await fetch(`${STT_SERVER}/record/stop`, { method: 'POST', headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(res.status, data.error || `HTTP ${res.status}`));
  return (data.text || '').trim();
}

// --- Состояние записи (живёт вне кнопки — переживает перерендер UI) ---
let captureSession = null;  // {mode, stream, recorder, chunks}
let stopSignal = null;      // resolve() для остановки
let uiPhase = 'idle';       // idle | recording | processing

// При уходе со страницы не оставляем серверную запись висеть (иначе следующий
// /record/start получит 409 «already recording»).
window.addEventListener('pagehide', () => {
  if (uiPhase === 'recording' && captureSession?.mode === 'server') {
    try { fetch(`${STT_SERVER}/record/stop`, { method: 'POST', keepalive: true, headers: authHeaders() }); } catch {}
  }
});

function applyButtonState(btn) {
  if (!btn) return;
  btn.classList.remove('recording', 'processing');
  if (uiPhase === 'recording') {
    btn.classList.add('recording');
    btn.textContent = '⏺';
    btn.title = 'Идёт запись — нажми, чтобы остановить';
  } else if (uiPhase === 'processing') {
    btn.classList.add('processing');
    btn.textContent = '🧠';
    btn.title = 'Распознаю речь...';
  } else {
    btn.textContent = '🎤';
    btn.title = 'Voice: записать и распознать';
  }
}

function syncButton() {
  applyButtonState(document.querySelector('#opencode-voice-btn'));
}

// Стабильный обработчик: клик либо начинает, либо останавливает
function onVoiceClick(btn) {
  if (uiPhase === 'recording') {
    if (stopSignal) stopSignal();
    return;
  }
  if (uiPhase === 'processing') return; // игнорируем клики во время распознавания
  runRecordingFlow(btn);
}

// Push-to-talk hotkey: hold the configured combo (page-level; only where the 🎤 button exists).
// Default Alt+Z. Stop happens on the key release, on releasing Alt first (the browser
// often swallows the Z keyup), on Escape, on blur/hidden, and via a safety timeout.
const HOTKEYS = {
  'alt+z': { label: 'Alt+Z', code: 'KeyZ', alt: true },
  'ctrl+shift+z': { label: 'Ctrl+Shift+Z', code: 'KeyZ', ctrl: true, shift: true },
  'alt+q': { label: 'Alt+Q', code: 'KeyQ', alt: true },
  'f9': { label: 'F9', code: 'F9' },
};
const DEFAULT_HOTKEY = 'alt+z';
const HOTKEY_MAX_MS = 120000; // safety net: never leave a recording running forever
// Separate hold combo: record, insert and send at once (bypasses the input box).
const SEND_HOTKEY = { label: 'Alt+X', code: 'KeyX', alt: true };
let hotkey = HOTKEYS[DEFAULT_HOTKEY];
let hotkeyActive = false;
let hotkeyStopPending = false;
let hotkeySafetyTimer = null;
let activeHotkey = null;      // combo currently held (configured one or Alt+X)
let hotkeyMode = 'insert';    // 'insert' | 'send' for the current recording
let sendHotkeyEnabled = true;

chrome.storage.local.get({ hotkey: DEFAULT_HOTKEY, sendHotkey: true }, (v) => {
  hotkey = HOTKEYS[v.hotkey] || HOTKEYS[DEFAULT_HOTKEY];
  sendHotkeyEnabled = v.sendHotkey !== false;
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.hotkey) hotkey = HOTKEYS[ch.hotkey.newValue] || HOTKEYS[DEFAULT_HOTKEY];
  if (ch.sendHotkey) sendHotkeyEnabled = ch.sendHotkey.newValue !== false;
});

function hotkeyButton() {
  return document.querySelector('#opencode-voice-btn');
}

function comboMatches(e, c) {
  return e.code === c.code
    && !!e.altKey === !!c.alt
    && !!e.ctrlKey === !!c.ctrl
    && !!e.shiftKey === !!c.shift
    && !!e.metaKey === !!c.meta;
}

function hotkeyMatches(e) {
  return comboMatches(e, hotkey);
}

function hotkeyStop(reason) {
  if (!hotkeyActive) return;
  hotkeyActive = false;
  if (hotkeySafetyTimer) {
    clearTimeout(hotkeySafetyTimer);
    hotkeySafetyTimer = null;
  }
  log(`Hotkey: stop (${reason})`);
  if (uiPhase !== 'recording') return;
  // Released before runRecordingFlow armed stopSignal (very short hold):
  // remember it and stop right after the capture starts, otherwise the
  // recording would keep running with no way to stop it.
  if (!stopSignal) {
    hotkeyStopPending = true;
    return;
  }
  const btn = hotkeyButton();
  if (btn) onVoiceClick(btn);
}

window.addEventListener('keydown', (e) => {
  if (hotkeyActive) {
    if (e.code === 'Escape') {
      e.preventDefault();
      hotkeyStop('escape');
    }
    return;
  }
  if (e.repeat) return;
  let combo = null;
  let mode = 'insert';
  if (hotkeyMatches(e)) {
    combo = hotkey;
  } else if (sendHotkeyEnabled && comboMatches(e, SEND_HOTKEY)) {
    combo = SEND_HOTKEY;
    mode = 'send';
  }
  if (!combo) return;
  const btn = hotkeyButton();
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (uiPhase !== 'idle') return;
  hotkeyActive = true;
  activeHotkey = combo;
  hotkeyMode = mode;
  hotkeyStopPending = false;
  hotkeySafetyTimer = setTimeout(() => hotkeyStop('safety-timeout'), HOTKEY_MAX_MS);
  log(`Hotkey: start (hold ${combo.label}${mode === 'send' ? ', send' : ''})`);
  onVoiceClick(btn);
}, true);

window.addEventListener('keyup', (e) => {
  if (!hotkeyActive || !activeHotkey) return;
  // Stop on the hotkey itself or on releasing Alt first: Windows/Chrome can route
  // the Alt keyup (and the following keyup) to the browser menu, so the page never
  // sees the second key's keyup and the recording would hang.
  const matchedKey = e.code === activeHotkey.code;
  const releasedAlt = activeHotkey.alt && (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight');
  if (matchedKey || releasedAlt) {
    e.preventDefault();
    hotkeyStop(matchedKey ? 'keyup' : 'modifier-release');
  }
}, true);

// Released while the window lost focus / the tab is hidden -> stop gracefully.
window.addEventListener('blur', () => hotkeyStop('blur'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hotkeyStop('hidden');
});

async function runRecordingFlow(btn) {
  uiPhase = 'recording';
  applyButtonState(btn);
  // Alt+X (или галочка в popup) — после распознавания сразу отправляем запрос.
  const sendAfter = hotkeyMode === 'send';
  hotkeyMode = 'insert';

  // Старт захвата
  try {
    captureSession = await startCapture();
  } catch (err) {
    // 409 от сервера = на сервере уже идёт запись (зависла) — переключаемся в режим стопа
    if (err.alreadyRecording) {
      log('Сервер уже пишет — переключаюсь в режим остановки');
      captureSession = { mode: 'server' };
    } else {
      console.error(LOG_PREFIX, 'Error:', err);
      showToast(`❌ Не удалось начать запись: ${err.message}`, 'error', 6000);
      uiPhase = 'idle';
      applyButtonState(btn);
      return;
    }
  }

  beep(880);
  const isBrowser = captureSession.mode === 'browser';
  showToast(isBrowser ? '🎙 Запись (микрофон браузера)...' : '🎙 Запись (локальный движок)...', 'info', 5000);

  // Таймер
  const start = Date.now();
  const timer = setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const b = document.querySelector('#opencode-voice-btn');
    if (b) b.title = `Идёт запись: ${sec} сек — нажми, чтобы остановить`;
    if (sec > 0 && sec % 5 === 0) showToast(`🎙 Запись: ${sec} сек`, 'info', 1200);
  }, 1000);

  // Ждём второй клик
  await new Promise((resolve) => {
    stopSignal = resolve;
    if (hotkeyStopPending) {
      hotkeyStopPending = false;
      resolve();
    }
  });
  stopSignal = null;
  clearInterval(timer);
  beep(520);

  // Фаза распознавания
  uiPhase = 'processing';
  syncButton();
  showToast('🧠 Распознаю речь...', 'warning', 10000);

  try {
    const text = isBrowser
      ? await transcribeBlob(await stopBrowserCapture(captureSession))
      : await stopServerCapture();

    if (text) {
      beep(660);
      if (insertText(text)) {
        if (sendAfter) {
          const ok = await submitPrompt();
          showToast(ok ? `📨 Отправлено: "${text.slice(0, 60)}"` : `✅ Готово: "${text.slice(0, 60)}"`, ok ? 'success' : 'warning');
        } else {
          showToast(`✅ Готово: "${text.slice(0, 60)}"`, 'success');
        }
      }
    } else {
      showToast('Речь не распознана', 'warning');
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Error:', err);
    showToast(`❌ Ошибка: ${err.message}`, 'error', 6000);
  } finally {
    captureSession = null;
    uiPhase = 'idle';
    syncButton();
  }
}

function addVoiceButton() {
  if (document.querySelector('#opencode-voice-btn')) return true;

  const input = foundInput || findPromptInput();
  if (!input) {
    log('Prompt input not found yet');
    return false;
  }

  const btn = document.createElement('button');
  btn.id = 'opencode-voice-btn';
  btn.type = 'button';
  btn.innerHTML = '🎤';
  btn.title = 'Voice: записать и распознать';
  btn.onclick = () => onVoiceClick(btn);

  // Try to place next to the Send button
  try {
    const { parent, before } = findToolbar(input);
    log('Toolbar:', parent, 'before:', before);
    if (before && before.parentElement === parent) {
      parent.insertBefore(btn, before);
    } else {
      parent.appendChild(btn);
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Toolbar placement failed, fell back to form:', err);
    const container = findContainer(input);
    container.appendChild(btn);
  }

  applyButtonState(btn); // восстановить состояние после перерендера
  log('Voice button added!', 'phase:', uiPhase);
  return true;
}

// Re-add button if it was removed (e.g. prompt re-rendered)
let scheduled = false;
function scheduleAdd() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    // Only re-add if the prompt input is still in the DOM but button missing
    if (foundInput && document.contains(foundInput) && !document.querySelector('#opencode-voice-btn')) {
      addVoiceButton();
    } else if (!foundInput || !document.contains(foundInput)) {
      foundInput = null;
      addVoiceButton();
    }
  }, 300);
}

const observer = new MutationObserver(scheduleAdd);
observer.observe(document.body, { childList: true, subtree: true });

// Try to add button immediately
addVoiceButton();

log('Content script loaded, waiting for UI...');

// Диагностика: подтверждаем, что загружена именно эта версия (видно в консоли
// страницы и в логе сервера как beep freq=0).
void (async () => {
  try {
    const found = await ensureServer();
    await tokenReady;
    console.log(`[OpenCode Voice] content.js loaded; server ${found ? STT_SERVER : 'not found yet'}`);
    if (!found) return;
    fetch(`${STT_SERVER}/beep?freq=0`, { method: 'GET', headers: authHeaders() }).catch(() => {});
    fetch(`${STT_SERVER}/health`, { method: 'GET', headers: authHeaders() })
      .then((r) => r.json())
      .then((h) => {
        if (Number.isFinite(h.max_upload_mb) && h.max_upload_mb > 0) MAX_UPLOAD_MB = h.max_upload_mb;
        console.log(`[OpenCode Voice] server v${h.version || '?'} · ${h.backend || '?'}/${h.device || '?'} · auth=${h.auth} · max ${MAX_UPLOAD_MB}MB`);
      })
      .catch(() => {});
  } catch {}
})();