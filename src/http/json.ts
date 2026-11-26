import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpInputError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.status = status;
  }
}

export function decodeSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpInputError(`${label} 编码无效`, 400);
  }
}

/** optional=true 时允许空请求体（复制可用服务端生成的新 ID）。 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number, optional = false): Promise<Record<string, unknown>> {
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw new HttpInputError(`请求体不能超过 ${maxBytes} 字节`, 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) {
    if (optional) return {};
    if (mediaType !== 'application/json') throw new HttpInputError('请求体必须是 application/json', 415);
    throw new HttpInputError('请求体不能为空', 400);
  }
  if (mediaType !== 'application/json') throw new HttpInputError('请求体必须是 application/json', 415);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpInputError('请求体不是合法 JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpInputError('请求体必须是对象', 400);
  }
  return parsed as Record<string, unknown>;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    connection: 'close',
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, allow?: string): void {
  sendJson(res, status, { code, message }, allow ? { allow } : {});
}
