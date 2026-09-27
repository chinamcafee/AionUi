// E-26 S4：知识库设置 Tab——移植 KE-v2 SettingsPage 的全部 5 项设置。
// 与 KE-v2 Web 共用 API（web-operations: settings.get/update），双向同步。
// UI 采用设置区房式风格：SettingsPageWrapper + SettingsPageHeader + bg-2 分节容器 + PreferenceRow 行。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, InputNumber, Message, Skeleton } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { teamApi, TeamApiError, teamBffBaseUrl } from '@/renderer/api/teamClient';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import SettingsPageHeader from './components/SettingsPageHeader';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';

interface KESettings {
  pdf_scan_threshold: string;
  vision_concurrency: string;
  pipeline_concurrency: string;
  embedding_concurrency: string;
  extraction_max_retries: string;
  [key: string]: string;
}

const DEFAULTS: KESettings = {
  pdf_scan_threshold: '50',
  vision_concurrency: '3',
  pipeline_concurrency: '5',
  embedding_concurrency: '4',
  extraction_max_retries: '3',
};

const SETTING_META: Array<{ key: keyof KESettings; label: string; desc: string; min?: number; max?: number }> = [
  {
    key: 'pdf_scan_threshold',
    label: 'PDF 扫描页阈值',
    desc: '字符数小于此值的页面视为扫描/纯图页，整页送视觉模型处理',
    min: 1,
  },
  { key: 'vision_concurrency', label: '视觉模型并发数', desc: '同一文档图片批量送视觉模型的并发上限', min: 1, max: 10 },
  {
    key: 'pipeline_concurrency',
    label: '抽取并发数',
    desc: 'grag 实体/关系抽取 LLM 调用并发上限（过高易触发限流，建议 2-3）',
    min: 1,
    max: 8,
  },
  { key: 'embedding_concurrency', label: '向量化并发数', desc: '向量化并发批次数（每批 16 条）', min: 1, max: 8 },
  {
    key: 'extraction_max_retries',
    label: '抽取重试上限',
    desc: '单片段抽取失败重试上限（含首次，如 LLM 输出畸形 JSON）',
    min: 1,
    max: 10,
  },
];

export const KESettingsTab: React.FC = () => {
  const { t } = useTranslation();
  const teamEnabled = Boolean(teamBffBaseUrl());
  const [settings, setSettings] = useState<KESettings>(DEFAULTS);
  const [draft, setDraft] = useState<KESettings>(DEFAULTS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await teamApi.getKESettings();
      const merged = { ...DEFAULTS, ...(result as Record<string, string>) };
      setSettings(merged);
      setDraft(merged);
    } catch (error) {
      Message.error(`加载设置失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await teamApi.updateKESettings(draft);
      setSettings(draft);
      Message.success('设置已保存（与 KE-v2 Web 同步生效）');
    } catch (error) {
      Message.error(`保存失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }, [draft]);

  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <SettingsPageHeader
        title={t('settings.keSettings', { defaultValue: '知识库设置' })}
        description='知识引擎解析、抽取与向量化的运行参数；与 KE-v2 Web 端双向同步，修改后于下次摄入/重建时应用。'
        actions={
          <>
            <Button size='small' onClick={() => setDraft(settings)} disabled={!dirty || saving}>
              重置
            </Button>
            <Button size='small' type='primary' loading={saving} disabled={!dirty} onClick={() => void save()}>
              保存更改
            </Button>
          </>
        }
      />

      {!teamEnabled ? (
        <div className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
          <div className='text-13px text-t-tertiary'>请先启用团队功能（设置 → 团队平台）后再配置知识引擎参数。</div>
        </div>
      ) : (
        <div className='mt-16px space-y-16px'>
          <section className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
            {loading ? (
              <Skeleton text={{ rows: 5, width: ['60%', '75%', '55%', '70%', '50%'] }} animation />
            ) : (
              <div className='flex flex-col divide-y divide-border-2'>
                {SETTING_META.map(({ key, label, desc, min, max }) => (
                  <PreferenceRow key={key} label={label} description={desc}>
                    <InputNumber
                      style={{ width: 140 }}
                      value={Number(draft[key]) || Number(DEFAULTS[key])}
                      min={min}
                      max={max}
                      disabled={saving}
                      onChange={(value) => setDraft((prev) => ({ ...prev, [key]: String(value ?? DEFAULTS[key]) }))}
                    />
                  </PreferenceRow>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </SettingsPageWrapper>
  );
};

// Router 以 React.lazy(() => import(...)) 懒加载本页，必须提供 default 导出；
// 缺失时 lazy 得到 { default: undefined }，渲染 <undefined/> 抛
// "Element type is invalid"，表现为整页白屏。
export default KESettingsTab;
