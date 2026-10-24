import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PCM_SAMPLE_RATE } from "../audio/wav.js";
import { expandHome } from "../paths.js";
import { WebSocketClient } from "./websocket.js";

const PAYLOAD_CHUNK = 10240;
const START_TIMEOUT_MS = 60000;
const REQUEST_TIMEOUT_MS = 120000;

/** Resolves a sherpa-onnx NeMo/CTC ASR model (folder or .onnx file). */
export function resolveOnnxModel(modelPath, { precision = "auto" } = {}) {
  const value = expandHome(modelPath);
  if (!value) return undefined;

  let stats;
  try {
    stats = statSync(value);
  } catch {
    return undefined;
  }

  if (stats.isFile()) {
    if (!/\.onnx$/i.test(value)) return undefined;
    const tokens = findTokensFile(dirname(value)) ?? findTokensFile(join(dirname(value), ".."));
    return tokens ? { modelFile: resolve(value), tokensFile: tokens } : undefined;
  }
  if (!stats.isDirectory()) return undefined;

  let entries;
  try {
    entries = readdirSync(value);
  } catch {
    return undefined;
  }

  const tokensFile = entries.find((name) => /^tokens.*\.txt$/i.test(name)) ?? entries.find((name) => /\.txt$/i.test(name));
  if (!tokensFile) return undefined;

  const models = entries.filter((name) => /\.onnx$/i.test(name));
  const modelFile = pickModel(models, precision);
  if (!modelFile) return undefined;

  return { modelFile: resolve(join(value, modelFile)), tokensFile: resolve(join(value, tokensFile)) };
}

function findTokensFile(directory) {
  try {
    const name = readdirSync(directory).find((entry) => /^tokens.*\.txt$/i.test(entry));
    return name ? resolve(join(directory, name)) : undefined;
  } catch {
    return undefined;
  }
}

/** `auto` prefers the int8 CTC build, then fp32; RNNT triplets are skipped. */
export function pickModel(models, precision) {
  if (models.length === 0) return undefined;
  const byName = (pattern) => models.find((name) => pattern.test(name));

  if (precision === "fp32") {
    const fp32 = models.filter((name) => !/int8/i.test(name) && !/_(encoder|decoder|joint)\.onnx$/i.test(name));
    return fp32[0] ?? models[0];
  }
  if (precision === "int8") return byName(/int8/i) ?? models[0];

  const ctc = models.filter((name) => /ctc/i.test(name));
  const pool = ctc.length > 0 ? ctc : models;
  return (
    pool.find((name) => /int8/i.test(name)) ??
    pool.find((name) => /^(?!.*_(encoder|decoder|joint)).*\.onnx$/i.test(name)) ??
    pool[0]
  );
}

export function sherpaExecutableNames(platform = process.platform) {
  return platform === "win32" ? ["sherpa-onnx-offline.exe", "sherpa-onnx.exe"] : ["sherpa-onnx-offline", "sherpa-onnx"];
}

/** `sherpa-onnx-offline.exe` -> `sherpa-onnx-offline-websocket-server.exe`. */
export function websocketServerBinary(executable) {
  return String(executable).replace(/offline(\.exe)?$/i, "offline-websocket-server$1");
}

/** Looks for sherpa-onnx-offline next to the model, then on PATH. */
export function findSherpaExecutable({ explicit, modelFile, pathEnv = process.env.PATH ?? "", platform = process.platform }) {
  const configured = explicit ? expandHome(explicit) : "";
  if (configured) {
    if (existsSync(configured)) return resolve(configured);
    const name = basename(configured);
    const names = platform === "win32" && !/\.exe$/i.test(name) ? [`${name}.exe`, name] : [name];
    return searchDirectories(pathDirectories(pathEnv, platform), names);
  }

  const modelDirectory = dirname(modelFile);
  const candidates = [modelDirectory, join(modelDirectory, "bin"), dirname(modelDirectory), join(dirname(modelDirectory), "bin")];

  return (
    searchDirectories(candidates, sherpaExecutableNames(platform)) ??
    searchDirectories(pathDirectories(pathEnv, platform), sherpaExecutableNames(platform))
  );
}

export function buildSherpaCommand({ executable, modelFile, tokensFile, extraArgs }) {
  const parts = [quote(executable), `--tokens=${quote(tokensFile)}`, `--nemo-ctc-model=${quote(modelFile)}`, "--num-threads=2"];
  const extra = String(extraArgs ?? "").trim();
  if (extra) parts.push(extra);
  parts.push("${file}");
  return parts.join(" ");
}

/**
 * sherpa-onnx prints the transcript together with the audio file name and timing,
 * e.g. `ru16.wav -- {"lang": "", "text": "привет", ...}`.
 */
export function extractSherpaText(output) {
  const cleaned = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^sherpa-onnx/i.test(line) && !/^--$/.test(line))
    .join("\n");

  const json = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cleaned);
  if (json) return json[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();

  return cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/^.*?\.wav\s*(?:--\s*)?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function buildSherpaServerArgs(options, port, logFile) {
  const args = [
    `--port=${port}`,
    "--num-work-threads=1",
    "--max-batch-size=1",
    `--tokens=${options.tokensFile}`,
    `--nemo-ctc-model=${options.modelFile}`,
    `--num-threads=${options.threads ?? 2}`,
  ];
  if (logFile) args.push(`--log-file=${logFile}`);
  const extra = String(options.extraArgs ?? "").trim();
  if (extra) args.push(...splitArgs(extra));
  return args;
}

/**
 * Keeps `sherpa-onnx-offline-websocket-server` warm so each phrase costs a forward
 * pass (~0.2 s) instead of reloading the model (~2 s).
 *
 * The server is started lazily on the first phrase, restarted on a crash, and killed
 * on plugin shutdown. This is the same lifecycle the VS Code extension uses.
 */
export class SherpaServer {
  constructor(options, logger) {
    this.options = options;
    this.logger = logger;
    this.child = undefined;
    this.socket = undefined;
    this.port = 0;
    this.workDirectory = undefined;
    this.ready = undefined;
    this.queue = Promise.resolve();
    this.stderrTail = "";
  }

  get label() {
    return `sherpa-onnx server (${basename(this.options.modelFile)})`;
  }

  get status() {
    return {
      running: Boolean(this.socket),
      port: this.port,
      model: this.options.modelFile,
    };
  }

  transcribe(pcm, signal) {
    const run = this.queue.then(() => this.doTranscribe(pcm, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async doTranscribe(pcm, signal) {
    const socket = await this.ensureStarted();

    const payload = Buffer.allocUnsafe(8 + pcm.length * 4);
    payload.writeUInt32LE(PCM_SAMPLE_RATE, 0);
    payload.writeUInt32LE(pcm.length * 4, 4);
    for (let i = 0; i < pcm.length; i++) payload.writeFloatLE(pcm[i] / 32768, 8 + i * 4);

    const text = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.reset();
        reject(new Error("sherpa-onnx server did not answer in time"));
      }, REQUEST_TIMEOUT_MS);

      const onAbort = () => {
        cleanup();
        reject(new Error("Request cancelled"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.onMessage = () => undefined;
        socket.onClose = () => undefined;
        signal?.removeEventListener("abort", onAbort);
      };

      socket.onMessage = (data) => {
        cleanup();
        resolvePromise(extractSherpaText(data.toString("utf8")));
      };
      socket.onClose = (error) => {
        cleanup();
        this.reset();
        reject(error ?? new Error("sherpa-onnx server closed the connection"));
      };
      signal?.addEventListener("abort", onAbort);

      if (signal?.aborted) {
        onAbort();
        return;
      }

      for (let offset = 0; offset < payload.length; offset += PAYLOAD_CHUNK) {
        socket.sendBinary(payload.subarray(offset, Math.min(offset + PAYLOAD_CHUNK, payload.length)));
      }
    });

    return text.trim();
  }

  async ensureStarted() {
    if (this.socket) return this.socket;
    this.ready ??= this.start();
    await this.ready;
    if (!this.socket) throw new Error("sherpa-onnx server failed to start");
    return this.socket;
  }

  async warmup() {
    await this.ensureStarted();
    return this.status;
  }

  async start() {
    this.port = await freePort();
    const workDirectory = await mkdtemp(join(tmpdir(), "opencode-voice-sherpa-"));
    this.workDirectory = workDirectory;
    const args = buildSherpaServerArgs(this.options, this.port, join(workDirectory, "sherpa.log"));

    this.logger?.info?.(`starting sherpa-onnx server: ${this.options.executable} ${args.join(" ")}`);
    const child = spawn(this.options.executable, args, {
      windowsHide: true,
      cwd: workDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrTail = "";

    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
    });
    child.once("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
        this.socket = undefined;
        this.ready = undefined;
      }
      if (code !== 0 && code !== null) {
        this.logger?.warn?.(`sherpa-onnx server exited with code ${code}: ${this.stderrTail.slice(-500)}`);
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(
          `sherpa-onnx server exited during startup: ${this.stderrTail.slice(-500) || `code ${child.exitCode}`}`,
        );
      }
      try {
        this.socket = await WebSocketClient.connect("127.0.0.1", this.port);
        break;
      } catch {
        if (Date.now() > deadline) {
          try {
            child.kill();
          } catch {}
          throw new Error(
            `sherpa-onnx server did not start within ${START_TIMEOUT_MS / 1000}s: ${this.stderrTail.slice(-500)}`,
          );
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      }
    }

    this.logger?.info?.(`sherpa-onnx server is listening on 127.0.0.1:${this.port}`);
  }

  reset() {
    try {
      this.socket?.close();
    } catch {}
    this.socket = undefined;
    this.ready = undefined;
  }

  async restart() {
    this.dispose();
    await this.ensureStarted();
    return this.status;
  }

  dispose() {
    try {
      this.socket?.close();
    } catch {}
    this.socket = undefined;
    this.ready = undefined;

    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {}
    }

    const workDirectory = this.workDirectory;
    this.workDirectory = undefined;
    if (workDirectory) void rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

// OpenCode can evaluate the plugin modules more than once in the same process
// (server entrypoint + TUI entrypoint, reloads). A module-local Map would then
// start one 370 MB model per copy, so the registry lives on globalThis.
const SHARED_SERVERS = Symbol.for("opencode.voice.sherpaServers");
const shared = globalThis[SHARED_SERVERS] instanceof Map ? globalThis[SHARED_SERVERS] : (globalThis[SHARED_SERVERS] = new Map());

function serverKey(options) {
  return [
    resolve(options.executable),
    resolve(options.modelFile),
    resolve(options.tokensFile),
    options.threads ?? 2,
    options.extraArgs ?? "",
  ].join("|");
}

export function getSharedSherpaServer(options, logger) {
  const key = serverKey(options);
  let server = shared.get(key);
  if (!server) {
    server = new SherpaServer(options, logger);
    shared.set(key, server);
  }
  return server;
}

export function resetSherpaServers() {
  for (const server of shared.values()) server.dispose();
  shared.clear();
}

export function sherpaServersStatus() {
  return [...shared.values()].map((server) => server.status);
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

/** Splits extra CLI arguments, honouring double quotes. */
export function splitArgs(value) {
  const result = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value))) !== null) result.push(match[1] ?? match[2]);
  return result;
}

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
