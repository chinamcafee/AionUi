/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// 团队空间导航入口（M2/M4 页面的侧栏挂载点）：记忆（个人+团队）与知识库。
// 仅在团队功能启用（TeamAuthProvider.featureEnabled）时渲染，见 Sider/index.tsx。

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { Bookshelf, Brain } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderTeamEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderTeamEntry: React.FC<SiderTeamEntryProps & { icon: React.ReactNode; label: string }> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
  icon,
  label,
}) => {
  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={label} position='right'>
        <div
          className={classNames(
            'w-full h-34px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary',
            isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
        >
          {icon}
        </div>
      </Tooltip>
    );
  }

  return (
    <div
      data-mobile={isMobile}
      className={classNames(
        'group w-full h-34px px-10px flex items-center gap-8px cursor-pointer transition-colors rd-8px text-14px text-t-primary select-none',
        isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
      )}
      onClick={onClick}
    >
      <span className='flex items-center shrink-0 opacity-80 group-hover:opacity-100'>{icon}</span>
      <span className='flex-1 truncate'>{label}</span>
    </div>
  );
};

const iconProps = {
  theme: 'outline',
  size: '20',
  fill: 'currentColor',
  className: 'block leading-none shrink-0',
  style: { lineHeight: 0 },
} as const;

export const SiderMemoryEntry: React.FC<SiderTeamEntryProps> = (props) => {
  const { t } = useTranslation();
  return (
    <SiderTeamEntry
      {...props}
      icon={<Brain {...iconProps} />}
      label={t('teamWorkspace.memory', { defaultValue: '记忆' })}
    />
  );
};

export const SiderKnowledgeEntry: React.FC<SiderTeamEntryProps> = (props) => {
  const { t } = useTranslation();
  return (
    <SiderTeamEntry
      {...props}
      icon={<Bookshelf {...iconProps} />}
      label={t('teamWorkspace.knowledge', { defaultValue: '知识库' })}
    />
  );
};
