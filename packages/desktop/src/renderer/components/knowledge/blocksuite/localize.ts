/**
 * BlockSuite 斜杠菜单（/ 触发的快捷菜单）中文化。
 *
 * 这个 BlockSuite 版本（0.19.x）没有官方 i18n API，菜单项名称是硬编码的英文
 * （见 node_modules/@blocksuite/blocks/dist/root-block/widgets/slash-menu/config.js）。
 * 这里通过修改 AffineSlashMenuWidget.DEFAULT_CONFIG.items 的 name / groupName 属性
 * 替换为中文（DEFAULT_CONFIG 是可变静态对象，菜单渲染时直接读取它）。
 *
 * 调用时机：在 effects 注册之后、创建编辑器之前，调用一次即可（幂等）。
 */

let applied = false;

/** 英文 → 中文 名称映射表 */
const ZH: Record<string, string> = {
  // 分组
  Basic: '基础',
  Headings: '标题',
  List: '列表',
  Style: '样式',
  'Content & Media': '内容与媒体',
  Database: '数据库',
  Date: '日期',
  Document: '文档',
  Page: '页面',
  Actions: '操作',
  'Document Group & Frame': '分组与画框',

  // 基础块
  Text: '文本',
  'Heading 1': '一级标题',
  'Heading 2': '二级标题',
  'Heading 3': '三级标题',
  'Heading 4': '四级标题',
  'Heading 5': '五级标题',
  'Heading 6': '六级标题',
  'Other Headings': '其他标题',
  'Bulleted List': '无序列表',
  'Numbered List': '有序列表',
  'To-do List': '待办列表',
  'Code Block': '代码块',
  Quote: '引用',
  Divider: '分隔线',

  // 内容与媒体
  Image: '图片',
  Link: '链接',
  Attachment: '附件',
  'Inline equation': '行内公式',
  'New Doc': '新文档',
  'Linked Doc': '关联文档',
  YouTube: 'YouTube',
  GitHub: 'GitHub',
  Figma: 'Figma',
  Loom: 'Loom',
  Equation: '公式',

  // 数据库 / 视图
  Todo: '待办',
  'Table View': '表格视图',
  'Kanban View': '看板视图',

  // 日期
  Today: '今天',
  Tomorrow: '明天',
  Yesterday: '昨天',
  Now: '现在',

  // 画框 / 分组
  'Frame: ': '画框：',
  'Group: ': '分组：',

  // 操作（右键菜单等可能复用）
  'Move Up': '上移',
  'Move Down': '下移',
  Copy: '复制',
  Duplicate: '复制副本',
  Delete: '删除',
};

/**
 * 把斜杠菜单项中文化（幂等，重复调用安全）。
 * 需在 @blocksuite/blocks/effects() 之后调用，确保 AffineSlashMenuWidget 已注册。
 */
export async function localizeSlashMenu(): Promise<void> {
  if (applied) return;
  try {
    const blocks = await import('@blocksuite/blocks');
    const Widget = (
      blocks as unknown as {
        AffineSlashMenuWidget?: { DEFAULT_CONFIG?: { items?: unknown[] } };
      }
    ).AffineSlashMenuWidget;
    const items = Widget?.DEFAULT_CONFIG?.items;
    if (!Array.isArray(items)) return;

    for (const it of items) {
      const item = it as Record<string, unknown>;
      if (typeof item.groupName === 'string' && ZH[item.groupName]) {
        item.groupName = ZH[item.groupName];
      }
      if (typeof item.name === 'string' && ZH[item.name]) {
        item.name = ZH[item.name];
      }
      // 子菜单（Other Headings → 其他标题 的子项）
      const sub = item.subMenu;
      if (Array.isArray(sub)) {
        for (const s of sub) {
          const si = s as Record<string, unknown>;
          if (typeof si.groupName === 'string' && ZH[si.groupName]) si.groupName = ZH[si.groupName];
          if (typeof si.name === 'string' && ZH[si.name]) si.name = ZH[si.name];
        }
      }
    }
    applied = true;
  } catch (e) {
    console.warn('[localize] 斜杠菜单中文化失败（不影响功能）：', e);
  }
}
