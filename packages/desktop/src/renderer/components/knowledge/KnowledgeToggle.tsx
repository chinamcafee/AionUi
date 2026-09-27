// AionUi（对齐 client 决策 Q2）：「知识库」开关——新会话页输入卡下方、与「在项目中工作」同排。
// ON：本轮问题先到 KE-v2 知识库做一次问答/提取，结果作为参考资料随问题注入 LLM；
// OFF：问题原样发送（与 client 的「KE-v2 工具移出白名单」语义等价）。

import { Tooltip } from '@arco-design/web-react';
import { BookOne } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamAuthOptional } from '@/renderer/hooks/context/TeamAuthContext';
import { useKnowledgeEnabled } from '@/renderer/services/knowledge/knowledgeToggle';

const KnowledgeToggle: React.FC = () => {
  const { t } = useTranslation();
  const auth = useTeamAuthOptional();
  const [enabled, setEnabled] = useKnowledgeEnabled();
  // 与内置知识 MCP 的注入条件一致：仅团队会话认证后可用；无 Provider（如隔离渲染）时隐藏
  if (auth?.view.phase !== 'authenticated') return null;
  const label = t('guid.knowledge.label', { defaultValue: '知识库' });
  const tooltip = enabled
    ? t('guid.knowledge.tooltipOn', { defaultValue: '知识库已连接：提问会先检索团队知识库，再交给模型统一处理' })
    : t('guid.knowledge.tooltipOff', { defaultValue: '开启后，提问会先检索 KE-v2 团队知识库并作为上下文注入' });

  return (
    <Tooltip content={tooltip} position='top'>
      <button
        type='button'
        role='switch'
        aria-checked={enabled}
        aria-label={label}
        data-testid='knowledge-toggle'
        onClick={() => setEnabled(!enabled)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 14,
          fontWeight: 500,
          color: enabled ? 'rgb(var(--primary-6))' : 'var(--color-text-3)',
          background: 'transparent',
          border: 'none',
          padding: '4px 6px',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span
          aria-hidden='true'
          style={{
            width: 28,
            height: 16,
            borderRadius: 8,
            background: enabled ? 'rgb(var(--primary-6))' : 'var(--color-fill-3)',
            position: 'relative',
            transition: 'background 0.2s ease',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: enabled ? 14 : 2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.2s ease',
            }}
          />
        </span>
        <BookOne theme='outline' size='14' fill='currentColor' />
        {label}
      </button>
    </Tooltip>
  );
};

export default KnowledgeToggle;
