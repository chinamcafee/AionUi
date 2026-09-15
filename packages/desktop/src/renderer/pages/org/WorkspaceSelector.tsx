// AionUi 新增（T1.12）：租户/团队切换器。移植 client/src/auth/TeamSelector.tsx 的交互，Arco Select 重实现。
// 注意：此组件挂在对话主界面侧栏，与既有 Agent 团队（pages/team）无关联（命名隔离见 docs/03 D-1）。

import React from 'react';
import { Select, Space, Typography } from '@arco-design/web-react';
import { IconSwap, IconUser } from '@arco-design/web-react/icon';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';

export const WorkspaceSelector: React.FC = () => {
  const { view, bootstrap, switchTeam } = useTeamAuth();
  if (view.phase !== 'authenticated' || !bootstrap?.tenant) return null;

  const options = bootstrap.teams.map((team) => ({
    label: `${bootstrap.tenant!.name} / ${team.name}`,
    value: team.id,
  }));
  const activeTeam = bootstrap.activeTeam;

  return (
    <Space size={8} style={{ padding: '0 12px' }}>
      <IconUser />
      <Select
        style={{ minWidth: 200 }}
        size='small'
        value={activeTeam?.id}
        options={options}
        prefixIcon={<IconSwap />}
        onChange={(teamId) => {
          void switchTeam(bootstrap.tenant!.id, teamId as string);
        }}
      />
      {activeTeam?.status === 'suspended' && (
        <Typography.Text type='warning' size='small'>
          suspended
        </Typography.Text>
      )}
    </Space>
  );
};
