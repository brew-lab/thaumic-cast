import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { CopyField } from '@thaumic-cast/ui';
import { createLogger } from '@thaumic-cast/shared';
import { fetchStats, getPlatform, stats, type Platform } from '../state/store';
import { listenUrl, type SpeakerCast } from '../lib/listen-url';
import styles from './ListenUrl.module.css';

const log = createLogger('ListenUrl');

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

/**
 * The "Copy URL" control on a casting speaker's card (DESIGN.md M-copy, P-copy):
 * copies the URL a player such as VLC or a browser can open to hear the cast,
 * with a short note on what it is. The URL is worked out at the click, from a
 * refreshed address, and the clipboard write starts inside the click. If the
 * clipboard refuses, the URL is shown selected in a field for copying by hand.
 * "Copied" holds until the cast changes or the action is pressed again.
 * @param props - Component props
 * @param props.cast - The cast the card's speaker is playing
 * @returns The rendered control
 */
export function ListenUrl({ cast }: ListenUrlProps) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform | null>(null);

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

  return (
    <div className={styles.listen}>
      <CopyField
        getValue={() => freshListenUrl(cast)}
        action={t('device.listen_url_copy')}
        done={t('device.listen_url_copied')}
        refusedNote={t('device.listen_url_copy_failed')}
        unavailableNote={t('device.listen_url_unavailable')}
        reveal="onRefusal"
        resetKey={`${cast.streamId}:${cast.codec}`}
        help={
          <>
            <p>{t('device.listen_url_hint')}</p>
            {/* Browser-wide capture is Windows-only and always casts PCM. */}
            {cast.codec === 'pcm' && mayCaptureBrowserWide(platform) && (
              <p>{t('device.listen_url_echo')}</p>
            )}
          </>
        }
      />
    </div>
  );
}
