/**
 * BlockSuite 文档内容导出 / 导入（保留行内富文本格式）
 *
 * BlockSuite 0.19.5 的文本以 Quill delta（Text.toDelta()）存储行内格式，
 * 若只用 block.text.toString() 导出，**bold**、*italic*、~~strike~~、`code`、
 * [链接](url) 会全部丢失。本模块遍历 delta，把行内格式还原为标准 Markdown，
 * 反向再把 Markdown 解析回 delta，保证「编辑 → 保存 → 查看」样式一致。
 *
 * @see 设计文档 03 §5.4 / §8.3 #F
 */

// BlockSuite 的 BlockModel/Doc 是动态类型，用最小结构约束。
interface DeltaOp {
  insert?: string;
  attributes?: Record<string, unknown>;
}
interface BlockLike {
  flavour: string;
  type?: string;
  text?: { toString(): string; toDelta?: () => DeltaOp[] };
  children?: BlockLike[];
}

interface DocLike {
  root: BlockLike | null;
  getBlocks: () => BlockLike[];
  getBlocksByFlavour: (flavour: string | string[]) => BlockLike[];
}

const HEADING_TYPES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// ============================================================
// 行内 delta → Markdown
// ============================================================

/** 把单个 block 的 text delta 序列化为带行内格式的 markdown 字符串 */
function deltaToMarkdown(block: BlockLike): string {
  const text = block.text;
  if (!text) return '';
  // 没有 toDelta（旧结构）则退化为纯文本
  if (!text.toDelta) return text.toString();

  const ops = text.toDelta();
  let out = '';
  for (const op of ops) {
    const seg = op.insert != null ? String(op.insert) : '';
    if (!seg) continue;
    const attrs = op.attributes ?? {};
    let s = seg;
    // 链接（link 属性可能是 { link: url } 或 BlockSuite 的 reference）
    if (typeof attrs.link === 'string' && attrs.link) {
      s = `[${s}](${attrs.link})`;
    }
    // 行内代码优先（与其他格式互斥时优先 code）
    if (attrs.code) {
      s = `\`${s}\``;
    } else {
      // bold / italic / underline / strike 可组合
      if (attrs.bold) s = `**${s}**`;
      if (attrs.italic) s = `*${s}*`;
      if (attrs.underline) s = `<u>${s}</u>`;
      if (attrs.strike) s = `~~${s}~~`;
    }
    out += s;
  }
  return out;
}

// ============================================================
// Markdown（行内）→ delta
// ============================================================

/** 行内 markdown 解析：把一行文本拆成带 attributes 的 delta insert。 */
function markdownLineToDeltas(line: string): { insert: string; attributes?: Record<string, boolean | string> }[] {
  // 顺序处理嵌套：链接 [text](url)、code `x`、bold **x**、italic *x*、strike ~~x~~、underline <u>x</u>
  // 标记链接区间
  const marks: { start: number; end: number; type: string; data?: string }[] = [];

  // 链接
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(line))) {
    marks.push({ start: m.index, end: m.index + m[0].length, type: 'link', data: m[2] });
  }
  const cleaned = line.replace(linkRe, (_, t: string) => t); // 链接文本保留，url 移除
  if (marks.length === 0) {
    return parseSimpleInline(line);
  }
  // 含链接：在 cleaned（链接已替换为文本）上做 bold/italic 等，再叠加 link 属性
  const sub = parseSimpleInline(cleaned);
  for (const mk of marks) {
    let acc = 0;
    for (const seg of sub) {
      const segLen = seg.insert.length;
      if (mk.start >= acc && mk.start < acc + segLen) {
        seg.attributes = { ...seg.attributes, link: mk.data ?? '' };
        break;
      }
      acc += segLen;
    }
  }
  return sub;
}

/** 处理 bold/italic/strike/code/underline（不含链接） */
function parseSimpleInline(line: string): { insert: string; attributes?: Record<string, boolean | string> }[] {
  const tokens: { insert: string; attributes?: Record<string, boolean | string> }[] = [];
  // 用正则逐项剥皮
  type Rule = { re: RegExp; attr: string };
  const rules: Rule[] = [
    { re: /`([^`]+)`/g, attr: 'code' },
    { re: /\*\*([^*]+)\*\*/g, attr: 'bold' },
    { re: /~~([^~]+)~~/g, attr: 'strike' },
    { re: /<u>([^<]+)<\/u>/g, attr: 'underline' },
    { re: /\*([^*]+)\*/g, attr: 'italic' },
  ];
  // 标记区间
  type Range = { start: number; end: number; attr: string; text: string };
  const ranges: Range[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = rule.re.exec(line))) {
      ranges.push({ start: mm.index, end: mm.index + mm[0].length, attr: rule.attr, text: mm[1] });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  // 去除重叠区间（先到的优先）
  const chosen: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start >= lastEnd) {
      chosen.push(r);
      lastEnd = r.end;
    }
  }
  // 按区间切分文本
  let cursor = 0;
  for (const r of chosen) {
    if (r.start > cursor) tokens.push({ insert: line.slice(cursor, r.start) });
    tokens.push({ insert: r.text, attributes: { [r.attr]: true } });
    cursor = r.end;
  }
  if (cursor < line.length) tokens.push({ insert: line.slice(cursor) });
  if (tokens.length === 0) tokens.push({ insert: line });
  return tokens;
}

// ============================================================
// doc → markdown（结构 + 行内格式）
// ============================================================

/**
 * 从 BlockSuite doc 导出为 Markdown（保留行内富文本格式）。
 * @param doc BlockSuite Doc 实例（createEmptyDoc 返回的 doc）
 * @returns markdown 字符串（找不到内容时返回空串）
 */
export function docToMarkdown(doc: unknown): string {
  const d = doc as DocLike;
  if (!d || !d.root) return '';

  const lines: string[] = [];

  const walk = (block: BlockLike): void => {
    const inline = deltaToMarkdown(block);

    switch (block.flavour) {
      case 'affine:page':
        break;
      case 'affine:paragraph': {
        if (block.type && HEADING_TYPES.has(block.type)) {
          const level = Number(block.type.slice(1));
          lines.push(`${'#'.repeat(level)} ${inline}`);
        } else if (block.type === 'quote') {
          lines.push(`> ${inline}`);
        } else if (block.type === 'code') {
          lines.push('```', block.text ? block.text.toString() : '', '```');
        } else {
          if (inline) lines.push(inline);
        }
        break;
      }
      case 'affine:list': {
        const prefix = block.type === 'numbered' ? '1. ' : block.type === 'todo' ? '- [ ] ' : '- ';
        lines.push(`${prefix}${inline}`);
        break;
      }
      case 'affine:code': {
        lines.push('```', block.text ? block.text.toString() : '', '```');
        break;
      }
      case 'affine:divider': {
        lines.push('---');
        break;
      }
      default:
        if (inline) lines.push(inline);
    }

    if (block.children && block.children.length > 0) {
      for (const child of block.children) walk(child);
      lines.push('');
    }
  };

  walk(d.root);
  if (lines.length === 0) {
    for (const b of d.getBlocks()) walk(b);
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
// markdown → BlockSuite 块（结构 + 行内格式回填）
// ============================================================

export interface ParsedBlock {
  flavour: string;
  type?: string;
  /** 行内 delta（用于构造 BlockSuite Text） */
  deltas: { insert: string; attributes?: Record<string, unknown> }[];
  /** 纯文本（code block 等不解析行内格式的块用） */
  raw?: string;
}

/**
 * 把 markdown 解析为 BlockSuite 块结构（含行内 delta）。
 * 供 DocEditor / DocViewer 灌入 createEmptyDoc 创建的 doc。
 */
export function markdownToBlocks(markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = markdown.split('\n');

  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    const trimmed = line.trim();

    // 空行跳过
    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块
    if (trimmed.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      blocks.push({ flavour: 'affine:code', deltas: [], raw: buf.join('\n') });
      continue;
    }

    // 分隔线
    if (/^---+$/.test(trimmed)) {
      blocks.push({ flavour: 'affine:divider', deltas: [] });
      i++;
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ flavour: 'affine:paragraph', type: `h${h[1].length}`, deltas: markdownLineToDeltas(h[2]) });
      i++;
      continue;
    }

    // 引用
    if (/^>\s/.test(trimmed)) {
      blocks.push({
        flavour: 'affine:paragraph',
        type: 'quote',
        deltas: markdownLineToDeltas(trimmed.replace(/^>\s/, '')),
      });
      i++;
      continue;
    }

    // 有序列表
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      blocks.push({ flavour: 'affine:list', type: 'numbered', deltas: markdownLineToDeltas(ol[1]) });
      i++;
      continue;
    }

    // 待办列表（- [ ] / - [x]）
    const todo = trimmed.match(/^[-*]\s+\[([ x])\]\s+(.*)$/);
    if (todo) {
      blocks.push({ flavour: 'affine:list', type: 'todo', deltas: markdownLineToDeltas(todo[2]) });
      i++;
      continue;
    }

    // 无序列表
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      blocks.push({ flavour: 'affine:list', type: 'bulleted', deltas: markdownLineToDeltas(ul[1]) });
      i++;
      continue;
    }

    // 普通段落
    blocks.push({ flavour: 'affine:paragraph', type: 'text', deltas: markdownLineToDeltas(trimmed) });
    i++;
  }

  return blocks;
}
