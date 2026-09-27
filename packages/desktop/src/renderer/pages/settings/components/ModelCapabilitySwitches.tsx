// E-27：模型能力并列开关（文本/视觉/嵌入），添加/配置模型表单与列表能力 tag 共用。
// 单一数据源：model_settings[model]（逐模型持久化，AionCore SQLite JSON 往返）。
// 列表 tag 与配置弹窗都经由 readCapabilityState 读取，保证两者显示完全一致。

import React from 'react';
import { Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { IProvider, ModelSettings, ModelType } from '@/common/config/storage';
import type { ModelOpenAiApiModeChoice } from '@/common/utils/modelCapabilities';

export interface CapabilitySwitchState {
  text: boolean;
  vision: boolean;
  embedding: boolean;
}

export const DEFAULT_CAPABILITY_STATE: CapabilitySwitchState = { text: true, vision: false, embedding: false };

/**
 * Read one model's capability switch state. Shared by the model list tags and
 * the configure-model modal so both always render the same capabilities.
 */
export function readCapabilityState(provider: IProvider | undefined, model: string | undefined): CapabilitySwitchState {
  const settings = model ? provider?.model_settings?.[model] : undefined;
  if (settings?.is_embedding === true || settings?.capabilities?.includes('embedding')) {
    return { text: false, vision: false, embedding: true };
  }
  const caps = settings?.capabilities;
  if (caps) {
    return { text: caps.includes('text'), vision: caps.includes('vision'), embedding: false };
  }
  // Legacy data without an explicit capability list: an image_input override
  // implies vision, everything else falls back to the default text state.
  if (settings?.image_input === 'supported') {
    return { text: true, vision: true, embedding: false };
  }
  return DEFAULT_CAPABILITY_STATE;
}

/**
 * Write the capability switch state back into per-model model_settings for the
 * given models: capabilities list, is_embedding marker, image_input override
 * and the OpenAI wire API mode. Entries for other models are left untouched.
 */
export function buildCapabilityModelSettings(
  previous: IProvider['model_settings'],
  models: string[],
  state: CapabilitySwitchState,
  openAiApiMode: ModelOpenAiApiModeChoice = 'auto'
): IProvider['model_settings'] {
  const next: Record<string, ModelSettings> = { ...previous };
  for (const model of models) {
    const settings: ModelSettings = { ...next[model] };
    if (state.embedding) {
      settings.capabilities = ['embedding'];
      settings.is_embedding = true;
      settings.image_input = 'unsupported';
    } else {
      const caps: ModelType[] = [];
      if (state.text) caps.push('text');
      if (state.vision) caps.push('vision');
      settings.capabilities = caps;
      delete settings.is_embedding;
      // Vision on pins image_input=supported; vision off removes the override
      // so automatic catalog detection applies again.
      if (state.vision) settings.image_input = 'supported';
      else delete settings.image_input;
    }
    if (openAiApiMode !== 'auto') settings.openai_api_mode = openAiApiMode;
    else delete settings.openai_api_mode;
    next[model] = settings;
  }
  return next;
}

interface Props {
  value: CapabilitySwitchState;
  onChange: (next: CapabilitySwitchState) => void;
}

const Row: React.FC<{
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, desc, checked, disabled, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <Switch size='small' checked={checked} disabled={disabled} onChange={onChange} />
    <div>
      <div className='text-13px font-500 text-t-primary'>{label}</div>
      <div className='text-12px text-t-secondary' style={{ lineHeight: 1.4 }}>
        {desc}
      </div>
    </div>
  </div>
);

export const ModelCapabilitySwitchGroup: React.FC<Props> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const embeddingOn = value.embedding;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      <Row
        label={t('settings.modelCapability.textLabel')}
        desc={t('settings.modelCapability.textDesc')}
        checked={value.text}
        disabled={embeddingOn}
        onChange={(v) => onChange({ ...value, text: v, vision: v ? value.vision : false })}
      />
      <Row
        label={t('settings.modelCapability.visionLabel')}
        desc={t('settings.modelCapability.visionDesc')}
        checked={value.vision}
        disabled={embeddingOn}
        onChange={(v) => onChange({ ...value, vision: v })}
      />
      <Row
        label={t('settings.modelCapability.embeddingLabel')}
        desc={t('settings.modelCapability.embeddingDesc')}
        checked={value.embedding}
        onChange={(v) =>
          onChange(v ? { text: false, vision: false, embedding: true } : { ...DEFAULT_CAPABILITY_STATE })
        }
      />
    </div>
  );
};
