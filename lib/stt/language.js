const REGIONS = {
  en: "en-US",
  ru: "ru-RU",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-PT",
  uk: "uk-UA",
  kk: "kk-KZ",
  pl: "pl-PL",
  nl: "nl-NL",
  tr: "tr-TR",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
};

/** `ru-RU` -> `ru`; anything unusable -> undefined (let the model auto-detect). */
export function toShortLanguage(language) {
  if (!language || language === "auto") return undefined;
  const match = /^([A-Za-z]{2,3})(?:[-_].*)?$/.exec(String(language).trim());
  return match ? match[1].toLowerCase() : undefined;
}

/** `ru` -> `ru-RU`, `en-US` -> `en-US`. */
export function toBcp47(language, fallback = "ru-RU") {
  if (!language || language === "auto") return fallback;
  const match = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/.exec(String(language).trim().replace("_", "-"));
  if (!match) return fallback;
  const code = match[1].toLowerCase();
  if (match[2]) return `${code}-${match[2].toUpperCase()}`;
  return REGIONS[code] ?? `${code}-${code.toUpperCase()}`;
}

/** `auto` follows the OS locale (mirrors the VS Code extension's fallback). */
export function resolveLanguage(configured, osLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  if (configured && configured !== "auto") return configured;
  return osLocale || undefined;
}

export function joinTranscript(previous, addition) {
  const next = String(addition ?? "").trim();
  if (!next) return previous;
  if (!previous) return next;
  return `${previous} ${next}`;
}

/** Drops language-tag noise and repeated whitespace. */
export function cleanTranscript(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
