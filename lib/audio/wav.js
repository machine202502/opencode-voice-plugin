// PCM16 <-> WAV helpers. The whole plugin works with 16 kHz mono s16le.

export const PCM_SAMPLE_RATE = 16000;
export const PCM_BYTES_PER_SAMPLE = 2;

export function int16FromBuffer(buffer) {
  const count = Math.floor(buffer.length / PCM_BYTES_PER_SAMPLE);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = buffer.readInt16LE(i * PCM_BYTES_PER_SAMPLE);
  }
  return samples;
}

export function concatInt16(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const result = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Normalized RMS in the 0..1 range (1 = full scale). */
export function rmsOf(pcm, start = 0, end = pcm.length) {
  const from = Math.max(0, start);
  const to = Math.min(pcm.length, end);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const value = pcm[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / (to - from));
}

/** Wraps raw PCM into a canonical 44-byte RIFF/WAVE container. */
export function encodeWav(pcm, sampleRate = PCM_SAMPLE_RATE) {
  const dataLength = pcm.length * PCM_BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44 + dataLength);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * PCM_BYTES_PER_SAMPLE, 28);
  buffer.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * PCM_BYTES_PER_SAMPLE);
  }

  return buffer;
}

/** Raw little-endian PCM bytes, as expected by streaming APIs such as SaluteSpeech. */
export function int16ToPcmBuffer(pcm) {
  const buffer = Buffer.alloc(pcm.length * PCM_BYTES_PER_SAMPLE);
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], i * PCM_BYTES_PER_SAMPLE);
  }
  return buffer;
}

/** WAV header + PCM data for a generated tone. */
export function makeToneWav({ frequency = 880, durationMs = 120, sampleRate = 16000, volume = 0.2 } = {}) {
  const count = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const pcm = new Int16Array(count);
  const amplitude = Math.max(0, Math.min(1, volume)) * 32767;
  const fade = Math.max(1, Math.round(count * 0.12));

  for (let i = 0; i < count; i++) {
    const envelope = Math.min(1, Math.min(i, count - i) / fade);
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * envelope;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }

  return encodeWav(pcm, sampleRate);
}
