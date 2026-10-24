import { randomUUID } from "node:crypto";
import { int16ToPcmBuffer } from "../audio/wav.js";
import { httpRequest } from "./http.js";

const TOKEN_MARGIN_MS = 60_000;

/** Sber SaluteSpeech recognition (GigaAM acoustic model). */
export class SaluteTranscriber {
  constructor(config) {
    this.config = config;
    this.token = undefined;
  }

  async transcribePcm(pcm, signal) {
    const body = int16ToPcmBuffer(pcm);

    let accessToken = await this.getToken(false, signal);
    let response = await this.recognize(accessToken, body, signal);
    if (response.status === 401) {
      accessToken = await this.getToken(true, signal);
      response = await this.recognize(accessToken, body, signal);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`SaluteSpeech request failed with HTTP ${response.status}: ${response.text.slice(0, 400)}`);
    }

    return parseSaluteResponse(response.text);
  }

  async recognize(token, body, signal) {
    const url = new URL(this.config.recognizeUrl);
    if (!url.searchParams.has("language")) url.searchParams.set("language", this.config.language);
    return httpRequest(url.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/x-pcm;bit=16;rate=16000",
      },
      body,
      timeoutMs: this.config.timeoutMs ?? 60000,
      insecureTLS: this.config.insecureTLS,
      signal,
    });
  }

  async getToken(force, signal) {
    if (!force && this.token && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.token.value;

    const credentials = this.basicCredentials();
    const response = await httpRequest(this.config.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        rquid: randomUUID(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: Buffer.from(`scope=${encodeURIComponent(this.config.scope)}`, "utf8"),
      timeoutMs: this.config.timeoutMs ?? 30000,
      insecureTLS: this.config.insecureTLS,
      signal,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`SaluteSpeech authorization failed with HTTP ${response.status}: ${response.text.slice(0, 400)}`);
    }

    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new Error(`SaluteSpeech authorization returned invalid JSON: ${response.text.slice(0, 400)}`);
    }
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new Error(`SaluteSpeech authorization response has no access_token: ${response.text.slice(0, 400)}`);
    }

    this.token = { value: payload.access_token, expiresAt: normalizeExpiry(payload.expires_at) };
    return this.token.value;
  }

  basicCredentials() {
    if (this.config.authorizationKey) return String(this.config.authorizationKey).trim();
    if (this.config.clientId && this.config.clientSecret) {
      return Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    }
    throw new Error("SaluteSpeech credentials are missing (salute.authorizationKey or clientId + clientSecret)");
  }
}

export function parseSaluteResponse(text) {
  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload.result)) {
      return payload.result.filter((part) => typeof part === "string").join(" ").trim();
    }
    if (typeof payload.message === "string" && payload.status !== undefined) {
      throw new Error(`SaluteSpeech error ${String(payload.status)}: ${payload.message}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SaluteSpeech error")) throw error;
  }
  return String(text).trim();
}

function normalizeExpiry(expiresAt) {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    if (expiresAt > 1e12) return expiresAt;
    if (expiresAt > 1e9) return expiresAt * 1000;
    return Date.now() + expiresAt * 1000;
  }
  return Date.now() + 25 * 60_000;
}
