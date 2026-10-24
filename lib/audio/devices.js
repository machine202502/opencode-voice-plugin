import { execFile } from "node:child_process";

export function defaultCaptureFormat(platform = process.platform) {
  switch (platform) {
    case "win32":
      return "dshow";
    case "darwin":
      return "avfoundation";
    default:
      return "pulse";
  }
}

export function resolveCaptureFormat(configured, platform = process.platform) {
  if (["dshow", "avfoundation", "pulse", "alsa"].includes(configured)) return configured;
  return defaultCaptureFormat(platform);
}

/**
 * Parses `ffmpeg -list_devices true -f dshow -i dummy`.
 * Uses the ASCII alternative name when available: localized device names are
 * decoded with the ANSI code page and can be corrupted on Windows.
 */
export function parseDshowDevices(output) {
  const devices = [];
  let last;

  for (const line of String(output).split(/\r?\n/)) {
    const device = /\]\s+"([^"]+)"\s+\((audio|video)\)\s*$/.exec(line.trimEnd());
    if (device) {
      if (last) devices.push(toDevice(last));
      last = { name: device[1], kind: device[2] };
      continue;
    }
    const alternative = /\]\s+Alternative name "([^"]+)"/.exec(line);
    if (alternative && last && !last.alternative) last.alternative = alternative[1];
  }

  if (last) devices.push(toDevice(last));
  return devices;
}

function toDevice(entry) {
  return { name: entry.name, id: entry.alternative ?? entry.name, kind: entry.kind };
}

/** Parses `ffmpeg -f avfoundation -list_devices true -i ""`. */
export function parseAvfoundationDevices(output) {
  const devices = [];
  let section;
  for (const line of String(output).split(/\r?\n/)) {
    if (/AVFoundation video devices:/i.test(line)) {
      section = "video";
      continue;
    }
    if (/AVFoundation audio devices:/i.test(line)) {
      section = "audio";
      continue;
    }
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (match && section) devices.push({ name: match[2], id: match[1], kind: section });
  }
  return devices;
}

/** Parses `pactl list short sources`. */
export function parsePactlSources(output) {
  const devices = [];
  for (const line of String(output).split(/\r?\n/)) {
    const columns = line.split("\t");
    if (columns.length < 2) continue;
    const id = columns[1].trim();
    if (!id || id.endsWith(".monitor")) continue;
    devices.push({ name: id, id, kind: "audio" });
  }
  return devices;
}

export function execFileText(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        // ffmpeg exits non-zero for -list_devices; the output is still useful.
        resolve(`${stdout ?? ""}${stderr ?? ""}${error && !stdout && !stderr ? String(error) : ""}`);
      },
    );
  });
}

export async function listAudioDevices(ffmpegPath, format) {
  switch (format) {
    case "dshow": {
      const output = await execFileText(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 8000);
      return parseDshowDevices(output).filter((device) => device.kind === "audio");
    }
    case "avfoundation": {
      const output = await execFileText(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 8000);
      return parseAvfoundationDevices(output).filter((device) => device.kind === "audio");
    }
    case "pulse": {
      const output = await execFileText("pactl", ["list", "short", "sources"], 4000);
      return parsePactlSources(output);
    }
    case "alsa":
      return [];
    default:
      return [];
  }
}

/** Maps a user supplied device setting (name, index or ffmpeg id) onto a real device. */
export function resolveDevice(devices, configured) {
  const wanted = String(configured ?? "").trim();
  if (devices.length === 0) return wanted;
  if (!wanted) return devices[0].id;

  const index = /^\d+$/.test(wanted) ? Number(wanted) : -1;
  if (index >= 0 && index < devices.length) return devices[index].id;

  const exact = devices.find((device) => device.id === wanted);
  if (exact) return exact.id;
  const lower = wanted.toLowerCase();
  const byName =
    devices.find((device) => device.name.toLowerCase() === lower) ??
    devices.find((device) => device.name.toLowerCase().includes(lower)) ??
    devices.find((device) => device.id.toLowerCase().includes(lower));
  return byName ? byName.id : wanted;
}
