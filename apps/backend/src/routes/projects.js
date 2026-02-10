import path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import tar from 'tar';
import unzipper from 'unzipper';
import crypto from 'crypto';
import { DATA_DIR, TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir, readJson, writeJson, copyDir, listFilesRecursive } from '../utils/fsUtils.js';
import { safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';
import { isTextFile, extractDocumentBody, mergeTemplateBody } from '../utils/texUtils.js';
import { readTemplateManifest, copyTemplateIntoProject } from '../services/templateService.js';
import { getProjectRoot } from '../services/projectService.js';
import { downloadArxivSource, extractArxivId } from '../services/arxivService.js';
import { getLang, t } from '../i18n/index.js';

export function registerProjectRoutes(fastify) {
  fastify.get('/api/projects', async () => {
    await ensureDir(DATA_DIR);
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(DATA_DIR, entry.name, 'project.json');
      try {
        const meta = await readJson(metaPath);
        projects.push({
          ...meta,
          updatedAt: meta.updatedAt || meta.createdAt,
          tags: meta.tags || [],
          archived: meta.archived || false,
          trashed: meta.trashed || false,
          trashedAt: meta.trashedAt || null
        });
      } catch {
        // ignore
      }
    }
    return { projects };
  });

  fastify.post('/api/projects', async (req, reply) => {
    await ensureDir(DATA_DIR);
    const { name = 'Untitled', template } = req.body || {};
    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    const meta = { id, name, createdAt: new Date().toISOString() };
    await writeJson(path.join(projectRoot, 'project.json'), meta);
    if (template) {
      const templateRoot = path.join(TEMPLATE_DIR, template);
      await copyDir(templateRoot, projectRoot);
    }
    reply.send(meta);
  });

  fastify.post('/api/projects/import-zip', async (req) => {
    const lang = getLang(req);
    await ensureDir(DATA_DIR);
    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    let projectName = 'Imported Project';
    let hasZip = false;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'projectName') {
          projectName = String(part.value || '').trim() || projectName;
          continue;
        }
        if (part.type !== 'file') continue;
        hasZip = true;
        const zipStream = part.file.pipe(unzipper.Parse({ forceStream: true }));
        for await (const entry of zipStream) {
          const relPath = sanitizeUploadPath(entry.path);
          if (!relPath || relPath.endsWith('project.json')) {
            entry.autodrain();
            continue;
          }
          const abs = safeJoin(projectRoot, relPath);
          if (entry.type === 'Directory') {
            await ensureDir(abs);
            entry.autodrain();
            continue;
          }
          await ensureDir(path.dirname(abs));
          await pipeline(entry, createWriteStream(abs));
        }
      }
    } catch (err) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      return { ok: false, error: t(lang, 'zip_extract_failed', { error: String(err) }) };
    }

    if (!hasZip) {
      return { ok: false, error: 'Missing zip file.' };
    }

    const meta = { id, name: projectName, createdAt: new Date().toISOString() };
    await writeJson(path.join(projectRoot, 'project.json'), meta);
    return { ok: true, project: meta };
  });

  fastify.get('/api/projects/import-arxiv-sse', async (req, reply) => {
    const lang = getLang(req);
    await ensureDir(DATA_DIR);
    const { arxivIdOrUrl, projectName } = req.query;
    const arxivId = extractArxivId(arxivIdOrUrl);
    req.log.info({ arxivId, arxivIdOrUrl }, 'import-arxiv-sse: parsed id');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!arxivId) {
      send('error', { error: 'Invalid arXiv ID.' });
      reply.raw.end();
      return reply;
    }

    const id = crypto.randomUUID();
    const projectRoot = path.join(DATA_DIR, id);
    await ensureDir(projectRoot);
    const meta = {
      id,
      name: projectName || `arxiv-${arxivId}`,
      createdAt: new Date().toISOString()
    };

    const tmpTar = path.join(projectRoot, '__arxiv_source.tar.gz');
    try {
      send('progress', { phase: 'download', percent: 0 });
      await downloadArxivSource(arxivId, tmpTar, ({ received, total }) => {
        const percent = total > 0 ? Math.round((received / total) * 100) : -1;
        send('progress', { phase: 'download', percent, received, total });
      });

      send('progress', { phase: 'extract', percent: -1 });
      await tar.x({
        file: tmpTar,
        cwd: projectRoot,
        filter: (entryPath) => {
          if (!entryPath) return false;
          if (path.isAbsolute(entryPath)) return false;
          return !entryPath.split('/').some((part) => part === '..');
        }
      });
    } catch (err) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      send('error', { error: t(lang, 'arxiv_download_failed', { error: String(err) }) });
      reply.raw.end();
      return reply;
    } finally {
      await fs.rm(tmpTar, { force: true });
    }

    await writeJson(path.join(projectRoot, 'project.json'), meta);
    send('done', { ok: true, project: meta });
    reply.raw.end();
    return reply;
  });

  fastify.post('/api/projects/:id/rename-project', async (req) => {
    const { id } = req.params;
    const { name } = req.body || {};
    if (!name) return { ok: false, error: 'Missing name' };
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, name };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.post('/api/projects/:id/copy', async (req) => {
    const { id } = req.params;
    const { name } = req.body || {};
    const srcRoot = await getProjectRoot(id);
    const srcMeta = await readJson(path.join(srcRoot, 'project.json'));
    const newId = crypto.randomUUID();
    const destRoot = path.join(DATA_DIR, newId);
    await copyDir(srcRoot, destRoot);
    const newMeta = {
      ...srcMeta,
      id: newId,
      name: name || `${srcMeta.name} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      trashed: false,
      trashedAt: null,
    };
    await writeJson(path.join(destRoot, 'project.json'), newMeta);
    return { ok: true, project: newMeta };
  });

  fastify.delete('/api/projects/:id', async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, trashed: true, trashedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true };
  });

  fastify.delete('/api/projects/:id/permanent', async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    await fs.rm(projectRoot, { recursive: true, force: true });
    return { ok: true };
  });

  fastify.patch('/api/projects/:id/tags', async (req) => {
    const { id } = req.params;
    const { tags } = req.body || {};
    if (!Array.isArray(tags)) return { ok: false, error: 'tags must be an array' };
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, tags, updatedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.patch('/api/projects/:id/archive', async (req) => {
    const { id } = req.params;
    const { archived } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, archived: !!archived, updatedAt: new Date().toISOString() };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.patch('/api/projects/:id/trash', async (req) => {
    const { id } = req.params;
    const { trashed } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = {
      ...meta,
      trashed: !!trashed,
      trashedAt: trashed ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString()
    };
    await writeJson(metaPath, next);
    return { ok: true, project: next };
  });

  fastify.get('/api/projects/:id/tree', async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const items = await listFilesRecursive(projectRoot);
    let fileOrder = {};
    try {
      const meta = await readJson(path.join(projectRoot, 'project.json'));
      fileOrder = meta?.fileOrder || {};
    } catch {
      fileOrder = {};
    }
    return { items, fileOrder };
  });

  fastify.post('/api/projects/:id/file-order', async (req) => {
    const { id } = req.params;
    const { folder = '', order } = req.body || {};
    if (!Array.isArray(order)) {
      return { ok: false, error: 'Missing order.' };
    }
    const projectRoot = await getProjectRoot(id);
    const metaPath = path.join(projectRoot, 'project.json');
    const meta = await readJson(metaPath);
    const next = { ...meta, fileOrder: { ...(meta.fileOrder || {}), [folder]: order } };
    await writeJson(metaPath, next);
    return { ok: true };
  });

  fastify.get('/api/projects/:id/file', async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.query;
    if (!filePath) return { content: '' };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    const content = await fs.readFile(abs, 'utf8');
    return { content };
  });

  fastify.get('/api/projects/:id/blob', async (req, reply) => {
    const { id } = req.params;
    const { path: filePath } = req.query;
    if (!filePath) return reply.code(400).send('Missing path');
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    const buffer = await fs.readFile(abs);
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.eps': 'application/postscript'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    reply.header('Content-Type', contentType);
    return reply.send(buffer);
  });

  fastify.post('/api/projects/:id/upload', async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const saved = [];
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const relPath = sanitizeUploadPath(part.filename);
      if (!relPath) continue;
      const abs = safeJoin(projectRoot, relPath);
      await ensureDir(path.dirname(abs));
      await pipeline(part.file, createWriteStream(abs));
      saved.push(relPath);
    }
    return { ok: true, files: saved };
  });

  fastify.put('/api/projects/:id/file', async (req) => {
    const { id } = req.params;
    const { path: filePath, content } = req.body || {};
    if (!filePath) return { ok: false };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content ?? '', 'utf8');
    try {
      const metaPath = path.join(projectRoot, 'project.json');
      const meta = await readJson(metaPath);
      meta.updatedAt = new Date().toISOString();
      await writeJson(metaPath, meta);
    } catch { /* ignore */ }
    return { ok: true };
  });

  fastify.get('/api/projects/:id/files', async (req) => {
    const { id } = req.params;
    const projectRoot = await getProjectRoot(id);
    const items = await listFilesRecursive(projectRoot);
    const files = [];
    for (const item of items) {
      if (item.type !== 'file') continue;
      const abs = path.join(projectRoot, item.path);
      const buffer = await fs.readFile(abs);
      if (isTextFile(item.path)) {
        files.push({ path: item.path, content: buffer.toString('utf8'), encoding: 'utf8' });
      } else {
        files.push({ path: item.path, content: buffer.toString('base64'), encoding: 'base64' });
      }
    }
    return { files };
  });

  fastify.post('/api/projects/:id/convert-template', async (req) => {
    const { id } = req.params;
    const { targetTemplate, mainFile = 'main.tex' } = req.body || {};
    if (!targetTemplate) return { ok: false, error: 'Missing targetTemplate' };
    const { templates } = await readTemplateManifest();
    const template = templates.find((item) => item.id === targetTemplate);
    if (!template) return { ok: false, error: 'Unknown template' };

    try {
      const projectRoot = await getProjectRoot(id);
      const currentMainPath = safeJoin(projectRoot, mainFile);
      const templateRoot = path.join(TEMPLATE_DIR, template.id);
      const templateMain = template.mainFile || 'main.tex';
      const templateMainPath = path.join(templateRoot, templateMain);

      let currentTex = '';
      try {
        currentTex = await fs.readFile(currentMainPath, 'utf8');
      } catch {
        currentTex = '';
      }

      const templateTex = await fs.readFile(templateMainPath, 'utf8');
      const body = extractDocumentBody(currentTex);
      const merged = mergeTemplateBody(templateTex, body);
      const changedFiles = await copyTemplateIntoProject(templateRoot, projectRoot);
      await fs.writeFile(safeJoin(projectRoot, templateMain), merged, 'utf8');
      changedFiles.push(templateMain);
      return { ok: true, mainFile: templateMain, changedFiles };
    } catch (err) {
      return { ok: false, error: `Template convert failed: ${String(err)}` };
    }
  });

  fastify.post('/api/projects/:id/template', async (req) => {
    const { id } = req.params;
    const { template } = req.body || {};
    const projectRoot = await getProjectRoot(id);
    if (!template) return { ok: false };
    const templateRoot = path.join(TEMPLATE_DIR, template);
    await copyDir(templateRoot, projectRoot);
    return { ok: true };
  });

  fastify.post('/api/projects/:id/folder', async (req) => {
    const { id } = req.params;
    const { path: folderPath } = req.body || {};
    if (!folderPath) return { ok: false };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, folderPath);
    await ensureDir(abs);
    return { ok: true };
  });

  fastify.post('/api/projects/:id/rename', async (req) => {
    const { id } = req.params;
    const { from, to } = req.body || {};
    if (!from || !to) return { ok: false };
    const projectRoot = await getProjectRoot(id);
    const absFrom = safeJoin(projectRoot, from);
    const absTo = safeJoin(projectRoot, to);
    await ensureDir(path.dirname(absTo));
    await fs.rename(absFrom, absTo);
    return { ok: true };
  });

  fastify.delete('/api/projects/:id/file', async (req) => {
    const { id } = req.params;
    const { path: filePath } = req.query || {};
    if (!filePath) return { ok: false, error: 'Missing file path' };
    const projectRoot = await getProjectRoot(id);
    const abs = safeJoin(projectRoot, filePath);
    // Check if it's a directory
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        await fs.rm(abs, { recursive: true, force: true });
      } else {
        await fs.rm(abs, { force: true });
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { ok: false, error: 'File not found' };
      }
      throw err;
    }
    return { ok: true };
  });
}
