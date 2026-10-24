import { encodeWav } from "../audio/wav.js";
import { httpRequest } from "./http.js";
import { buildMultipartBody } from "./multipart.js";

export function transcriptionUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (/\/audio\/transcriptions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

/** Accepts `{ "text": ... }`, `[{ "text": ... }]`, a bare JSON string and plain text. */
export function parseTranscriptionResponse(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (item && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join(" ");
    }
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.text === "string") return parsed.text;
      if (typeof parsed.transcription === "string") return parsed.transcription;
    }
  } catch {
    // not JSON: some servers answer with plain text
  }
  return trimmed;
}

export async function transcribePcmOpenAiCompatible(pcm, config, signal) {
  const wav = encodeWav(pcm);
  const fields = {
    model: config.model || "whisper-1",
    language: config.language,
    prompt: config.prompt,
    response_format: "json",
  };

  for (const [key, value] of Object.entries(config.extraBody ?? {})) {
    if (value === undefined || value === null) continue;
    fields[key] = typeof value === "object" ? JSON.stringify(value) : value;
  }

  const { body, contentType } = buildMultipartBody(fields, [
    { field: "file", filename: "audio.wav", contentType: "audio/wav", data: wav },
  ]);

  const headers = { "content-type": contentType, accept: "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const response = await httpRequest(transcriptionUrl(config.baseUrl), {
    method: "POST",
    headers,
    body,
    timeoutMs: config.timeoutMs ?? 60000,
    insecureTLS: config.insecureTLS,
    signal,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Transcription request failed with HTTP ${response.status}: ${response.text.slice(0, 400)}`);
  }

  return parseTranscriptionResponse(response.text).trim();
}
