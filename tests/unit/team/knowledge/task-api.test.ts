// E-23 对齐 KE-v2：任务面板纯逻辑单测（阶段文案、进度估算、状态文案），逐条对齐 KE-v2 UploadTaskDock。

import { describe, expect, it } from 'vitest';
import { logPercent, overallPercent, stageLabel, statusText } from '@/renderer/services/knowledge/task-api';

describe('stageLabel（与 KE-v2 STAGE_LABELS 一致）', () => {
  it('已知阶段映射为中文，未知阶段原样返回，空值返回空串', () => {
    expect(stageLabel('vision')).toBe('视觉');
    expect(stageLabel('image_extract')).toBe('图片提取');
    expect(stageLabel('activating')).toBe('activating');
    expect(stageLabel(undefined)).toBe('');
  });
});

describe('logPercent（对齐 KE-v2：current/total 优先，其次解析 detail 的 N/M）', () => {
  it('显式 current/total 四舍五入取整', () => {
    expect(logPercent({ stage: 'vision', current: 3, total: 90 })).toBe(3);
    expect(logPercent({ stage: 'chunk', current: 1, total: 3 })).toBe(33);
  });

  it('无显式字段时从 detail 文本解析 N/M', () => {
    expect(logPercent({ stage: 'chunk', detail: '片段 5/29 处理中：摘要' })).toBe(17);
    expect(logPercent({ stage: 'chunk', detail: '没有进度信息' })).toBeNull();
    expect(logPercent(undefined)).toBeNull();
  });
});

describe('overallPercent（对齐 KE-v2 overallPct）', () => {
  it('非 building 一律 100', () => {
    expect(overallPercent({ status: 'done', logs: [] })).toBe(100);
    expect(overallPercent({ status: 'failed', logs: [] })).toBe(100);
  });

  it('显式 percent 优先', () => {
    expect(overallPercent({ status: 'building', logs: [{ stage: 'parsing', percent: 42 }] })).toBe(42);
  });

  it('阶段基值兜底，extract/vision 用子进度插值', () => {
    expect(overallPercent({ status: 'building', logs: [] })).toBe(20);
    expect(overallPercent({ status: 'building', logs: [{ stage: 'report' }] })).toBe(90);
    expect(overallPercent({ status: 'building', logs: [{ stage: 'extract', current: 1, total: 2 }] })).toBe(60);
    expect(overallPercent({ status: 'building', logs: [{ stage: 'vision', current: 1, total: 2 }] })).toBe(23);
  });
});

describe('statusText（对齐 KE-v2 行内文案）', () => {
  it('五种状态文案一致', () => {
    expect(statusText({ status: 'building' })).toBe('构建中…');
    expect(statusText({ status: 'done', result: { entities: 7 } })).toBe('7 实体');
    expect(statusText({ status: 'done' })).toBe('0 实体');
    expect(statusText({ status: 'parse_failed' })).toBe('已跳过');
    expect(statusText({ status: 'cancelled' })).toBe('已终止');
    expect(statusText({ status: 'failed' })).toBe('失败');
  });
});
