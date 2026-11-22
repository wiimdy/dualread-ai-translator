import type { Readable } from 'node:stream';

const HEADER_SIZE = 4;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const readRequest = async (input: Readable): Promise<unknown> => {
  const header = Buffer.alloc(HEADER_SIZE);
  let headerBytes = 0;
  let body: Buffer | undefined;
  let received = 0;
  for await (const chunk of input.iterator({ destroyOnReturn: false })) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    if (!body) {
      const count = Math.min(HEADER_SIZE - headerBytes, data.length);
      data.copy(header, headerBytes, 0, count);
      headerBytes += count;
      offset = count;
      if (headerBytes < HEADER_SIZE) continue;
      const length = header.readUInt32LE();
      if (length === 0 || length > MAX_REQUEST_BYTES) throw new Error('Invalid frame size');
      body = Buffer.alloc(length);
    }
    const count = data.length - offset;
    if (count > body.length - received) throw new Error('Unexpected trailing data');
    data.copy(body, received, offset);
    received += count;
    if (received === body.length) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  }
  throw new Error('Incomplete frame');
};

export const frameResponse = (value: unknown): Buffer => {
  let body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_RESPONSE_BYTES) {
    body = Buffer.from(JSON.stringify({ ok: false, error: '번역문이 너무 깁니다. 더 짧은 문단으로 나눠 주세요.' }));
  }
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
