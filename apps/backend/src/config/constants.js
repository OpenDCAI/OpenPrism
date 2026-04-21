import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const DATA_DIR = process.env.OPENPRISM_DATA_DIR || path.join(REPO_ROOT, 'data');
const TRANSFER_AGENT_DIR = path.join(REPO_ROOT, 'apps', 'backend', 'src', 'services', 'transferAgent');
/** Venue handbook markdown for transfer agent (neurips.md, acl.md, …) */
export const RULES_DIR = path.join(TRANSFER_AGENT_DIR, 'rules');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');
export const TEMPLATE_MANIFEST = path.join(TEMPLATE_DIR, 'manifest.json');
export const PORT = Number(process.env.PORT || 8787);
export const COLLAB_TOKEN_SECRET = process.env.OPENPRISM_COLLAB_TOKEN_SECRET || 'openprism-collab-dev';
export const COLLAB_TOKEN_TTL = Number(process.env.OPENPRISM_COLLAB_TOKEN_TTL || 24 * 60 * 60);
const requireTokenEnv = process.env.OPENPRISM_COLLAB_REQUIRE_TOKEN;
export const COLLAB_REQUIRE_TOKEN = requireTokenEnv
  ? !['0', 'false', 'no'].includes(String(requireTokenEnv).toLowerCase())
  : true;
export const COLLAB_FLUSH_DEBOUNCE_MS = Number(process.env.OPENPRISM_COLLAB_FLUSH_DEBOUNCE_MS || 800);
export const TUNNEL_MODE = process.env.OPENPRISM_TUNNEL || 'false';

// MinerU API
export const MINERU_API_BASE = 'https://mineru.net/api/v4';
export const MINERU_POLL_INTERVAL_MS = 3000;
export const MINERU_MAX_POLL_ATTEMPTS = 200;
