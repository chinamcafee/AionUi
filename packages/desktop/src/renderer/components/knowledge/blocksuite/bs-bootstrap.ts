/**
 * BlockSuite 全局幂等 bootstrap —— 注册自定义元素 + 斜杠菜单中文化
 *
 * 关键：@blocksuite/blocks/effects 和 @blocksuite/presets/effects 调用
 * customElements.define() 没有幂等保护，二次调用会抛 NotSupportedError。
 * 用模块级布尔门 + 缓存 Promise 保证只执行一次。
 *
 * 必须在 React render 之前调用一次（main.tsx），各编辑器组件防御性再调用。
 */
let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

export function bootstrapBlockSuite(): Promise<void> {
  if (bootstrapped) return Promise.resolve();
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const presets = await import('@blocksuite/presets');
    const { localizeSlashMenu } = await import('./localize');

    const blocksEff = await import('@blocksuite/blocks/effects');
    if (typeof blocksEff.effects === 'function') {
      try {
        blocksEff.effects();
      } catch {
        /* already registered */
      }
    }
    const presetsEff = await import('@blocksuite/presets/effects');
    try {
      presetsEff.effects();
    } catch {
      /* already registered */
    }

    await localizeSlashMenu();

    const { AffineEditorContainer } = presets;
    if (!customElements.get('affine-editor-container') && AffineEditorContainer) {
      try {
        customElements.define('affine-editor-container', AffineEditorContainer);
      } catch {
        /* already defined */
      }
    }

    bootstrapped = true;
  })();
  return bootstrapPromise;
}
