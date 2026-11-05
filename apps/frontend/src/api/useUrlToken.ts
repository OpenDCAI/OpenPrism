import { useEffect, useState } from 'react';
import { cachedUrlToken, ensureUrlToken, subscribeUrlTokens } from './auth';

/**
 * Keep a URL token for `projectId` and re-render when it is minted or renewed, so URLs built with blobUrl() (which
 * reads the cache) stay valid. Returns the current token ('' until the first one arrives).
 */
export function useUrlToken(projectId: string | undefined): string {
  const [token, setToken] = useState(() => (projectId ? cachedUrlToken(projectId) : ''));
  useEffect(() => {
    if (!projectId) return;
    const update = () => setToken(cachedUrlToken(projectId));
    const unsubscribe = subscribeUrlTokens(update);
    ensureUrlToken(projectId).then(update).catch(() => {}); // a failure shows up as a broken image; the next renewal retries
    return () => { unsubscribe(); };
  }, [projectId]);
  return token;
}
