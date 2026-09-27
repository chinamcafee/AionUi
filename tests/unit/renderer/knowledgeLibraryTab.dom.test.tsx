/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// LibraryTab 上传区回归测试：
// 1. 摄入进度 hook 的 status 恒为 'building' 时（无 job 的常态），拖拽/点击必须仍然可用
//    —— 回归 Arco Upload 被永久 disabled 导致上传区毫无响应的问题。
// 2. 上传完成后刷新文档列表；错误码映射为友好文案。

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadKnowledgeFile: vi.fn(),
  hasPermission: vi.fn(() => true),
}));

vi.mock('@/renderer/api/teamClient', () => ({
  teamBffBaseUrl: () => 'http://127.0.0.1:9999',
  teamApi: { patchDocumentVisibility: vi.fn() },
  TeamApiError: class TeamApiError extends Error {},
}));

vi.mock('@/renderer/hooks/context/TeamAuthContext', () => ({
  useTeamAuth: () => ({ view: { phase: 'authenticated' }, hasPermission: mocks.hasPermission }),
}));

vi.mock('@/renderer/services/knowledge/upload', () => ({
  uploadKnowledgeFile: mocks.uploadKnowledgeFile,
  KnowledgeUploadError: class KnowledgeUploadError extends Error {
    constructor(
      public readonly code: string,
      public readonly status = 0
    ) {
      super(code);
    }
  },
}));

// 关键：模拟 hook 在无任务时的真实行为 —— status 恒为 'building'（回归根因场景）
vi.mock('@/renderer/hooks/knowledge/useUploadProgress', () => ({
  useUploadProgress: () => ({
    progress: [],
    status: 'building',
    doneStats: null,
    errorMsg: null,
    percent: 0,
    stage: 'queued',
  }),
}));

vi.mock('@/renderer/components/knowledge/FilePreview', () => ({
  KnowledgeFilePreview: () => null,
}));

import { LibraryTab } from '@/renderer/pages/knowledge/LibraryTab';
import { KnowledgeUploadError } from '@/renderer/services/knowledge/upload';

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LibraryTab upload dropzone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }) as unknown as typeof fetch)
    );
    mocks.uploadKnowledgeFile.mockResolvedValue({
      uploadSessionId: 'session-1',
      documentId: 'doc-1',
      ingestionJobId: 'job-1',
      status: 'completed',
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderTab = () => render(<LibraryTab />);

  const getDropzone = () => screen.getByRole('button', { name: '选择或拖入要上传的知识文件' });

  it('accepts dropped files even while the progress hook reports building', async () => {
    renderTab();
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    fireEvent.drop(getDropzone(), { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(mocks.uploadKnowledgeFile).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ visibility: 'personal', classification: 'normal' })
      );
    });
  });

  it('opens the hidden file input on click and uploads the selected file', async () => {
    renderTab();
    fireEvent.click(getDropzone());
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.uploadKnowledgeFile).toHaveBeenCalledWith(file, expect.objectContaining({ visibility: 'personal' }));
    });
  });

  it('reloads the document list after the upload completes', async () => {
    renderTab();
    await flushPromises();
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/knowledge/documents')).length;

    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    fireEvent.drop(getDropzone(), { dataTransfer: { files: [file] } });

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([url]) => String(url).includes('/knowledge/documents')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('maps upload error codes to friendly messages', async () => {
    mocks.uploadKnowledgeFile.mockRejectedValue(new KnowledgeUploadError('MIME_UNSUPPORTED', 415));
    renderTab();
    const file = new File(['x'], 'evil.exe', { type: 'application/x-msdownload' });
    fireEvent.drop(getDropzone(), { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('暂不支持该文件类型')).toBeInTheDocument();
    });
  });

  it('disables the team visibility option without publish permission', () => {
    mocks.hasPermission.mockReturnValue(false);
    renderTab();
    // 无权限时仍默认个人范围；Radio.Group 的团队共享项被禁用（Arco 渲染为 disabled 的 label）
    const teamRadio = screen.getByText('团队共享').closest('label');
    expect(teamRadio?.className).toContain('disabled');
  });
});
