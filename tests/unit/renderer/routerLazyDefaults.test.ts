// 路由懒加载守卫：Router.tsx 中每个 React.lazy(() => import(...)) 的目标模块都必须有 default 导出。
// 缺失 default 时 lazy 得到 { default: undefined }，渲染 <undefined/> 抛
// "Element type is invalid: expected a string ... but got: undefined"，表现为整页白屏
// （实例：/settings/ke-settings 曾因此白屏）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTER = resolve(__dirname, '../../../packages/desktop/src/renderer/components/layout/Router.tsx');
const RENDERER_ROOT = resolve(__dirname, '../../../packages/desktop/src/renderer');

function resolveModule(rel: string): string | null {
  const candidates = [`${rel}.tsx`, `${rel}.ts`, join(rel, 'index.tsx'), join(rel, 'index.ts')];
  for (const candidate of candidates) {
    const path = join(RENDERER_ROOT, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

describe('Router 懒加载模块 default 导出守卫', () => {
  const source = readFileSync(ROUTER, 'utf8');
  const targets = [...source.matchAll(/import\(['"]@renderer\/([^'"]+)['"]\)/g)].map((m) => m[1]!);

  it('能解析出至少 10 个懒加载目标（防止正则失效导致空跑）', () => {
    expect(targets.length).toBeGreaterThanOrEqual(10);
  });

  it.each([...new Set(targets)])('%s 具有 default 导出', (rel) => {
    const path = resolveModule(rel);
    expect(path, `模块文件不存在：${rel}`).not.toBeNull();
    const moduleSource = readFileSync(path!, 'utf8');
    // `export default X` 或 `export { default } from './x'` 均可满足 React.lazy
    const hasDefault = /export\s+default\b/.test(moduleSource) || /export\s*\{\s*default\s*\}/.test(moduleSource);
    expect(hasDefault, `${rel} 缺少 default 导出（React.lazy 会白屏）`).toBe(true);
  });
});

// 保持与 dirname 解析一致的占位（避免打包器把测试目录推断错位）
void dirname;
