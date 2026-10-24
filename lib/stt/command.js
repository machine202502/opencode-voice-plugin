import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../audio/wav.js";

/** `${file}` is the recorded WAV, `${out}` an optional text file the command may write. */
export function buildCommandLine(template, file) {
  const outFile = file.replace(/\.wav$/i, "") + ".txt";
  const commandLine = String(template)
    .replace(/\$\{file\}/g, `"${file}"`)
    .replace(/\$\{out\}/g, `"${outFile}"`);
  return { commandLine, outFile };
}

/** Drops whisper.cpp style timestamps such as `[00:00:00.000 --> 00:00:02.000]`. */
export function stripTimestamps(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*[^\]]*]\s*/, ""))
    .join("\n")
    .trim();
}

export async function transcribeWithCommand(pcm, config, signal) {
  if (!config.command || !String(config.command).trim()) {
    throw new Error("command.transcribe is empty: configure a local speech-to-text CLI first");
  }

  const directory = await mkdtemp(join(tmpdir(), `opencode-voice-${randomUUID().slice(0, 8)}-`));
  const file = join(directory, "segment.wav");
  await writeFile(file, encodeWav(pcm));
  const { commandLine, outFile } = buildCommandLine(config.command, file);

  try {
    const stdout = await new Promise((resolve, reject) => {
      exec(
        commandLine,
        {
          timeout: config.timeoutMs ?? 120000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          signal,
          encoding: "utf8",
        },
        (error, out, err) => {
          if (error) {
            const detail = String(err || out || error.message).trim();
            reject(new Error(`Transcription command failed: ${detail || error.message}`));
            return;
          }
          resolve(out ?? "");
        },
      );
    });

    let text = "";
    try {
      text = (await readFile(outFile, "utf8")).trim();
    } catch {
      // command prints to stdout instead
    }

    return (text || config.parse?.(stdout) || stripTimestamps(stdout)).trim();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
