import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ensureDir } from './utils/fsUtils.js';
import { DATA_DIR, PORT } from './config/constants.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerArxivRoutes } from './routes/arxiv.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerLLMRoutes } from './routes/llm.js';
import { registerVisionRoutes } from './routes/vision.js';
import { registerPlotRoutes } from './routes/plot.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerCollabRoutes } from './routes/collab.js';
import { requireAuthIfRemote } from './utils/authUtils.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});
await fastify.register(websocket);
fastify.decorateRequest('collabAuth', null);

fastify.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;
  if (req.method === 'OPTIONS') return;
  if (req.url.startsWith('/api/health')) return;
  if (req.url.startsWith('/api/collab')) return;
  const auth = requireAuthIfRemote(req);
  if (!auth.ok) {
    reply.code(401).send({ ok: false, error: 'Unauthorized' });
  }
  req.collabAuth = auth.payload || null;
});

registerHealthRoutes(fastify);
registerArxivRoutes(fastify);
registerProjectRoutes(fastify);
registerCompileRoutes(fastify);
registerLLMRoutes(fastify);
registerVisionRoutes(fastify);
registerPlotRoutes(fastify);
registerAgentRoutes(fastify);
registerCollabRoutes(fastify);

await ensureDir(DATA_DIR);

fastify.listen({ port: PORT, host: '0.0.0.0' });
