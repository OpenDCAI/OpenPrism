import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ensureDir } from './utils/fsUtils.js';
import { DATA_DIR, IS_DESKTOP_MODE, PORT, TUNNEL_MODE } from './config/constants.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerArxivRoutes } from './routes/arxiv.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerLLMRoutes } from './routes/llm.js';
import { registerVisionRoutes } from './routes/vision.js';
import { registerPlotRoutes } from './routes/plot.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerCollabRoutes } from './routes/collab.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { tryStartTunnel } from './services/tunnel.js';
import { requireAuthIfRemote } from './utils/authUtils.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024
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
registerTransferRoutes(fastify);
registerDesktopRoutes(fastify);

// Serve frontend static files in tunnel/production mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDist = join(__dirname, '../../frontend/dist');

if (existsSync(frontendDist)) {
  const fastifyStatic = await import('@fastify/static');
  await fastify.register(fastifyStatic.default, {
    root: frontendDist,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback: serve index.html for non-API routes
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      reply.code(404).send({ error: 'Not Found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

await ensureDir(DATA_DIR);

const listenAddress = await fastify.listen({ port: PORT, host: '0.0.0.0' });
let actualPort = PORT;
if (typeof listenAddress === 'string') {
  try {
    actualPort = Number(new URL(listenAddress).port) || PORT;
  } catch {
    const match = listenAddress.match(/:(\d+)(?:\/)?$/);
    if (match?.[1]) actualPort = Number(match[1]);
  }
}

console.log('');
console.log(`  OpenPrism started at http://localhost:${actualPort}`);
console.log('');

const tunnelMode = TUNNEL_MODE.toLowerCase().trim();
if (IS_DESKTOP_MODE) {
  console.log('  Desktop mode detected: tunnel disabled.');
  console.log('');
} else if (tunnelMode !== 'false' && tunnelMode !== '0' && tunnelMode !== 'no') {
  console.log('  Tunnel starting...');
  const result = await tryStartTunnel(actualPort);
  if (result) {
    console.log(`  Tunnel active (${result.provider}):`);
    console.log(`  Public URL: ${result.url}`);
    console.log('  Share this URL to collaborate remotely!');
    console.log('');
  } else {
    console.log('  Tunnel failed to start. Check that the provider is installed.');
    console.log('');
  }
} else {
  console.log('  Want remote collaboration? Start with tunnel:');
  console.log('    OPENPRISM_TUNNEL=localtunnel npm run tunnel');
  console.log('    OPENPRISM_TUNNEL=cloudflared npm run tunnel:cf');
  console.log('    OPENPRISM_TUNNEL=ngrok npm run tunnel:ngrok');
  console.log('');
}
