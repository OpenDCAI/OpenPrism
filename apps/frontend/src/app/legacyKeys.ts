import { getAiKeys, saveAiKey } from '../api/client';
import type { AiKeyProfile } from '../api/client';
import { dropLegacyLlmDefaults } from './llmDefaults';

/** Browser settings of older builds, which kept the user's AI keys here in plain text. */
const SETTINGS_KEY = 'openprism-settings-v1';
const FIELDS: Record<AiKeyProfile, [endpoint: string, key: string, model?: string]> = {
  llm: ['llmEndpoint', 'llmApiKey', 'llmModel'],
  search: ['searchEndpoint', 'searchApiKey', 'searchModel'],
  vision: ['visionEndpoint', 'visionApiKey', 'visionModel'],
  mineru: ['mineruApiBase', 'mineruToken']
};

/**
 * Move AI keys an older build left in localStorage to the server (only into profiles that have no key there yet),
 * then delete them, with their endpoints and models, from this browser. Resolves true when keys were found.
 */
export async function migrateLegacyKeys(): Promise<boolean> {
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return false;
  }
  const settings = dropLegacyLlmDefaults(stored as { llmEndpoint?: string; llmApiKey?: string; llmModel?: string });
  const text = (k?: string) => (k && typeof (settings as Record<string, unknown>)[k] === 'string' ? String((settings as Record<string, unknown>)[k]).trim() : '');
  const found = (Object.keys(FIELDS) as AiKeyProfile[]).filter((p) => text(FIELDS[p][1]));
  const leftovers = Object.values(FIELDS).flat().filter((k): k is string => Boolean(k) && (k as string) in stored);
  if (found.length === 0 && leftovers.length === 0) return false;
  if (found.length > 0) {
    const current = (await getAiKeys()).profiles;
    for (const p of found) {
      if (current?.[p]) continue; // the server already has one: never overwrite it with an old browser copy
      const [endpoint, key, model] = FIELDS[p];
      const res = await saveAiKey(p, { endpoint: text(endpoint), ...(model ? { model: text(model) } : {}), apiKey: text(key) });
      if (!res.ok) await saveAiKey(p, { apiKey: text(key) }); // e.g. an endpoint the server refuses: keep the key, drop it
    }
  }
  const rest = { ...stored };
  leftovers.forEach((k) => delete rest[k]);
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  return found.length > 0;
}
