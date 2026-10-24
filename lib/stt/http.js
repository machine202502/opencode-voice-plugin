import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";

export function httpRequest(url, options = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-length"] = String(options.body.length);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const onAbort = () => request.destroy(new Error("Request cancelled"));
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(response);
    };

    const request = (isHttps ? nodeHttps : nodeHttp).request(
      target,
      {
        method: options.method ?? "GET",
        headers,
        rejectUnauthorized: !options.insecureTLS,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          finish(undefined, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            text: body.toString("utf8"),
          });
        });
        response.on("error", (error) => finish(error));
      },
    );

    if (options.timeoutMs) {
      timer = setTimeout(() => request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort);
    request.on("error", (error) => finish(error));

    if (options.signal?.aborted) {
      request.destroy(new Error("Request cancelled"));
      return;
    }
    if (options.body) request.write(options.body);
    request.end();
  });
}
