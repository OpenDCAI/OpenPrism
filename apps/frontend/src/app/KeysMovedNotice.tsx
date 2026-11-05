import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, IconButton } from '@design';
import { migrateLegacyKeys } from './legacyKeys';

/** Once per account and browser: moves AI keys an older build kept in localStorage to the server, then says so. */
export default function KeysMovedNotice({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    let live = true;
    migrateLegacyKeys().then((found) => live && setMoved(found)).catch(() => {}); // try again on the next load
    return () => { live = false; };
  }, [accountId]);

  if (!moved) return null;
  return (
    <div className="verify-banner" role="status" data-testid="keys-moved">
      <Icon name="lock" />
      <span>{t('Your AI keys are now stored encrypted on the server, not in this browser.')}</span>
      <IconButton icon="x" label={t('Dismiss')} onClick={() => setMoved(false)} />
    </div>
  );
}
