import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, SettingsRow, useAnnouncer } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import { onboardingAgainNote, showOnboardingAgain } from '../../lib/onboarding-again';
import { ONBOARDING_STORAGE_KEY } from '../../lib/settings';

const log = createLogger('IntroductionRow');

/**
 * About's "Introduction" row (DESIGN.md §11 call 105): Show again resets the popup's
 * onboarding to its first step and opens the popup. Where the popup cannot be opened from
 * here, the row's note says to open it from the toolbar; the note goes once the onboarding is
 * finished or skipped again.
 * @returns The row
 */
export function IntroductionRow(): JSX.Element {
  const { t } = useTranslation();
  const { say } = useAnnouncer();
  const [note, setNote] = useState<string | undefined>(undefined);

  const showAgain = useCallback(async () => {
    try {
      const key = onboardingAgainNote(await showOnboardingAgain());
      const words = key ? t(key) : undefined;
      setNote(words);
      if (words) say(words);
    } catch (err) {
      log.error('Failed to reset the onboarding:', err);
    }
  }, [say, t]);

  // Finishing or skipping the onboarding in the popup answers the note.
  useEffect(() => {
    if (!note) return;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const next = changes[ONBOARDING_STORAGE_KEY]?.newValue as { completed?: boolean } | undefined;
      if (area === 'local' && next?.completed) setNote(undefined);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [note]);

  return (
    <SettingsRow
      label={t('about_introduction')}
      help={t('about_introduction_hint')}
      note={note}
      controlWidth="action"
      control={(a11y) => (
        <Button onClick={showAgain} aria-describedby={a11y['aria-describedby']}>
          {t('about_introduction_show')}
        </Button>
      )}
    />
  );
}
