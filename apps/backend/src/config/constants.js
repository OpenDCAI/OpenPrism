import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function isTruthy(value) {
  if (value == null) return false;
  return !['0', 'false', 'no'].includes(String(value).toLowerCase().trim());
}

export const REPO_ROOT = process.env.OPENPRISM_REPO_ROOT || defaultRepoRoot;
export const DATA_DIR = process.env.OPENPRISM_DATA_DIR || path.join(REPO_ROOT, 'data');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');
export const TEMPLATE_MANIFEST = path.join(TEMPLATE_DIR, 'manifest.json');
export const PORT = Number(process.env.PORT || 8787);
export const IS_DESKTOP_MODE = isTruthy(process.env.OPENPRISM_DESKTOP);
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
