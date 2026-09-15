/**
 * E2E：团队平台（org）主链路 —— 登录入口 → 设置页 → 记忆/知识页骨架（M6/T6.3）。
 *
 * 说明（执行前提）：团队功能默认关闭，这些用例验证「关闭态零侵入」与
 * 「入口在启用后出现」。完整登录→上传→检索链路需要 team-platform 栈（compose + go），
 * 由 tests/e2e/team-platform-live.md 所述的 e2e-live 模式承载（运维侧执行）；
 * mock 模式的 BFF 全链路见 tests/unit/team/e2e/bffMock.e2e.test.ts（T7.7）。
 */
import { test, expect } from '../../fixtures';

test.describe('团队平台（org）关闭态零回归', () => {
  test('登录页不渲染团队账号入口（featureEnabled=false）', async ({ page }) => {
    await page.goto('/#/');
    // 本地账号登录表单存在
    await expect(page.locator('.login-page__form').or(page.locator('input#username'))).toBeVisible({ timeout: 20000 });
    // 团队入口不应渲染（BFF 未启用）
    await expect(page.locator('text=使用团队账号登录')).toHaveCount(0);
  });

  test('设置页包含团队平台入口路由', async ({ page }) => {
    await page.goto('/#/settings/team');
    // 未启用团队功能时配置区可见（开关默认关）
    await expect(page.locator('text=团队平台').first()).toBeVisible({ timeout: 20000 });
  });

  test('记忆/知识页在未登录团队账号时给出引导而非崩溃', async ({ page }) => {
    await page.goto('/#/memory');
    await expect(page.locator('text=请先在登录页使用团队账号登录').first()).toBeVisible({ timeout: 20000 });
    await page.goto('/#/knowledge');
    await expect(page.locator('text=请先在登录页使用团队账号登录').first()).toBeVisible({ timeout: 20000 });
  });
});
