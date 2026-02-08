import path from 'path';
import { readJson } from '../utils/fsUtils.js';
import { getProjectRoot } from '../services/projectService.js';
import { safeJoin } from '../utils/pathUtils.js';
import { isTextFile } from '../utils/texUtils.js';
import { issueToken, verifyToken } from '../services/collab/tokenService.js';
import { getOrCreateDoc, setupConnection, flushDocNow, getDocDiagnostics } from '../services/collab/docStore.js';
import { getClientIp, isLocalAddress } from '../utils/authUtils.js';

export function registerCollabRoutes(fastify) {
  fastify.post('/api/projects/:id/collab/invite', async (req) => {
    const { id } = req.params;
    await getProjectRoot(id);
    const token = issueToken({ projectId: id, role: 'admin' });
    return { ok: true, token };
  });

  fastify.get('/api/collab/resolve', async (req, reply) => {
    const { token } = req.query || {};
    const tokenValue = Array.isArray(token) ? token[0] : token;
    const payload = verifyToken(tokenValue);
    if (!payload) {
      reply.code(401);
      return { ok: false, error: 'Invalid token' };
    }
    const projectRoot = await getProjectRoot(payload.projectId);
    let projectName = payload.projectId;
    try {
      const meta = await readJson(path.join(projectRoot, 'project.json'));
      projectName = meta?.name || projectName;
    } catch {
      // ignore
    }
    return { ok: true, projectId: payload.projectId, projectName, role: payload.role };
  });

  fastify.post('/api/projects/:id/collab/flush', async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.body || {};
    if (!filePath) return { ok: false, error: 'Missing path' };
    await getProjectRoot(id);
    const key = `${id}:${filePath}`;
    await flushDocNow(key);
    return { ok: true };
  });

  fastify.get('/api/projects/:id/collab/status', async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.query || {};
    if (!filePath) return { ok: false, error: 'Missing path' };
    await getProjectRoot(id);
    const key = `${id}:${filePath}`;
    const diagnostics = getDocDiagnostics(key);
    return { ok: true, diagnostics };
  });

  fastify.get('/api/collab', { websocket: true }, async (conn, req) => {
    const { token, projectId, file } = req.query || {};
    const tokenValue = Array.isArray(token) ? token[0] : token;
    const filePath = Array.isArray(file) ? file[0] : file;
    const projectParam = Array.isArray(projectId) ? projectId[0] : projectId;
    const isLocal = isLocalAddress(getClientIp(req));
    let payload = null;
    if (tokenValue) {
      payload = verifyToken(tokenValue);
    } else if (!isLocal) {
      conn.socket.close(1008, 'Unauthorized');
      return;
    }
    const effectiveProjectId = payload?.projectId || projectParam;
    if (!effectiveProjectId || !filePath) {
      conn.socket.close(1008, 'Missing project or file');
      return;
    }
    if (payload && projectParam && payload.projectId !== projectParam) {
      conn.socket.close(1008, 'Project mismatch');
      return;
    }
    if (!payload && !isLocal) {
      conn.socket.close(1008, 'Unauthorized');
      return;
    }
    let projectRoot = '';
    try {
      projectRoot = await getProjectRoot(effectiveProjectId);
    } catch {
      conn.socket.close(1008, 'Project not found');
      return;
    }
    if (!isTextFile(filePath)) {
      conn.socket.close(1003, 'Binary file');
      return;
    }
    let absPath = '';
    try {
      absPath = safeJoin(projectRoot, filePath);
    } catch {
      conn.socket.close(1008, 'Invalid path');
      return;
    }
    const metaPath = path.join(projectRoot, 'project.json');
    const key = `${effectiveProjectId}:${filePath}`;
    const doc = await getOrCreateDoc({ key, absPath, metaPath });
    setupConnection(doc, conn.socket);
  });
}
