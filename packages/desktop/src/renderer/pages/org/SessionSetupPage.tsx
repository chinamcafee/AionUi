// AionUi 新增（T1.12）：首次登录后的租户/团队选择页。移植 client/src/auth/SessionSetupPage 的视图分支。

import React from 'react';
import { Button, Card, Empty, Result, Space, Typography } from '@arco-design/web-react';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';

export const SessionSetupPage: React.FC = () => {
  const { view, switchTeam, logout, refresh } = useTeamAuth();

  if (view.phase === 'tenant_required' || view.phase === 'team_required') {
    const isTeamStep = view.phase === 'team_required';
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Card title={isTeamStep ? '选择团队' : '选择组织'} style={{ width: 420 }}>
          {isTeamStep ? (
            <Space direction='vertical' style={{ width: '100%' }}>
              <Typography.Text type='secondary'>请选择要进入的团队（可在顶部随时切换）。</Typography.Text>
              {view.bootstrap.teams.map((team) => (
                <Button
                  key={team.id}
                  long
                  type={team.status === 'active' ? 'primary' : 'secondary'}
                  disabled={team.status !== 'active'}
                  onClick={() => void switchTeam(view.bootstrap.tenant!.id, team.id)}
                >
                  {team.name} · {team.roleCode}
                </Button>
              ))}
              {view.bootstrap.teams.length === 0 && <Empty description='暂无可加入的团队，请联系管理员邀请' />}
            </Space>
          ) : (
            <Typography.Text type='secondary'>账号尚未关联组织，请联系管理员完成邀请后刷新。</Typography.Text>
          )}
          <Space style={{ marginTop: 16 }}>
            <Button onClick={() => void refresh()}>刷新</Button>
            <Button type='text' onClick={() => void logout()}>
              退出登录
            </Button>
          </Space>
        </Card>
      </div>
    );
  }

  if (view.phase === 'membership_suspended') {
    return (
      <Result
        status='warning'
        title='团队成员身份已停用'
        subTitle='当前团队成员身份被停用，无法进入团队工作区。'
        extra={
          <Button type='primary' onClick={() => void logout()}>
            退出登录
          </Button>
        }
      />
    );
  }

  return null;
};
