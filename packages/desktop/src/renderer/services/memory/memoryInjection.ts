// AionUi 新增（T2.9/T2.10）：记忆注入与抽取的 renderer 侧服务。
// 注入：发送前调 BFF /teamapi/context/assemble（个人记忆 + 团队记忆/知识并行召回），渲染块前置到用户输入；
// 抽取：发送时顺带对「上一轮完成的 user/assistant 交换」触发一次 LLM 抽取（未绑定模型则 BFF 跳过）。
// 设计对齐 client：注入与抽取全部经 BFF（renderer 不持有 token），失败静默降级为原文。

import { useEffect, useRef } from 'react';
import { teamApi, teamBffBaseUrl } from '@/renderer/api/teamClient';
import type { TMessage } from '@/common/chat/chatLib';

const INJECTION_TOGGLE_KEY = 'aionui.team.memoryInjection';

export function isMemoryInjectionEnabled(): boolean {
  try {
    return localStorage.getItem(INJECTION_TOGGLE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setMemoryInjectionEnabled(enabled: boolean) {
  try {
    localStorage.setItem(INJECTION_TOGGLE_KEY, enabled ? 'on' : 'off');
  } catch {
    /* storage 不可用时忽略 */
  }
}

/** 注入块起止标记（防止多次包装）；导出供发送收口层判重与渲染层剥离 */
export const INJECTION_MARK = '<!-- aionui-team-context -->';
export const INJECTION_MARK_END = '<!-- /aionui-team-context -->';

/** 剥离注入块（含上下文/降级说明/记忆协议指令）——消息气泡展示用，未含标记时原样返回。 */
export function stripInjectionBlock(text: string): string {
  if (!text.includes(INJECTION_MARK)) return text;
  const start = text.indexOf(INJECTION_MARK);
  const endMark = text.indexOf(INJECTION_MARK_END, start);
  const stripped =
    endMark >= 0 ? text.slice(0, start) + text.slice(endMark + INJECTION_MARK_END.length) : text.slice(0, start); // 无结束标记（流式/异常）时保守丢弃后段
  return stripped.replace(/^\n+/, '').replace(/^\s+/, '');
}

// ── 记忆协议（对齐 client 的 <memorize> 显式记忆意图，E-14）─────────────────
// 由对话主模型判断是否记忆、进个人还是团队；固定标记不展示在气泡中，
// 渲染层剥离、回合结束解析提交（personal→/teamapi/memories，team→/teamapi/team-memories）。
const MEMORIZE_TAG = 'memorize';
const MEMORIZE_BLOCK_RE = /<memorize\b([^>]*)>([\s\S]*?)<\/memorize>/gi;
const MEMORIZE_PARTIAL_RE = /<memorize\b[^>]*>?$/i;

export interface MemorizeBlock {
  audience: 'personal' | 'team';
  /** 分类名（可选，来自用户现有分类清单）；null=未分类，留待整理时归档 */
  categoryName: string | null;
  scope: 'chat' | 'code';
  title: string;
  content: string;
}

function normalizeMemorizeBlock(rawAttrs: string, rawContent: string): MemorizeBlock | null {
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`, 'i').exec(rawAttrs)?.[1]?.trim() ?? '';
  const categoryName = attr('category').slice(0, 20) || null;
  const scope = attr('scope');
  const audience = (attr('audience') || 'personal').toLowerCase();
  const content = rawContent.trim();
  const title = attr('title').slice(0, 40) || content.slice(0, 20);
  if (!content) return null;
  return {
    audience: audience === 'team' ? 'team' : 'personal',
    categoryName,
    scope: scope === 'code' ? 'code' : 'chat',
    title,
    content: content.slice(0, 2_000),
  };
}

/** 提取文本中的 <memorize> 块（流式未闭合前缀忽略）。 */
export function parseMemorizeBlocks(text: string): MemorizeBlock[] {
  const blocks: MemorizeBlock[] = [];
  for (const match of text.matchAll(MEMORIZE_BLOCK_RE)) {
    const block = normalizeMemorizeBlock(match[1] ?? '', match[2] ?? '');
    if (block) blocks.push(block);
  }
  return blocks;
}

/** 清洗展示文本：去掉完整块与未闭合前缀（消息气泡/thinking 中均不出现该标记）。 */
export function stripMemorizeBlocks(text: string): string {
  return text
    .replace(MEMORIZE_BLOCK_RE, '')
    .replace(MEMORIZE_PARTIAL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** 注入到上下文块的协议指令（仅团队功能启用时附带）；分类清单动态生成（决策 D1）。 */
export function buildMemorizeProtocolDirective(categoryNames: string[]): string {
  const available = categoryNames.slice(0, 30);
  return [
    '【记忆协议·最高优先级】当用户要求"记住/记一下"某信息，或本轮出现值得长期记住的用户/团队信息时：',
    '1. 禁止使用你自带的记忆文件/memory 目录/markdown 笔记等任何本地记忆机制来记录这些信息；',
    '2. 必须在回复正文的最末尾追加一行（不要放进思考过程）：',
    '<memorize audience="personal或team" category="分类名（可选）" scope="chat或code" title="不超过20字标题">记忆内容</memorize>',
    available.length > 0
      ? `category 只能从下列现有分类中选最合适的一个；没有合适的就直接省略该属性（留待整理时归档）：${available.join('、')}`
      : 'category 可省略；当前还没有分类，留待整理时归档。',
    'audience 判定【硬规则】：默认一律用 personal。只有当用户本轮明确说出"团队共享/团队记忆/全员/让大家都用"等字样时才用 team；用户未明确要求共享的任何信息（包括公司/项目/业务信息）都属 personal。可一次输出多个 memorize 块。',
    '没有值得记的信息就完全不要输出该标记。该标记不会展示给用户，也不属于你的文件记忆系统。',
  ].join('\n');
}

// 分类清单缓存：发送路径每轮都要注入分类名，60s TTL + 分类变更时显式失效（MemoryPage 调用）
const CATEGORY_CACHE_TTL_MS = 60_000;
let memorizeCategoryCache: { at: number; names: string[] } | null = null;

export function invalidateMemorizeCategoryCache(): void {
  memorizeCategoryCache = null;
}

async function loadMemorizeCategoryNames(): Promise<string[]> {
  if (memorizeCategoryCache && Date.now() - memorizeCategoryCache.at < CATEGORY_CACHE_TTL_MS) {
    return memorizeCategoryCache.names;
  }
  try {
    const result = await teamApi.listMemoryCategories();
    const names = (result?.categories ?? []).map((category) => category.name);
    memorizeCategoryCache = { at: Date.now(), names };
    return names;
  } catch {
    return memorizeCategoryCache?.names ?? [];
  }
}

// 会话级抽取去重：同一轮交换（用户文本签名）只抽取一次；
// 回合结束与下一轮发送双触发共用，双保险防漏触发且不产生重复记忆。
const extractedSignatures = new Set<string>();

function exchangeSignature(userText: string): string {
  return `${userText.length}:${userText.slice(0, 64)}`;
}

// ── 合并模式（E-18）：手动确认 / 自动合并，默认手动 ──
const MERGE_MODE_KEY = 'aionui.team.memoryMergeMode';
export type MemoryMergeMode = 'manual' | 'auto';

export function getMemoryMergeMode(): MemoryMergeMode {
  try {
    return localStorage.getItem(MERGE_MODE_KEY) === 'auto' ? 'auto' : 'manual';
  } catch {
    return 'manual';
  }
}

export function setMemoryMergeMode(mode: MemoryMergeMode) {
  try {
    localStorage.setItem(MERGE_MODE_KEY, mode);
  } catch {
    /* storage 不可用时忽略 */
  }
}

/**
 * 新增个人记忆后的合并处理（E-18）：
 * 调 /memories/check 检出与现存记忆的相似性（high/partial 时返回合并预览）→
 * 手动模式：弹窗供用户确认（Arco Modal.confirm，可从任意上下文调用）；
 * 自动模式：直接合并并高亮提示。
 */
async function handleNewMemoryMerge(created: {
  id: string;
  title: string;
  content: string;
  categoryId?: string | null;
  scope?: string;
}): Promise<void> {
  let check: Awaited<ReturnType<typeof teamApi.checkMemorySimilarity>>;
  try {
    check = await teamApi.checkMemorySimilarity({
      title: created.title,
      content: created.content,
      categoryId: created.categoryId ?? null,
      scope: created.scope,
    });
  } catch {
    return; // 查重失败不阻断（可能是模型未绑定）
  }
  if (check.level === 'none' || !check.existingId || !check.mergedTitle || !check.mergedContent) return;

  const doMerge = () =>
    teamApi
      .mergeMemoryPair({
        sourceId: created.id,
        targetId: check.existingId!,
        mergedTitle: check.mergedTitle!,
        mergedContent: check.mergedContent!,
        categoryId: created.categoryId ?? undefined,
      })
      .then((r) => {
        // eslint-disable-next-line no-console
        console.info('[teamMemory] merged pair ok, applied:', r.appliedCount);
      });

  if (getMemoryMergeMode() === 'auto') {
    try {
      await doMerge();
    } catch (e) {
      console.warn('[teamMemory] auto-merge failed:', e instanceof Error ? e.message : String(e));
      // 不阻断：合并失败时保留两条独立记忆，下次整理时兜底
    }
    // E-21：合并结果随整理卡片展示，不再用独立 Toast
    return;
  }

  // 手动模式：弹窗确认（Arco 静态 Modal 可从 service 层调用）
  const { Modal } = await import('@arco-design/web-react');
  const { React } = await import('react');
  Modal.confirm({
    title: '检测到可合并的记忆',
    content: React.createElement(
      'div',
      { style: { lineHeight: 1.8 } },
      React.createElement('p', null, `新记忆「${created.title}」与已有记忆相似，是否合并？`),
      React.createElement(
        'blockquote',
        {
          style: {
            borderLeft: '3px solid var(--color-primary-light-2)',
            paddingLeft: 12,
            margin: '8px 0',
            color: 'var(--color-text-2)',
            fontSize: 13,
          },
        },
        React.createElement('p', null, `合并后标题：${check.mergedTitle}`),
        React.createElement(
          'p',
          null,
          `合并后内容：${(check.mergedContent ?? '').slice(0, 120)}${check.mergedContent.length > 120 ? '…' : ''}`
        )
      ),
      React.createElement(
        'p',
        { style: { color: 'var(--color-text-3)', fontSize: 12 } },
        '合并将把新记忆并入已有条目，源条目将被移除。'
      )
    ),
    okText: '合并',
    cancelText: '保留两条',
    onOk: () => doMerge(),
  });
}

/** 用户本轮是否显式要求团队共享（提交层防御：模型误判 team 时降级 personal）。 */
const TEAM_SHARE_HINT_RE = /团队|共享|全员|大家|同事|一起用/i;

function submitMemorizeBlocks(blocks: MemorizeBlock[], userText: string): void {
  const teamExplicit = TEAM_SHARE_HINT_RE.test(userText);
  for (const rawBlock of blocks) {
    const block =
      rawBlock.audience === 'team' && !teamExplicit ? { ...rawBlock, audience: 'personal' as const } : rawBlock;
    if (block !== rawBlock) {
      // eslint-disable-next-line no-console -- 观测点：归属原则防御性降级
      console.info('[teamMemory] downgrade team->personal（用户未显式要求共享）:', rawBlock.title);
    }
    const request =
      block.audience === 'team'
        ? teamApi.createTeamMemory({
            title: block.title,
            content: block.content,
            category: block.categoryName ?? 'fact',
            memoryScope: block.scope,
            tags: [],
          })
        : teamApi.createMemory({
            title: block.title,
            content: block.content,
            categoryName: block.categoryName ?? undefined,
            scope: block.scope,
          });
    void request
      .then(async (result) => {
        const warning = (result as { warning?: string } | null)?.warning;
        // eslint-disable-next-line no-console -- 观测点：记忆协议提交结果
        console.info(
          '[teamMemory] memorize ->',
          block.audience,
          block.title,
          warning ? `（草稿已建，提交审批未完成：${warning}）` : 'ok'
        );
        // 个人记忆新增后查重 + 双模式合并（E-18）
        if (block.audience === 'personal') {
          const created = result as { id?: string; categoryId?: string | null } | null;
          const createdId = created?.id;
          if (typeof createdId === 'string') {
            void handleNewMemoryMerge({
              id: createdId,
              title: block.title,
              content: block.content,
              categoryId: created?.categoryId ?? null,
              scope: block.scope,
            });
          }
        }
      })
      .finally(() => {
        // E-20：记忆写入后自动触发整理（对话窗口展示整理卡片）
        // 用 dispatchEvent 避开 React 上下文依赖，MemoryConsolidationCard 组件监听并执行
        window.dispatchEvent(new CustomEvent('aionui:memory-consolidation'));
      })
      .catch((error) => {
        console.warn('[teamMemory] memorize submit failed:', block.audience, block.title, String(error));
      });
  }
}

function tryExtractExchange(exchange: { userText: string; assistantText: string } | null, trigger: string): void {
  // eslint-disable-next-line no-console -- 诊断观测点（E-12.2）：任何一处门禁拦截都留痕，便于定位静默失败
  if (!exchange) {
    console.info('[teamMemory] skip(', trigger, '): no completed exchange found');
    return;
  }
  if (!teamBffBaseUrl() || !isMemoryInjectionEnabled()) {
    console.info(
      '[teamMemory] skip(',
      trigger,
      '): bff=',
      teamBffBaseUrl(),
      'injectionEnabled=',
      isMemoryInjectionEnabled()
    );
    return;
  }
  const signature = exchangeSignature(exchange.userText);
  if (extractedSignatures.has(signature)) {
    console.info('[teamMemory] skip: duplicate signature', signature.slice(0, 24));
    return;
  }
  extractedSignatures.add(signature);
  // 记忆协议（E-14）：由模型返回的 <memorize> 标记驱动；是否记忆/进个人还是团队由模型判定
  const blocks = parseMemorizeBlocks(exchange.assistantText);
  if (blocks.length === 0) {
    console.info('[teamMemory] turn completed, no memorize tag in reply (model decided nothing to remember)');
    return;
  }
  submitMemorizeBlocks(blocks, exchange.userText);
}

export interface EnhanceOptions {
  scope?: 'chat' | 'code';
  conversationMode?: 'chat' | 'coding';
  /** 当前会话消息列表（用于上一轮抽取），缺省跳过抽取 */
  messages?: TMessage[];
  /** 知识库开关（对齐 client Q2）：false 时 assemble 不召回 KE 知识，仅注入记忆 */
  includeKnowledge?: boolean;
}

/**
 * 发送前增强：注入记忆上下文 + 触发上一轮交换的记忆抽取。
 * 任何失败（未启用/未登录/BFF 不可达）都返回原文，绝不阻塞发送。
 */
export async function enhanceInputWithTeamMemory(rawInput: string, options: EnhanceOptions = {}): Promise<string> {
  if (!teamBffBaseUrl() || !isMemoryInjectionEnabled() || !rawInput.trim()) return rawInput;

  // 双触发第二路：发送时兜底抽取上一轮交换（与回合结束共用去重注册表，不会重复落库）
  console.info(
    '[teamMemory] enhance gate: bff=',
    teamBffBaseUrl(),
    'enabled=',
    isMemoryInjectionEnabled(),
    'msgs=',
    options.messages?.length ?? 0,
    'lastExchange=',
    findLastCompletedExchange(options.messages ?? []) ? 'hit' : 'null'
  );
  tryExtractExchange(findLastCompletedExchange(options.messages ?? []), 'send');

  try {
    const result = await teamApi.assembleContext(rawInput, {
      scope: options.scope ?? 'chat',
      conversationMode: options.conversationMode ?? 'chat',
      includeKnowledge: options.includeKnowledge,
    });
    const rendered = (result as { rendered?: string | null })?.rendered;
    const directive = buildMemorizeProtocolDirective(await loadMemorizeCategoryNames());
    if (rendered && rendered.trim() && !rawInput.includes(INJECTION_MARK)) {
      return `${INJECTION_MARK}\n${rendered}\n${directive}\n${INJECTION_MARK_END}\n${rawInput}`;
    }
    // 未召回相关记忆时也附带记忆协议（是否有记忆由模型判断，与召回无关）
    if (!rawInput.includes(INJECTION_MARK)) {
      return `${INJECTION_MARK}\n${directive}\n${INJECTION_MARK_END}\n${rawInput}`;
    }
    return rawInput;
  } catch {
    return rawInput;
  }
}

/**
 * 回合结束记忆协议处理（E-14）：助手回复完成（running true→false）即解析 <memorize> 标记并提交；
 * 不再依赖用户发送下一条消息——修复"对话结束/切换会话后该轮记忆永不落库"的缺口。
 * 同一轮只抽取一次（按用户文本去重）；未配置记忆模型时 BFF 返回 skipped，静默。
 */
export function useTeamMemoryTurnExtract(messages: TMessage[], isRunning: boolean) {
  const lastExtractedRef = useRef('');
  const prevRunningRef = useRef(isRunning);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isRunning;
    if (!wasRunning || isRunning) return; // 仅 running true→false 边沿触发

    // 回合结束瞬间 messages 可能尚未完成最终提交（running 翻 false 先于最后一条消息写入 store），
    // 用多轮延迟探测兜住：立即 + 500ms / 1.5s / 3s 共四轮，签名去重保证只处理一次。
    const attempts = [0, 500, 1500, 3000];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of attempts) {
      timers.push(
        setTimeout(() => {
          const current = messagesRef.current;
          const exchange = findLastCompletedExchange(current);
          if (!exchange || exchange.userText === lastExtractedRef.current) return;
          lastExtractedRef.current = exchange.userText;
          tryExtractExchange(exchange, `turn-end${delay ? `+${delay}ms` : ''}`);
        }, delay)
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [isRunning]); // 故意不依赖 messages（用 ref 取最新，避免每次消息更新重复触发边沿逻辑）
}

interface MessageTextLike {
  role?: string;
  type?: string;
  content?: { text?: string; content?: string } | string;
}

function messageText(message: MessageTextLike | TMessage): string {
  const content = (message as MessageTextLike).content;
  if (typeof content === 'string') return content;
  return content?.text ?? content?.content ?? '';
}

/**
 * 从消息列表尾部找最近一组 用户→助手 文本交换（限最近 6 条内，assistant 文本 ≥ 20 字）。
 * AionUi 消息没有 role 字段：用户消息 = type 'text' + position 'right'；助手 = position 'left'。
 */
export function findLastCompletedExchange(messages: TMessage[]): { userText: string; assistantText: string } | null {
  let assistantText: string | null = null;
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 12; index -= 1) {
    const message = messages[index] as unknown as MessageTextLike & {
      type?: string;
      position?: 'left' | 'right';
    };
    if (message.type !== 'text') continue;
    const text = messageText(message).trim();
    if (!text) continue;
    if (assistantText === null && message.position === 'left' && text.length >= 6) {
      assistantText = text.slice(0, 8_000);
      continue;
    }
    if (assistantText !== null && message.position === 'right' && text.length >= 1) {
      return { userText: text.slice(0, 4_000), assistantText };
    }
  }
  return null;
}
