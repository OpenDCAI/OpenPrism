import { promises as fs } from 'fs';
import path from 'path';
import { RULES_DIR } from '../../config/constants.js';

/**
 * Per-venue rules cache: venueId → { content, mtimeMs }
 */
const cache = new Map();

/**
 * Load venue rules markdown from disk (cached in process memory).
 *
 * Convention: rules file lives at `${RULES_DIR}/${venueId}.md`
 *   e.g. apps/backend/src/services/transferAgent/rules/neurips.md
 *        apps/backend/src/services/transferAgent/rules/acl.md
 *
 * @param {string} venueId — e.g. 'neurips', 'icml', 'cvpr'
 * @returns {Promise<string>}
 */
export async function loadVenueRules(venueId) {
  const filePath = path.join(RULES_DIR, `${venueId}.md`);
  try {
    const st = await fs.stat(filePath);
    const cached = cache.get(venueId);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      return cached.content;
    }
    const content = await fs.readFile(filePath, 'utf8');
    cache.set(venueId, { content, mtimeMs: st.mtimeMs });
    return content;
  } catch {
    return '';
  }
}

/**
 * Synchronous accessor (after warm-up via loadVenueRules).
 */
export function getVenueRulesSync(venueId) {
  return cache.get(venueId)?.content || '';
}

/**
 * Format rules as an LLM prompt block.
 */
export function formatVenueHandbookBlock(venueId, fullMd) {
  const label = venueId.toUpperCase();
  if (!fullMd?.trim()) {
    return `\n\n[${label} handbook missing on disk — use template comments only.]\n`;
  }
  return `\n\n--- ${label}_FULL_HANDBOOK (Markdown, authoritative; follow strictly) ---\n${fullMd}\n--- END_${label}_FULL_HANDBOOK ---\n`;
}

// ────────── Backward-compatible NeurIPS aliases ──────────

export async function loadNeuripsRulesFull() {
  return loadVenueRules('neurips');
}

export function getNeuripsRulesSync() {
  return getVenueRulesSync('neurips');
}

export function formatNeuripsHandbookBlock(fullMd) {
  return formatVenueHandbookBlock('neurips', fullMd);
}
