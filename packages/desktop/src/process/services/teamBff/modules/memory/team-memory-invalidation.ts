// AionUi 移植（T3.1）：团队记忆失效 SSE 流（源 client server/team-memory-invalidation.ts，零逻辑改动）。
// 快照轮询端点在 routes.ts（GET /teamapi/team-memory-invalidation）；client 标识改 aionui-desktop。

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SSE_BUFFER_BYTES = 64 * 1024;
const EVENT_NAMES = new Set(['memory.projection.updated', 'memory.consolidation.source_deactivated']);
const OPERATIONS = new Set(['publish', 'deactivate', 'delete']);

export interface TeamMemoryInvalidationSnapshot {
  connected: boolean;
  dirty: boolean;
  lastEventId: number;
  latestRevision: number;
  observedRevision: number;
  lastOperation: 'publish' | 'deactivate' | 'delete' | null;
  lastMemoryId: string | null;
  lastActivationEpoch: number;
  updatedAt: number | null;
}

export interface TeamMemoryInvalidationStreamInput {
  baseUrl: URL;
  accessToken: string;
  tenantId: string;
  teamId: string;
  accountSignal: AbortSignal;
}

interface ActiveStream {
  controller: AbortController;
  id: symbol;
}

interface InvalidationEvent {
  memoryId: string;
  memoryRevision: number;
  activationEpoch: number;
  operation: 'publish' | 'deactivate' | 'delete';
}

let active: ActiveStream | null = null;
let snapshot: TeamMemoryInvalidationSnapshot = initialSnapshot();

function initialSnapshot(): TeamMemoryInvalidationSnapshot {
  return {
    connected: false,
    dirty: false,
    lastEventId: 0,
    latestRevision: 0,
    observedRevision: 0,
    lastOperation: null,
    lastMemoryId: null,
    lastActivationEpoch: 0,
    updatedAt: null,
  };
}

export function teamMemoryInvalidationSnapshot(): TeamMemoryInvalidationSnapshot {
  return { ...snapshot };
}

export function observeTeamMemoryRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  snapshot = {
    ...snapshot,
    observedRevision: Math.max(snapshot.observedRevision, revision),
    dirty: snapshot.latestRevision > Math.max(snapshot.observedRevision, revision),
  };
}

export function startTeamMemoryInvalidationStream(input: TeamMemoryInvalidationStreamInput): void {
  stopTeamMemoryInvalidationStream();
  snapshot = initialSnapshot();
  const stream: ActiveStream = { controller: new AbortController(), id: Symbol('team-memory-events') };
  active = stream;
  const signal = AbortSignal.any([input.accountSignal, stream.controller.signal]);
  void runStream(input, signal, stream.id);
}

export function stopTeamMemoryInvalidationStream(): void {
  const previous = active;
  active = null;
  previous?.controller.abort(new Error('TEAM_MEMORY_INVALIDATION_STOPPED'));
  snapshot = initialSnapshot();
}

async function runStream(input: TeamMemoryInvalidationStreamInput, signal: AbortSignal, streamId: symbol): Promise<void> {
  let retryMilliseconds = 250;
  while (!signal.aborted && active?.id === streamId) {
    try {
      const headers = new Headers({
        Accept: 'text/event-stream',
        Authorization: `Bearer ${input.accessToken}`,
      });
      if (snapshot.lastEventId > 0) headers.set('Last-Event-ID', String(snapshot.lastEventId));
      const path = `/api/v1/tenants/${encodeURIComponent(input.tenantId)}/teams/${encodeURIComponent(input.teamId)}/events`;
      const response = await fetch(new URL(path, input.baseUrl), {
        method: 'GET', headers, redirect: 'error', cache: 'no-store', signal,
      });
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')) {
        throw new Error(response.status === 401 ? 'SESSION_INVALID' : 'TEAM_MEMORY_EVENT_STREAM_INVALID');
      }
      if (active?.id !== streamId || signal.aborted) return;
      snapshot = { ...snapshot, connected: true };
      retryMilliseconds = 250;
      await consumeSSE(response.body, signal, streamId);
    } catch {
      // Pull remains authoritative; losing the advisory stream must never break a conversation.
    } finally {
      if (active?.id === streamId) snapshot = { ...snapshot, connected: false };
    }
    if (signal.aborted || active?.id !== streamId) return;
    await abortableDelay(retryMilliseconds, signal);
    retryMilliseconds = Math.min(retryMilliseconds * 2, 5_000);
  }
}

async function consumeSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal, streamId: symbol): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted && active?.id === streamId) {
      const result = await readWithAbort(reader, signal);
      if (!result || result.done) break;
      buffer += decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) throw new Error('TEAM_MEMORY_EVENT_STREAM_TOO_LARGE');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        handleFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); resolve(null); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
  });
}

function handleFrame(frame: string): void {
  let eventName = '';
  let eventID = '';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    if (field === 'id') eventID = value;
    if (field === 'data') data.push(value);
  }
  if (!/^\d+$/.test(eventID)) return;
  const sequence = Number(eventID);
  if (!Number.isSafeInteger(sequence) || sequence <= snapshot.lastEventId) return;
  snapshot = { ...snapshot, lastEventId: sequence };
  if (!EVENT_NAMES.has(eventName) || data.length === 0) return;
	const event = parseInvalidationEvent(data.join('\n'));
	if (!event) return;
	// Stream sequence and domain revision are independent. A delayed retry can arrive
	// after newer revisions, so advance Last-Event-ID without regressing diagnostic metadata.
	if (event.memoryRevision < snapshot.latestRevision) return;
	snapshot = {
		...snapshot,
		latestRevision: event.memoryRevision,
    dirty: event.memoryRevision > snapshot.observedRevision || snapshot.dirty,
    lastOperation: event.operation,
    lastMemoryId: event.memoryId,
    lastActivationEpoch: event.activationEpoch,
    updatedAt: Date.now(),
  };
}

function parseInvalidationEvent(raw: string): InvalidationEvent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.memoryId !== 'string' || !UUID_PATTERN.test(record.memoryId) ||
      typeof record.operation !== 'string' || !OPERATIONS.has(record.operation) ||
      typeof record.memoryRevision !== 'number' || !Number.isSafeInteger(record.memoryRevision) || record.memoryRevision < 0 ||
      typeof record.activationEpoch !== 'number' || !Number.isSafeInteger(record.activationEpoch) || record.activationEpoch < 1) return null;
  return {
    memoryId: record.memoryId,
    operation: record.operation as InvalidationEvent['operation'],
    memoryRevision: record.memoryRevision,
    activationEpoch: record.activationEpoch,
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
