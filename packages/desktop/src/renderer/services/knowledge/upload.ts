// AionUi 移植（T4.1）：知识库上传链路（源 client src/lib/knowledge-upload.ts）。
// 差异：BFF base 由 teamBffBaseUrl() 注入（上游为同源相对路径）；其余
// —— MIME 白名单/扩展名表、sha256、幂等 key、签名 PUT 直传（credentials omit）、
// complete 轮询（2s×10min、可重试错误码集）—— 逐行保留。

import { teamBffBaseUrl } from '@/renderer/api/teamClient';

export type KnowledgeVisibility = 'personal' | 'team';
export type KnowledgeClassification = 'normal' | 'internal' | 'confidential' | 'restricted';

interface Envelope<T> { data?: T; error?: { code?: string } }
interface CreateUploadData {
  uploadSession: { id: string; documentId: string };
  upload: { method: string; url: string; requiredHeaders: Record<string, string> };
}
export interface CompletedKnowledgeUpload {
  uploadSessionId: string;
  documentId: string;
  ingestionJobId: string;
  status: 'completed';
}

export class KnowledgeUploadError extends Error {
  constructor(public readonly code: string, public readonly status = 0) {
    super(code);
  }
}

const supportedMimes = new Set([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/markdown',
  'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
const extensionMimes: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', log: 'text/plain', ts: 'text/plain', js: 'text/plain', py: 'text/plain',
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export function resolveKnowledgeMIME(file: Pick<File, 'name' | 'type'>) {
  const declared = file.type.toLowerCase().split(';', 1)[0]!.trim();
  if (supportedMimes.has(declared)) return declared;
  return extensionMimes[file.name.toLowerCase().split('.').pop() ?? ''] ?? '';
}

export async function sha256Hex(file: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function envelope<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok || payload.data === undefined) {
    throw new KnowledgeUploadError(payload.error?.code ?? `HTTP_${response.status}`, response.status);
  }
  return payload.data;
}

function safeSignedURL(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function wait(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function bff(path: string) {
  const base = teamBffBaseUrl();
  if (!base) throw new KnowledgeUploadError('TEAM_BFF_UNAVAILABLE');
  return `${base}${path}`;
}

export async function uploadKnowledgeFile(file: File, options: {
  visibility?: KnowledgeVisibility;
  classification?: KnowledgeClassification;
  signal?: AbortSignal;
  onSessionCreated?: (session: { id: string; documentId: string }) => void;
  onJobCreated?: (job: CompletedKnowledgeUpload) => void;
} = {}): Promise<CompletedKnowledgeUpload> {
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new KnowledgeUploadError('PAYLOAD_TOO_LARGE', 413);
  const mime = resolveKnowledgeMIME(file);
  if (!mime) throw new KnowledgeUploadError('MIME_UNSUPPORTED', 415);
  const digest = await sha256Hex(file);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const created = await envelope<CreateUploadData>(await fetch(bff('/teamapi/knowledge/uploads'), {
    method: 'POST', cache: 'no-store', signal: options.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      filename: file.name, mime, sizeBytes: file.size, sha256: digest,
      visibility: options.visibility ?? 'personal', classification: options.classification ?? 'normal',
      idempotencyKey: crypto.randomUUID(),
    }),
  }));
  options.onSessionCreated?.(created.uploadSession);
  if (created.upload.method !== 'PUT' || !safeSignedURL(created.upload.url)) {
    throw new KnowledgeUploadError('UPLOAD_INSTRUCTION_INVALID', 502);
  }
  const uploaded = await fetch(created.upload.url, {
    method: 'PUT', credentials: 'omit', redirect: 'error', signal: options.signal,
    headers: created.upload.requiredHeaders, body: file,
  });
  if (!uploaded.ok) throw new KnowledgeUploadError('OBJECT_STORE_UPLOAD_FAILED', uploaded.status);

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    let completed: Partial<CompletedKnowledgeUpload> & { status: string };
    try {
      completed = await envelope<Partial<CompletedKnowledgeUpload> & { status: string }>(await fetch(
        bff(`/teamapi/knowledge/uploads/${encodeURIComponent(created.uploadSession.id)}/complete`),
        { method: 'POST', cache: 'no-store', signal: options.signal, headers: { Accept: 'application/json' } },
      ));
    } catch (error) {
      if (!(error instanceof KnowledgeUploadError) || ![
        'OBJECT_NOT_READY', 'OBJECT_STORE_UNAVAILABLE', 'MALWARE_SCANNER_UNAVAILABLE',
        'UPLOAD_COMPLETION_STATE_CHANGED', 'TEAM_GATEWAY_UPSTREAM_FAILED',
      ].includes(error.code)) throw error;
      await wait(2_000, options.signal);
      continue;
    }
    if (completed.status === 'completed' && completed.ingestionJobId) {
      const result: CompletedKnowledgeUpload = {
        uploadSessionId: completed.uploadSessionId ?? created.uploadSession.id,
        documentId: completed.documentId ?? created.uploadSession.documentId,
        ingestionJobId: completed.ingestionJobId,
        status: 'completed',
      };
      options.onJobCreated?.(result);
      return result;
    }
    await wait(2_000, options.signal);
  }
  throw new KnowledgeUploadError('UPLOAD_COMPLETION_TIMEOUT', 504);
}
