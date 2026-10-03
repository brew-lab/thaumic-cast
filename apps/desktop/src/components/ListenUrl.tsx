import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-preact';
import { Button, Input } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import { fetchStats, getPlatform, stats, type Platform } from '../state/store';
import { listenUrl, type SpeakerCast } from '../lib/listen-url';
import { copyPendingText } from '../lib/clipboard';
import styles from './ListenUrl.module.css';

const log = createLogger('ListenUrl');

/** How long the button reads "Copied" after a copy (ms). */
const COPIED_FEEDBACK_DURATION_MS = 2000;

/** The platform, asked for once and shared by every card. */
let platformRequest: Promise<Platform> | null = null;

/**
 * Whether browser-wide capture can be in use here: it exists only on Windows.
 * An unknown platform counts, so the echo note is never wrongly left out.
 * @param platform - The platform, or null while it is not known yet
 * @returns True if the note on echoes applies
 */
function mayCaptureBrowserWide(platform: Platform | null): boolean {
  return platform === 'windows' || platform === 'unknown';
}

interface ListenUrlProps {
  /** The cast the card's speaker is playing. */
  cast: SpeakerCast;
}

/**
 * Builds the cast's URL from the companion's address as it is now, refreshing
 * it first so a changed IP is picked up, and falling back to the last known
 * address if that fails.
 * @param cast - The cast to build the URL for
 * @returns The URL
 * @throws {Error} If the address or port is not known
 */
async function freshListenUrl(cast: SpeakerCast): Promise<string> {
  try {
    await fetchStats();
  } catch (error) {
    log.warn('Could not refresh the address; using the last one known:', error);
  }
  const current = stats.value;
  const url = current ? listenUrl(current.localIp, current.port, cast) : null;
  if (!url) throw new Error('The address or port is not known');
  return url;
}

/** What the last click came to, for the note and the screen reader. */
type CopyResult = 'idle' | 'copied' | 'refused' | 'unavailable';

/**
 * The "Copy URL" control on a casting speaker's card: copies the URL a player
 * such as VLC or a browser can open to hear the cast, with a short note on
 * what it is. If the clipboard refuses, the URL is shown selected in a field
 * for copying by hand.
 * @param props - Component props
 * @param props.cast - The cast the card's speaker is playing
 * @returns The rendered control
 */
export function ListenUrl({ cast }: ListenUrlProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<CopyResult>('idle');
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const failedNoteId = useId();

  useEffect(() => {
    let live = true;
    platformRequest ??= getPlatform().catch((): Platform => 'unknown');
    platformRequest.then((value) => {
      if (live) setPlatform(value);
    });
    return () => {
      live = false;
    };
  }, []);

  // A new cast on this card has a new URL; drop what was shown for the old one.
  useEffect(() => {
    setResult('idle');
    setManualUrl(null);
  }, [cast.streamId, cast.codec]);

  useEffect(() => {
    if (result !== 'copied') return;
    const timer = setTimeout(() => setResult('idle'), COPIED_FEEDBACK_DURATION_MS);
    return () => clearTimeout(timer);
  }, [result]);

  // Runs on every refusal, even when the URL is the same as last time.
  const selectField = () => {
    requestAnimationFrame(() => fieldRef.current?.select());
  };

  const copy = async () => {
    // The clipboard write must start before anything is awaited: WebKit only
    // allows it during the click itself.
    const pending = freshListenUrl(cast);
    try {
      await copyPendingText(pending);
      setManualUrl(null);
      setResult('copied');
    } catch (error) {
      const url = await pending.catch(() => null);
      if (!url) {
        log.warn('No URL to copy: the address is not known:', error);
        setManualUrl(null);
        setResult('unavailable');
        return;
      }
      log.warn('The clipboard refused the URL; showing it to copy by hand:', error);
      setManualUrl(url);
      setResult('refused');
      selectField();
    }
  };

  const copied = result === 'copied';
  const announcement =
    result === 'copied'
      ? t('device.listen_url_copied')
      : result === 'refused'
        ? t('device.listen_url_copy_failed')
        : result === 'unavailable'
          ? t('device.listen_url_unavailable')
          : '';

  return (
    <div className={styles.listen}>
      <Button variant="secondary" onClick={copy} className={styles.copyButton}>
        {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
        {copied ? t('device.listen_url_copied') : t('device.listen_url_copy')}
      </Button>
      <span role="status" aria-live="polite" className={styles.status}>
        {announcement}
      </span>
      {manualUrl && (
        <>
          <Input
            ref={fieldRef}
            readOnly
            value={manualUrl}
            aria-label={t('device.listen_url_field')}
            aria-describedby={failedNoteId}
            className={styles.field}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p id={failedNoteId} className={styles.note}>
            {t('device.listen_url_copy_failed')}
          </p>
        </>
      )}
      {result === 'unavailable' && (
        <p className={styles.note}>{t('device.listen_url_unavailable')}</p>
      )}
      <p className={styles.note}>{t('device.listen_url_hint')}</p>
      {/* Browser-wide capture is Windows-only and always casts PCM. */}
      {cast.codec === 'pcm' && mayCaptureBrowserWide(platform) && (
        <p className={styles.note}>{t('device.listen_url_echo')}</p>
      )}
    </div>
  );
}
