import type { IProvider } from '@/common/config/storage';
import ModalHOC from '@/renderer/utils/ui/ModalHOC';
import { Form, Input, Select, Tag } from '@arco-design/web-react';
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AionModal from '@/renderer/components/base/AionModal';
import { getProviderLogo } from '@/renderer/utils/model/modelPlatforms';
import { ProviderLogo } from '@/renderer/components/agent/ThemedLogo';

/**
 * 编辑模型平台：只编辑分组内所有模型共用的信息（供应商名称、API 地址、API Key、
 * Bedrock 凭证）。模型名称与模型能力属于单个模型，分别在「+ 添加模型」和
 * 每个模型的「配置模型」弹窗中维护。
 */
const EditModeModal = ModalHOC<{ data?: IProvider; onChange(data: IProvider): void }>(
  ({ modalProps, modalCtrl, ...props }) => {
    const { t } = useTranslation();
    const { data } = props;
    const [form] = Form.useForm();

    // Watch bedrockAuthMethod only for UI conditional rendering (not for auto-refresh)
    const bedrockAuthMethod = Form.useWatch('bedrockAuthMethod', form);
    const isBedrock = data?.platform === 'bedrock';

    // 获取供应商 Logo / Get provider logo
    const providerLogo = useMemo(() => {
      return getProviderLogo({ name: data?.name, base_url: data?.base_url, platform: data?.platform });
    }, [data?.name, data?.base_url, data?.platform]);

    const isFullUrl = data?.is_full_url ?? false;

    useEffect(() => {
      if (data) {
        form.setFieldsValue({
          name: data.name,
          base_url: data.base_url,
          api_key: data.api_key,
          bedrockAuthMethod: data.bedrock_config?.auth_method || 'accessKey',
          bedrockRegion: data.bedrock_config?.region || 'us-east-1',
          bedrockAccessKeyId: data.bedrock_config?.access_key_id || '',
          bedrockSecretAccessKey: data.bedrock_config?.secret_access_key || '',
          bedrockProfile: data.bedrock_config?.profile || '',
        });
      }
    }, [data, form]);

    return (
      <AionModal
        variant='standard'
        visible={modalProps.visible}
        onCancel={modalCtrl.close}
        header={{ title: t('settings.editModel'), showClose: true }}
        style={{ minHeight: '400px' }}
        onOk={async () => {
          try {
            const values = await form.validate();
            // 只覆盖平台级字段；models / model_settings / capabilities 等逐模型数据保持原样
            const updatedProvider: IProvider = {
              ...data,
              name: values.name,
              base_url: values.base_url,
              api_key: values.api_key,
            };

            // Add Bedrock configuration if platform is Bedrock
            if (isBedrock) {
              updatedProvider.bedrock_config = {
                auth_method: values.bedrockAuthMethod,
                region: values.bedrockRegion,
                ...(values.bedrockAuthMethod === 'accessKey'
                  ? {
                      access_key_id: values.bedrockAccessKeyId,
                      secret_access_key: values.bedrockSecretAccessKey,
                    }
                  : {
                      profile: values.bedrockProfile,
                    }),
              };
            }

            props.onChange(updatedProvider);
            modalCtrl.close();
          } catch {
            // Validation failed — Arco Form highlights invalid fields automatically
          }
        }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <div>
          <Form form={form} layout='vertical'>
            {/* 模型供应商名称（可编辑，带 Logo）/ Model Provider name (editable, with Logo) */}
            <Form.Item
              label={
                <span className='inline-flex items-center gap-6px'>
                  <ProviderLogo logo={providerLogo} name={data?.name || ''} size={16} />
                  <span>{t('settings.modelProvider')}</span>
                </span>
              }
              field='name'
              required
              rules={[{ required: true }]}
            >
              <Input placeholder={t('settings.modelProvider')} />
            </Form.Item>

            {/* Base URL */}
            <Form.Item
              hidden={isBedrock}
              label={
                <span className='inline-flex items-center gap-4px'>
                  {t('settings.apiEndpoint', 'API 请求地址')}
                  {isFullUrl && (
                    <Tag size='small' color='arcoblue'>
                      {t('settings.fullUrl', '完整URL')}
                    </Tag>
                  )}
                </span>
              }
              required={data?.platform !== 'gemini' && data?.platform !== 'gemini-vertex-ai' && !isBedrock}
              rules={[{ required: data?.platform !== 'gemini' && data?.platform !== 'gemini-vertex-ai' && !isBedrock }]}
              field={'base_url'}
            >
              <Input />
            </Form.Item>

            <Form.Item
              hidden={isBedrock}
              label={t('settings.apiKey')}
              required={!isBedrock}
              rules={[{ required: !isBedrock }]}
              field={'api_key'}
              extra={<div className='text-11px text-t-secondary mt-2'>💡 {t('settings.multiApiKeyEditTip')}</div>}
            >
              <Input.TextArea rows={4} placeholder={t('settings.apiKeyPlaceholder')} />
            </Form.Item>

            {/* AWS Bedrock Authentication Method */}
            <Form.Item
              hidden={!isBedrock}
              label={t('settings.bedrock.authMethod')}
              field={'bedrockAuthMethod'}
              required={isBedrock}
              rules={[{ required: isBedrock }]}
            >
              <Select>
                <Select.Option value='accessKey'>{t('settings.bedrock.authMethodAccessKey')}</Select.Option>
                <Select.Option value='profile'>{t('settings.bedrock.authMethodProfile')}</Select.Option>
              </Select>
            </Form.Item>

            {/* AWS Region */}
            <Form.Item
              hidden={!isBedrock}
              label={t('settings.bedrock.region')}
              field={'bedrockRegion'}
              required={isBedrock}
              rules={[{ required: isBedrock }]}
              extra={t('settings.bedrock.regionHint')}
            >
              <Select showSearch>
                <Select.Option value='us-east-1'>US East (N. Virginia)</Select.Option>
                <Select.Option value='us-west-2'>US West (Oregon)</Select.Option>
                <Select.Option value='eu-west-1'>Europe (Ireland)</Select.Option>
                <Select.Option value='eu-central-1'>Europe (Frankfurt)</Select.Option>
                <Select.Option value='ap-southeast-1'>Asia Pacific (Singapore)</Select.Option>
                <Select.Option value='ap-northeast-1'>Asia Pacific (Tokyo)</Select.Option>
                <Select.Option value='ap-southeast-2'>Asia Pacific (Sydney)</Select.Option>
                <Select.Option value='ca-central-1'>Canada (Central)</Select.Option>
              </Select>
            </Form.Item>

            {/* Access Key ID */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'accessKey'}
              label={t('settings.bedrock.accessKeyId')}
              field={'bedrockAccessKeyId'}
              required={isBedrock && bedrockAuthMethod === 'accessKey'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'accessKey' }]}
            >
              <Input.Password placeholder='AKIA...' visibilityToggle />
            </Form.Item>

            {/* Secret Access Key */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'accessKey'}
              label={t('settings.bedrock.secretAccessKey')}
              field={'bedrockSecretAccessKey'}
              required={isBedrock && bedrockAuthMethod === 'accessKey'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'accessKey' }]}
            >
              <Input.Password visibilityToggle />
            </Form.Item>

            {/* AWS Profile */}
            <Form.Item
              hidden={!isBedrock || bedrockAuthMethod !== 'profile'}
              label={t('settings.bedrock.profile')}
              field={'bedrockProfile'}
              required={isBedrock && bedrockAuthMethod === 'profile'}
              rules={[{ required: isBedrock && bedrockAuthMethod === 'profile' }]}
              extra={t('settings.bedrock.profileHint')}
            >
              <Input placeholder='default' />
            </Form.Item>
          </Form>
        </div>
      </AionModal>
    );
  }
);

export default EditModeModal;
