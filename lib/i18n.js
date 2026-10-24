const RU = {
  "voice.title": "Voice",
  "voice.listening": "🎤 Слушаю… (ещё раз — остановить)",
  "voice.listeningShort": "🎤 Слушаю…",
  "voice.transcribing": "🧠 Распознаю…",
  "voice.inserted": "✅ Вставлено: {0}",
  "voice.noSpeech": "Речь не распознана",
  "voice.cancelled": "Запись отменена",
  "voice.alreadyRecording": "Запись уже идёт",
  "voice.error": "Ошибка: {0}",
  "voice.provider": "Провайдер",
  "voice.language": "Язык",
  "voice.microphone": "Микрофон",
  "voice.hotkey": "Горячая клавиша",
  "voice.settings": "Настройки голосового ввода",
  "voice.doctor": "Диагностика",
  "voice.reload": "Перечитать voice.json",
  "voice.warmup": "Прогреть движок",
  "voice.configFile": "Файл настроек",
  "voice.automatic": "Автоматически (первый вход)",
  "voice.custom": "Другое…",
  "voice.saved": "Сохранено",
  "voice.ready": "Готово",
  "voice.warming": "⏳ Запускаю движок…",
  "voice.warm": "Движок готов: {0}",
  "voice.reloaded": "Настройки перечитаны",
  "voice.configMissing": "voice.json ещё не создан — будут использованы настройки по умолчанию",
  "voice.hint": "Нажмите {0}, чтобы начать и остановить запись",
  "voice.recordingStopped": "Запись остановлена",
  "voice.startFailed": "Не удалось начать запись: {0}",
  "voice.command.record": "Voice: записать и вставить текст",
  "voice.command.submit": "Voice: записать и отправить",
  "voice.command.stop": "Voice: отменить запись",
  "voice.command.settings": "Voice: настройки",
  "voice.command.doctor": "Voice: диагностика",
  "voice.command.reload": "Voice: перечитать настройки",
  "voice.command.warmup": "Voice: прогреть распознавание",
  "voice.category": "Voice",
};

const EN = {
  "voice.title": "Voice",
  "voice.listening": "🎤 Listening… (press again to stop)",
  "voice.listeningShort": "🎤 Listening…",
  "voice.transcribing": "🧠 Transcribing…",
  "voice.inserted": "✅ Inserted: {0}",
  "voice.noSpeech": "No speech recognized",
  "voice.cancelled": "Recording cancelled",
  "voice.alreadyRecording": "Already recording",
  "voice.error": "Error: {0}",
  "voice.provider": "Provider",
  "voice.language": "Language",
  "voice.microphone": "Microphone",
  "voice.hotkey": "Hotkey",
  "voice.settings": "Voice input settings",
  "voice.doctor": "Diagnostics",
  "voice.reload": "Reload voice.json",
  "voice.warmup": "Warm up engine",
  "voice.configFile": "Config file",
  "voice.automatic": "Automatic (first input)",
  "voice.custom": "Custom…",
  "voice.saved": "Saved",
  "voice.ready": "Ready",
  "voice.warming": "⏳ Starting the engine…",
  "voice.warm": "Engine ready: {0}",
  "voice.reloaded": "Settings reloaded",
  "voice.configMissing": "voice.json does not exist yet — defaults are used",
  "voice.hint": "Press {0} to start and stop recording",
  "voice.recordingStopped": "Recording stopped",
  "voice.startFailed": "Could not start recording: {0}",
  "voice.command.record": "Voice: record and insert text",
  "voice.command.submit": "Voice: record and submit",
  "voice.command.stop": "Voice: cancel recording",
  "voice.command.settings": "Voice: settings",
  "voice.command.doctor": "Voice: diagnostics",
  "voice.command.reload": "Voice: reload settings",
  "voice.command.warmup": "Voice: warm up recognition",
  "voice.category": "Voice",
};

export function detectUiLanguage(configured = "auto") {
  if (configured === "ru" || configured === "en") return configured;
  const raw = String(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase();
  if (raw.startsWith("ru")) return "ru";
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.startsWith("ru")) return "ru";
  } catch {}
  return "en";
}

export function createTranslator(language) {
  const dictionary = language === "ru" ? RU : EN;
  return (key, ...args) => {
    const template = dictionary[key] ?? EN[key] ?? key;
    return template.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ""));
  };
}
