import type { JSX } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, SettingsRow, useAnnouncer } from '@thaumic-cast/ui';
import { DOWNLOAD_URL } from '@thaumic-cast/shared';
import {
  checkForUpdate,
  updateChannel,
  updateNote,
  type UpdateCheckResult,
} from '../../lib/update-check';
import { useActiveCasts } from '../../popup/hooks/useActiveCasts';

/**
 * About's "Check for updates" row (DESIGN.md §11 call 99): one action row whose Button
 * suits how this copy updates. A store install asks the store now; a version it finds turns
 * the Button into "Restart the extension", which waits while a cast runs. A copy loaded by
 * hand opens the download page, as the desktop app's Check for updates does.
 * @returns The row
 */
export function UpdatesRow(): JSX.Element {
  const channel = useMemo(() => updateChannel(), []);
  return channel === 'store' ? <StoreUpdatesRow /> : <ManualUpdatesRow />;
}

/**
 * The row for an unpacked copy, which never updates itself: the Button opens the releases
 * page in a new tab.
 * @returns The row
 */
function ManualUpdatesRow(): JSX.Element {
  const { t } = useTranslation();
  const openReleases = useCallback(() => {
    chrome.tabs.create({ url: DOWNLOAD_URL });
  }, []);
  return (
    <SettingsRow
      label={t('about_updates')}
      help={t('about_updates_manual_hint')}
      controlWidth="action"
      control={(a11y) => (
        <Button icon="external" onClick={openReleases} aria-describedby={a11y['aria-describedby']}>
          {t('about_check_for_updates')}
        </Button>
      )}
    />
  );
}

/**
 * The row for a store install: the Button asks the store, the result is the row's note (said
 * through the Announcer), and a version found makes the Button restart the extension, which
 * applies it. A restart ends every cast, so it is disabled while any runs.
 * @returns The row
 */
function StoreUpdatesRow(): JSX.Element {
  const { t } = useTranslation();
  const { say } = useAnnouncer();
  const { casts } = useActiveCasts();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const casting = casts.length > 0;

  // Each result is said once, politely, even when it is the same as the last.
  const check = useCallback(async () => {
    const next = await checkForUpdate();
    setResult(next);
    const said = updateNote(next, casting);
    say(t(said.key, { version: said.version }));
  }, [casting, say, t]);
  const restart = useCallback(() => chrome.runtime.reload(), []);

  const found = result && updateNote(result, casting);
  const note = found ? t(found.key, { version: found.version }) : undefined;

  const ready = result?.kind === 'ready';

  return (
    <SettingsRow
      label={t('about_updates')}
      help={t('about_updates_store_hint')}
      note={note}
      controlWidth="action"
      // One Button in both roles, so focus stays on it when a check finds a version; the
      // change of role returns it from done to idle.
      control={(a11y) =>
        ready ? (
          <Button
            icon="refresh"
            disabled={casting}
            onClick={restart}
            resetKey={ready}
            aria-describedby={a11y['aria-describedby']}
          >
            {t('about_update_restart')}
          </Button>
        ) : (
          <Button
            onAction={check}
            resetKey={ready}
            labels={{ busy: t('about_checking'), failed: t('try_again') }}
            aria-describedby={a11y['aria-describedby']}
          >
            {t('about_check_for_updates')}
          </Button>
        )
      }
    />
  );
}
