export interface KnowledgeCitation {
  docId: string;
  quote?: string;
  title?: string;
  mime?: string;
}

export type KnowledgeCitationsByTurn = Record<number, KnowledgeCitation[]>;

const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAW_CITATION_TAG = /\\?<\/?cite_[A-Za-z0-9_-]{4,128}\s*\/?>/gi;
const ENCODED_CITATION_TAG = /&lt;\/?cite_[A-Za-z0-9_-]{4,128}\s*\/?&gt;/gi;
const BRACKETED_CITATION = /\[(?:cite_[A-Za-z0-9_-]{4,128})\]/gi;
const BARE_CITATION_ID = /\bcite_[A-Za-z0-9_-]{4,128}\b/gi;

/**
 * citationId 是 KE v2 校验引用真实性的机器标识，引用卡片使用结构化 citations；
 * 思考与正式回答中不应暴露这些标识。流式场景还会截掉尚未闭合的标签前缀。
 */
export function stripKnowledgeCitationMarkers(text: string): string {
  let clean = text.replace(RAW_CITATION_TAG, '').replace(ENCODED_CITATION_TAG, '').replace(BRACKETED_CITATION, '');

  const partial = clean.match(/(?:<|&lt;)\/?c(?:i(?:t(?:e(?:_[A-Za-z0-9_-]*)?)?)?)?$/i);
  if (partial?.index !== undefined) clean = clean.slice(0, partial.index);
  clean = clean.replace(BARE_CITATION_ID, '');

  return clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function unwrapKnowledgeOutput(output: unknown): unknown {
  let parsed = output;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown[] }).content)) {
    const text = (parsed as { content: Array<{ text?: string }> }).content.find(
      (item) => typeof item?.text === 'string'
    )?.text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
    }
  } else if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
    try {
      parsed = JSON.parse((parsed as { text: string }).text);
    } catch {
      return null;
    }
  } else if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed;
}

export function parseKnowledgeCitations(output: unknown): KnowledgeCitation[] {
  const parsed = unwrapKnowledgeOutput(output) as { citations?: unknown[] } | null;
  if (!Array.isArray(parsed?.citations)) return [];

  const seen = new Set<string>();
  const result: KnowledgeCitation[] = [];
  for (const raw of parsed.citations) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const docId = String(item.documentId ?? item.docId ?? '').toLowerCase();
    if (!DOCUMENT_ID_PATTERN.test(docId) || seen.has(docId)) continue;
    seen.add(docId);
    result.push({
      docId,
      ...(typeof item.quote === 'string' && item.quote.trim() ? { quote: item.quote.trim() } : {}),
      ...(typeof item.filename === 'string' && item.filename.trim()
        ? { title: item.filename.trim() }
        : typeof item.title === 'string' && item.title.trim()
          ? { title: item.title.trim() }
          : {}),
      ...(typeof item.mime === 'string' && item.mime.trim() ? { mime: item.mime.trim() } : {}),
    });
  }
  return result;
}

export function mergeKnowledgeCitations(
  current: readonly KnowledgeCitation[],
  incoming: readonly KnowledgeCitation[]
): KnowledgeCitation[] {
  const merged = new Map<string, KnowledgeCitation>();
  for (const citation of [...current, ...incoming]) {
    if (!DOCUMENT_ID_PATTERN.test(citation.docId)) continue;
    merged.set(citation.docId.toLowerCase(), {
      ...merged.get(citation.docId.toLowerCase()),
      ...citation,
      docId: citation.docId.toLowerCase(),
    });
  }
  return [...merged.values()];
}

export function parseStoredCitationTurns(raw: string | null): KnowledgeCitationsByTurn {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: KnowledgeCitationsByTurn = {};
    for (const [key, value] of Object.entries(parsed)) {
      const turn = Number(key);
      if (!Number.isInteger(turn) || turn < 1 || !Array.isArray(value)) continue;
      const citations = parseKnowledgeCitations({ citations: value });
      if (citations.length > 0) result[turn] = citations;
    }
    return result;
  } catch {
    return {};
  }
}

export function messageTurnNumber(messages: readonly { role?: string }[], index: number): number {
  return messages.slice(0, index + 1).filter((message) => message.role === 'user').length;
}

export function isLastAssistantForTurn(messages: readonly { role?: string }[], index: number): boolean {
  if (messages[index]?.role !== 'assistant') return false;
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    if (messages[cursor]?.role === 'user') return true;
    if (messages[cursor]?.role === 'assistant') return false;
  }
  return true;
}
