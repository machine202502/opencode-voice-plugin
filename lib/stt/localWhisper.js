import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome } from "../paths.js";

/** Most capable first: `ggml-large-v3-turbo.bin` wins over `ggml-small.bin`. */
const MODEL_PREFERENCE = ["turbo", "large-v3", "large-v2", "large", "medium", "small", "base", "tiny"];

/** Accepts a `.bin` model file or a folder with several models. */
export function resolveModelFile(modelPath) {
  const value = expandHome(modelPath);
  if (!value) return undefined;

  let stats;
  try {
    stats = statSync(value);
  } catch {
    return undefined;
  }
  if (stats.isFile()) return resolve(value);
  if (!stats.isDirectory()) return undefined;

  let entries;
  try {
    entries = readdirSync(value);
  } catch {
    return undefined;
  }

  const models = entries.filter((name) => /\.bin$/i.test(name));
  if (models.length === 0) return undefined;

  const ranked = models
    .map((name) => ({ name, score: modelScore(name) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));

  const picked = ranked[0]?.name ?? [...models].sort()[0];
  return resolve(join(value, picked));
}

export function modelScore(fileName) {
  const lower = String(fileName).toLowerCase();
  return MODEL_PREFERENCE.findIndex((token) => lower.includes(token));
}

export function executableNames(platform = process.platform) {
  return platform === "win32" ? ["whisper-cli.exe", "main.exe", "whisper.exe"] : ["whisper-cli", "main", "whisper"];
}

/** Looks for whisper-cli next to the model, in build/bin, then on PATH. */
export function findWhisperExecutable({ explicit, modelFile, pathEnv = process.env.PATH ?? "", platform = process.platform }) {
  const configured = explicit ? expandHome(explicit) : "";
  if (configured) {
    if (existsSync(configured)) return resolve(configured);
    const name = basename(configured);
    const names = platform === "win32" && !/\.exe$/i.test(name) ? [`${name}.exe`, name] : [name];
    return searchDirectories(pathDirectories(pathEnv, platform), names);
  }

  const modelDirectory = dirname(modelFile);
  const candidates = [
    modelDirectory,
    join(modelDirectory, "bin"),
    dirname(modelDirectory),
    join(dirname(modelDirectory), "bin"),
    join(dirname(modelDirectory), "build", "bin"),
    join(dirname(modelDirectory), "bin", "Release"),
    join(dirname(modelDirectory), "Release"),
  ];

  return (
    searchDirectories(candidates, executableNames(platform)) ??
    searchDirectories(pathDirectories(pathEnv, platform), executableNames(platform))
  );
}

export function buildLocalWhisperCommand({ executable, modelFile, language, extraArgs }) {
  const parts = [
    quote(executable),
    "-m",
    quote(modelFile),
    "-f",
    "${file}",
    "-l",
    language || "auto",
    "-nt",
  ];
  const extra = String(extraArgs ?? "").trim();
  if (extra) parts.push(extra);
  return parts.join(" ");
}

function searchDirectories(directories, names) {
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function pathDirectories(pathEnv, platform) {
  return String(pathEnv)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function quote(value) {
  return `"${value}"`;
}
