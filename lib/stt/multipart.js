import { randomUUID } from "node:crypto";

/** Minimal RFC 7578 multipart/form-data encoder (no external dependencies). */
export function buildMultipartBody(fields = {}, files = [], boundary = `----opencodeVoice${randomUUID().replace(/-/g, "")}`) {
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"\r\n\r\n${String(value)}\r\n`,
        "utf8",
      ),
    );
  }

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(file.field)}"; filename="${escapeName(file.filename)}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    parts.push(file.data);
    parts.push(Buffer.from("\r\n", "utf8"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeName(value) {
  return String(value).replace(/["\r\n]/g, "_");
}

/**
 * Parses the multipart body produced by a browser FormData upload.
 * Returns `{ fields: Record<string,string>, files: Array<{field,name,type,data}> }`.
 */
export function parseMultipartBody(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
  if (!boundary) throw new Error("multipart boundary is missing");

  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const fields = {};
  const files = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = buffer.indexOf(delimiter, offset);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (buffer[partStart] === 0x0d && buffer[partStart + 1] === 0x0a) partStart += 2;
    if (buffer[partStart] === 0x2d && buffer[partStart + 1] === 0x2d) break; // closing delimiter

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n", "utf8"), partStart);
    if (headerEnd < 0) break;
    const header = buffer.subarray(partStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;

    let next = buffer.indexOf(delimiter, dataStart);
    if (next < 0) next = buffer.length;
    let dataEnd = next;
    if (dataEnd >= 2 && buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = buffer.subarray(dataStart, dataEnd);

    const nameMatch = /name="([^"]+)"/i.exec(header);
    const filenameMatch = /filename="([^"]*)"/i.exec(header);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(header);
    if (nameMatch) {
      if (filenameMatch) {
        files.push({
          field: nameMatch[1],
          name: filenameMatch[1],
          type: typeMatch?.[1]?.trim() || "application/octet-stream",
          data,
        });
      } else {
        fields[nameMatch[1]] = data.toString("utf8");
      }
    }

    offset = next;
  }

  return { fields, files };
}
