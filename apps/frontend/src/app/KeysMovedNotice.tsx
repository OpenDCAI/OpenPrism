import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, IconButton } from '@design';
import { migrateLegacyKeys } from './legacyKeys';

// One run per account for the life of the page. The component can mount twice (React strict mode in development) or be
// remounted while the keys are still moving; a second run would find localStorage already emptied and report "nothing
// moved", so every mount shares the first run's result.
const runs = new Map<string, Promise<boolean>>();
const dismissed = new Set<string>();

/** Once per account and browser: moves AI keys an older build kept in localStorage to the server, then says so. */
export default function KeysMovedNotice({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    let live = true;
    let run = runs.get(accountId);
    if (!run) {
      run = migrateLegacyKeys();
      runs.set(accountId, run);
      run.catch(() => runs.delete(accountId)); // try again on the next load
    }
    run.then((found) => live && setMoved(found && !dismissed.has(accountId))).catch(() => {});
    return () => { live = false; };
  }, [accountId]);

  if (!moved) return null;
  return (
    <div className="verify-banner" role="status" data-testid="keys-moved">
      <Icon name="lock" />
      <span>{t('Your AI keys are now stored encrypted on the server, not in this browser.')}</span>
      <IconButton icon="x" label={t('Dismiss')} onClick={() => { dismissed.add(accountId); setMoved(false); }} />
    </div>
  );
}
