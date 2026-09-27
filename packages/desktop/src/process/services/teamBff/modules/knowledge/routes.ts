// AionUi 移植：知识库 BFF 路由（源 client server/main.ts 136-299）。
// 全部经 team-server 网关（KEAccessGrant 短时 JWT），renderer/本服务不持有对象存储凭据；
// 文件下载支持 restricted_stream（经网关流式转发）与签名 URL 两种模式（上游语义）。
// 差异：挂载前缀 /teamapi/knowledge/*；补 GET /documents 列表端点（供知识库页，上游经 web-operations 复用）。

import { Hono } from 'hono';
import { callTeamGateway, currentTeamGatewayScope, fetchTeamGateway } from '../memory/team-gateway-runtime.js';
import { accountRuntime } from '../memory/account-runtime.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function knowledgeGatewayError(error: unknown) {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
      ? error.message
      : 'TEAM_GATEWAY_UPSTREAM_FAILED';
  return { code, status: code === 'TEAM_GATEWAY_UNAVAILABLE' ? 409 : 502 } as const;
}

function accountRequestSignal(request: Request) {
  return AbortSignal.any([request.signal, accountRuntime.signal()]);
}

export function createKnowledgeRoutes() {
  const app = new Hono();

  app.use('/knowledge/*', async (c, next) => {
    let active = false;
    try {
      active = accountRuntime.currentSubject() !== null;
    } catch {
      active = false;
    }
    if (!active) {
      return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    }
    await next();
  });

  app.post('/knowledge/uploads', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const allowed = new Set([
      'filename',
      'mime',
      'sizeBytes',
      'sha256',
      'visibility',
      'classification',
      'idempotencyKey',
    ]);
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.has(key)) ||
      typeof body.filename !== 'string' ||
      typeof body.mime !== 'string' ||
      typeof body.sizeBytes !== 'number' ||
      typeof body.sha256 !== 'string' ||
      typeof body.idempotencyKey !== 'string' ||
      !UUID_PATTERN.test(body.idempotencyKey)
    ) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/uploads`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': body.idempotencyKey },
          body: JSON.stringify({
            filename: body.filename,
            mime: body.mime,
            sizeBytes: body.sizeBytes,
            sha256: body.sha256,
            visibility: body.visibility ?? 'personal',
            classification: body.classification ?? 'normal',
          }),
        }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/uploads/:uploadSessionId/complete', async (c) => {
    const uploadSessionId = c.req.param('uploadSessionId');
    if (!UUID_PATTERN.test(uploadSessionId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/uploads/${encodeURIComponent(uploadSessionId)}:complete`,
        { method: 'POST' }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/jobs/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    if (!UUID_PATTERN.test(jobId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      return c.json({ data: await callTeamGateway(`/api/v1/knowledge/jobs/${encodeURIComponent(jobId)}`) });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/jobs/:jobId/retry', async (c) => {
    const jobId = c.req.param('jobId');
    if (!UUID_PATTERN.test(jobId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      return c.json({
        data: await callTeamGateway(`/api/v1/knowledge/jobs/${encodeURIComponent(jobId)}:retry`, { method: 'POST' }),
      });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/jobs/:jobId/cancel', async (c) => {
    const jobId = c.req.param('jobId');
    if (!UUID_PATTERN.test(jobId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      return c.json({
        data: await callTeamGateway(`/api/v1/knowledge/jobs/${encodeURIComponent(jobId)}:cancel`, {
          method: 'POST',
          body: '{}',
        }),
      });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.delete('/knowledge/documents/:documentId', async (c) => {
    const documentId = c.req.param('documentId');
    if (!UUID_PATTERN.test(documentId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      return c.json({
        data: await callTeamGateway(`/api/v1/knowledge/documents/${encodeURIComponent(documentId)}`, {
          method: 'DELETE',
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        }),
      });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // 文档列表（个人/团队可见性由 team-server 依据当前会话过滤）
  app.get('/knowledge/documents', async (c) => {
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const documents = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/documents`,
        { signal: accountRequestSignal(c.req.raw) }
      );
      // Go nil 切片序列化为 JSON null——归一化为 []，同时容错非数组形态
      const list = Array.isArray(documents) ? documents : documents ? [documents] : [];
      return c.json({ data: list }, 200, { 'Cache-Control': 'private, no-store' });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // citation 卡片按可信 documentId 获取原始文件名与 MIME（元数据经 team-server 过滤）
  app.get('/knowledge/documents/:documentId', async (c) => {
    const documentId = c.req.param('documentId').toLowerCase();
    if (!UUID_PATTERN.test(documentId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const documents = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/documents`,
        { signal: accountRequestSignal(c.req.raw) }
      );
      if (!Array.isArray(documents)) throw new Error('TEAM_GATEWAY_RESPONSE_INVALID');
      const document = documents.find(
        (item) =>
          item && typeof item === 'object' && String((item as { id?: unknown }).id ?? '').toLowerCase() === documentId
      );
      if (!document) return c.json({ error: { code: 'RESOURCE_NOT_FOUND' } }, 404);
      return c.json({ data: document }, 200, {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/files/:documentId', async (c) => {
    const documentId = c.req.param('documentId');
    if (!UUID_PATTERN.test(documentId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const grant = (await callTeamGateway(
        `/api/v1/knowledge/documents/${encodeURIComponent(documentId)}/download-url`,
        {
          method: 'POST',
          body: '{}',
          signal: accountRequestSignal(c.req.raw),
        }
      )) as { deliveryMode?: string; method?: string; url?: string; filename?: string; mime?: string };
      if (
        grant.method !== 'GET' ||
        typeof grant.url !== 'string' ||
        typeof grant.filename !== 'string' ||
        typeof grant.mime !== 'string'
      ) {
        throw new Error('DOWNLOAD_GRANT_INVALID');
      }
      let upstream: Response;
      if (grant.deliveryMode === 'restricted_stream' && grant.url.startsWith('/api/v1/')) {
        upstream = await fetchTeamGateway(grant.url, { signal: accountRequestSignal(c.req.raw) });
      } else {
        const signed = new URL(grant.url);
        if (!['http:', 'https:'].includes(signed.protocol) || signed.username || signed.password || signed.hash)
          throw new Error('DOWNLOAD_GRANT_INVALID');
        upstream = await fetch(signed, {
          credentials: 'omit',
          redirect: 'error',
          signal: accountRequestSignal(c.req.raw),
        });
      }
      if (!upstream.ok || !upstream.body) throw new Error('DOCUMENT_DOWNLOAD_FAILED');
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': grant.mime,
          'Content-Disposition':
            upstream.headers.get('Content-Disposition') ??
            `attachment; filename*=UTF-8''${encodeURIComponent(grant.filename)}`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/organizers', async (c) => {
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const base = `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`;
      const [groups, tags] = await Promise.all([
        callTeamGateway(base, {
          method: 'POST',
          body: JSON.stringify({ operation: 'organizers.groups.list', input: {} }),
        }),
        callTeamGateway(base, {
          method: 'POST',
          body: JSON.stringify({ operation: 'organizers.tags.list', input: {} }),
        }),
      ]);
      return c.json({ data: { groups, tags } });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── K1: 通用 web-operations 透传（所有 legacy operation 的统一转发）──
  app.post('/knowledge/web-ops', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const body = (await c.req.json().catch(() => null)) as { operation?: unknown; input?: unknown } | null;
    if (!body || typeof body.operation !== 'string' || !body.operation.trim()) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: body.operation, input: body.input ?? {} }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── K2: 可编辑文档 ──
  app.get('/knowledge/docs', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const docs = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'documents.list', input: {} }) }
      );
      return c.json({ data: docs });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/docs', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const body = (await c.req.json().catch(() => null)) as {
      id?: unknown;
      title?: unknown;
      content?: unknown;
      docType?: unknown;
    } | null;
    if (typeof body?.title !== 'string' || !body.title.trim() || typeof body?.content !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            operation: 'documents.save',
            input: {
              id: typeof body.id === 'string' ? body.id : `native-${Date.now()}`,
              title: body.title.trim().slice(0, 200),
              content: body.content.slice(0, 500_000),
              docType: 'native',
            },
          }),
        }
      );
      return c.json({ data }, 201);
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/docs/:docId', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const docId = c.req.param('docId');
    if (!docId) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'documents.get', input: { id: docId } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.delete('/knowledge/docs/:docId', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const docId = c.req.param('docId');
    if (!docId) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'documents.delete', input: { id: docId } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── K3: organizers 写链路 ──
  app.post('/knowledge/organizers/:kind', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const kind = c.req.param('kind');
    if (kind !== 'groups' && kind !== 'tags') return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      description?: unknown;
      color?: unknown;
    } | null;
    if (typeof body?.name !== 'string' || !body.name.trim()) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            operation: `organizers.${kind}.create`,
            input: {
              name: body.name.trim().slice(0, 64),
              description: typeof body.description === 'string' ? body.description.slice(0, 300) : '',
              color: typeof body.color === 'string' ? body.color : '#626ea3',
            },
          }),
        }
      );
      return c.json({ data }, 201);
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.patch('/knowledge/organizers/:kind/:id', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    if ((kind !== 'groups' && kind !== 'tags') || !id) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: `organizers.${kind}.update`, input: { id, ...body } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.delete('/knowledge/organizers/:kind/:id', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    if ((kind !== 'groups' && kind !== 'tags') || !id) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { expectedVersion?: unknown };
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            operation: `organizers.${kind}.delete`,
            input: {
              id,
              expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
            },
          }),
        }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/organizers/documents', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(c.req.query())) {
        if (value !== undefined) query.set(key, value);
      }
      if (!query.get('limit')) query.set('limit', '100');
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({ operation: 'organizers.documents.search', input: Object.fromEntries(query) }),
        }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.put('/knowledge/organizers/documents/:docId/assignments', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const docId = c.req.param('docId');
    if (!docId) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    const body = (await c.req.json().catch(() => null)) as { groupIds?: unknown; tagIds?: unknown } | null;
    if (!body || !Array.isArray(body.groupIds) || !Array.isArray(body.tagIds)) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            operation: 'organizers.assignments.replace',
            input: {
              documentId: docId,
              groupIds: body.groupIds,
              tagIds: body.tagIds,
            },
          }),
        }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── K4: 图谱 ──
  app.get('/knowledge/graph', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const query = new URLSearchParams(c.req.query());
      if (!query.get('limit')) query.set('limit', '200');
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'graph.get', input: Object.fromEntries(query) }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/graph/stats', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'graph.stats', input: {} }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/graph/reports', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'graph.reports', input: {} }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.get('/knowledge/graph/summary', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/graph`
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/graph/rebuild', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/graph:rebuild`,
        { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({}) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── S2: KE 模型端点 CRUD + 激活（经 web-operations 透传到 KE-v2）──
  app.get('/knowledge/model-endpoints', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const role = c.req.query('role');
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'models.list', input: role ? { role } : {} }) }
      );
      return c.json({ data: Array.isArray(data) ? data : [] });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/model-endpoints', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.role !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.baseUrl !== 'string' ||
      typeof body.model !== 'string'
    ) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'models.create', input: body }) }
      );
      return c.json({ data }, 201);
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.patch('/knowledge/model-endpoints/:id', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!id || !body) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'models.update', input: { id, ...body } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.delete('/knowledge/model-endpoints/:id', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const id = c.req.param('id');
    if (!id) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'models.delete', input: { id } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.post('/knowledge/model-endpoints/:id/activate', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const id = c.req.param('id');
    if (!id) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'models.activate', input: { id } }) }
      );
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── S2: KE 系统设置 ──
  app.get('/knowledge/settings', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'settings.get', input: {} }) }
      );
      return c.json({ data: data ?? {} });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  app.put('/knowledge/settings', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const body = (await c.req.json().catch(() => null)) as Record<string, string> | null;
    if (!body || typeof body !== 'object') return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    try {
      const { tenantId, teamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/knowledge/web-operations:invoke`,
        { method: 'POST', body: JSON.stringify({ operation: 'settings.update', input: body }) }
      );
      return c.json({ data: data ?? {} });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  // ── 可见性切换 ──
  app.patch('/knowledge/documents/:documentId/visibility', async (c) => {
    if (!accountRuntime.currentSubject()) return c.json({ error: { code: 'ACCOUNT_RUNTIME_REQUIRED' } }, 409);
    const documentId = c.req.param('documentId');
    if (!UUID_PATTERN.test(documentId)) return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    const body = (await c.req.json().catch(() => null)) as {
      visibility?: unknown;
      teamId?: unknown;
      expectedVersion?: unknown;
      reason?: unknown;
    } | null;
    if (typeof body?.visibility !== 'string' || !['personal', 'team'].includes(body.visibility)) {
      return c.json({ error: { code: 'VALIDATION_ERROR' } }, 400);
    }
    try {
      const { tenantId, teamId: activeTeamId } = currentTeamGatewayScope();
      const data = await callTeamGateway(`/api/v1/knowledge/documents/${encodeURIComponent(documentId)}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({
          visibility: body.visibility,
          teamId: typeof body.teamId === 'string' ? body.teamId : activeTeamId,
          expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
          idempotencyKey: crypto.randomUUID(),
          reason: typeof body.reason === 'string' ? body.reason : 'AionUI 知识库操作',
        }),
      });
      return c.json({ data });
    } catch (error) {
      const mapped = knowledgeGatewayError(error);
      return c.json({ error: { code: mapped.code } }, mapped.status);
    }
  });

  return app;
}
