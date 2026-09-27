// E-23 K10：知识库页——四 Tab + ErrorBoundary（防单 Tab 异常白屏）。

import React, { Component, useState, type ReactNode, type ErrorInfo } from 'react';
import { Alert, Empty, Spin, Tabs } from '@arco-design/web-react';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { KnowledgeTaskDocks } from '@/renderer/components/knowledge/TaskDock';

class TabErrorBoundary extends Component<{ children: ReactNode; tabName: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[KnowledgeTab:${this.props.tabName}]`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <Alert
          type='error'
          title={`${this.props.tabName} 加载异常`}
          content={this.state.error.message}
          style={{ margin: 16 }}
        />
      );
    }
    return this.props.children;
  }
}

const LazyDocs = React.lazy(() => import('./DocsTab').then((m) => ({ default: m.DocsTab })));
const LazyLibrary = React.lazy(() => import('./LibraryTab').then((m) => ({ default: m.LibraryTab })));
const LazyOrganizers = React.lazy(() => import('./OrganizersTab').then((m) => ({ default: m.OrganizersTab })));
const LazyGraph = React.lazy(() => import('./GraphTab').then((m) => ({ default: m.GraphTab })));

const tabFallback = (
  <div style={{ textAlign: 'center', padding: 48 }}>
    <Spin tip='加载中…' />
  </div>
);

const KnowledgePage: React.FC = () => {
  const { view } = useTeamAuth();
  const [tab, setTab] = useState('docs');

  if (view.phase !== 'authenticated') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty description='请先在登录页使用团队账号登录后使用知识库' />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <Tabs activeTab={tab} onChange={(key) => setTab(key as string)} type='card-gutter'>
        <Tabs.TabPane key='docs' title='可编辑文档' />
        <Tabs.TabPane key='library' title='资料库' />
        <Tabs.TabPane key='organizers' title='分组与标签' />
        <Tabs.TabPane key='graph' title='知识图谱' />
      </Tabs>
      <div style={{ marginTop: 12 }}>
        {tab === 'docs' && (
          <TabErrorBoundary tabName='可编辑文档'>
            <React.Suspense fallback={tabFallback}>
              <LazyDocs />
            </React.Suspense>
          </TabErrorBoundary>
        )}
        {tab === 'library' && (
          <TabErrorBoundary tabName='资料库'>
            <React.Suspense fallback={tabFallback}>
              <LazyLibrary />
            </React.Suspense>
          </TabErrorBoundary>
        )}
        {tab === 'organizers' && (
          <TabErrorBoundary tabName='分组与标签'>
            <React.Suspense fallback={tabFallback}>
              <LazyOrganizers />
            </React.Suspense>
          </TabErrorBoundary>
        )}
        {tab === 'graph' && (
          <TabErrorBoundary tabName='知识图谱'>
            <React.Suspense fallback={tabFallback}>
              <LazyGraph />
            </React.Suspense>
          </TabErrorBoundary>
        )}
      </div>
      <KnowledgeTaskDocks />
    </div>
  );
};

export default KnowledgePage;
