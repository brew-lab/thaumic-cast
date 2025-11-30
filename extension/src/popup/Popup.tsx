import { useEffect, useState } from 'preact/hooks';
import type { QualityPreset } from '@thaumic-cast/shared';
import { Header, CurrentTabCard, MediaSourceCard, PlaybackControls } from './components';
import { useMediaSources } from './hooks/useMediaSources';
import { useCasting } from './hooks/useCasting';
import type { DisplayGroup } from './hooks/useCasting';
import { t, setLocale } from '../lib/i18n';
import { getExtensionSettings } from '../lib/settings';

export function Popup() {
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [quality, setQuality] = useState<QualityPreset>('medium');

  // Initialize locale from settings
  useEffect(() => {
    getExtensionSettings().then((settings) => {
      setLocale(settings.language);
    });
  }, []);

  const media = useMediaSources();

  const casting = useCasting({
    selectedSourceTabId: media.selectedSourceTabId,
    selectedGroup,
    setSelectedGroup,
    quality,
    selectedSource: media.selectedSource,
    isCurrentTabSelected: media.isCurrentTabSelected,
    activeTab: media.activeTab,
  });

  const {
    loading,
    groupsLoading,
    error,
    setError,
    warning,
    setWarning,
    isLoggedIn,
    sonosMode,
    sonosLinked,
    groups,
    castStatus,
    casting: isCasting,
    castingPhase,
    volume,
    volumeLoading,
    handleVolumeChange,
    stopping,
    handleCast,
    handleStop,
    getCastButtonLabel,
    reload,
  } = casting;

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  async function openServerLogin() {
    const { serverUrl } = await getExtensionSettings();
    chrome.tabs.create({ url: `${serverUrl}/login` });
  }

  async function openSonosLink() {
    const { serverUrl } = await getExtensionSettings();
    chrome.tabs.create({ url: `${serverUrl}/sonos/link` });
  }

  if (loading) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <p class="status-message">{t('messages.loading')}</p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <div class="login-prompt">
          <p>{t('messages.signInPrompt')}</p>
          <button class="btn btn-primary" onClick={openServerLogin}>
            {t('actions.signIn')}
          </button>
        </div>
      </div>
    );
  }

  if (sonosMode === 'cloud' && !sonosLinked) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <div class="login-prompt">
          <p>{t('messages.connectSonos')}</p>
          <button class="btn btn-primary" onClick={openSonosLink}>
            {t('actions.connectSonos')}
          </button>
        </div>
      </div>
    );
  }

  if (sonosMode === 'local' && groups.length === 0 && !groupsLoading) {
    return (
      <div>
        <Header onSettings={openOptions} />
        {error && (
          <p class="error-message" role="alert">
            {error}
          </p>
        )}
        <div class="login-prompt">
          <p>{t('messages.noSpeakers')}</p>
          <button class="btn btn-secondary" onClick={reload} disabled={groupsLoading}>
            {groupsLoading ? 'Scanning...' : t('actions.retry')}
          </button>
          <p class="hint" style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
            {t('messages.retryHint')}
          </p>
        </div>
      </div>
    );
  }

  const currentTabMedia = media.currentTabMedia;
  const otherMediaSources = media.otherMediaSources;
  const selectedSource = media.selectedSource;

  return (
    <div>
      <Header onSettings={openOptions} />

      {error && (
        <p class="error-message" role="alert">
          {error}
          <button class="dismiss-btn" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </p>
      )}

      {warning && (
        <p class="warning-message" role="alert">
          {warning}
          <button class="dismiss-btn" onClick={() => setWarning(null)} aria-label="Dismiss warning">
            ×
          </button>
        </p>
      )}

      {sonosMode === 'local' && <div class="mode-badge">{t('mode.localBadge')}</div>}

      {groupsLoading && <p class="status-message">Finding speakers...</p>}

      <div class="media-sources">
        <div class="media-sources-header">{t('labels.castSource')}</div>
        <div class="media-source-list">
          {media.activeTab && (
            <CurrentTabCard
              tab={media.activeTab}
              mediaInfo={currentTabMedia}
              isSelected={media.isCurrentTabSelected}
              onClick={() => {
                if (media.activeTab?.id) {
                  media.setSelectedSourceTabId(media.activeTab.id);
                }
              }}
            />
          )}
          {(media.showAllSources
            ? otherMediaSources
            : otherMediaSources.slice(0, media.maxVisibleSources - 1)
          ).map((source) => (
            <MediaSourceCard
              key={source.tabId}
              source={source}
              isSelected={source.tabId === media.selectedSourceTabId}
              onClick={() => media.setSelectedSourceTabId(source.tabId)}
            />
          ))}
        </div>
        {otherMediaSources.length > media.maxVisibleSources - 1 && (
          <button
            class="see-all-btn"
            onClick={() => media.setShowAllSources(!media.showAllSources)}
          >
            {media.showAllSources
              ? 'Show less'
              : `See all sources (${otherMediaSources.length + 1})`}
          </button>
        )}
        {selectedSource && (
          <PlaybackControls
            isPlaying={selectedSource.isPlaying}
            onPrevious={() => media.handleMediaControl('previoustrack')}
            onPlayPause={() =>
              media.handleMediaControl(selectedSource.isPlaying ? 'pause' : 'play')
            }
            onNext={() => media.handleMediaControl('nexttrack')}
          />
        )}
      </div>

      {castStatus.isActive ? (
        <>
          <div class="casting-status">
            <div class="label">
              <span class="casting-indicator" aria-hidden="true" />
              {t('status.castingTo')}
            </div>
            <div class="value">{castStatus.groupName}</div>
          </div>
          <div class="form-group">
            <label htmlFor="volume-casting">
              {t('labels.volumeCasting')}: {volume}%
            </label>
            <input
              id="volume-casting"
              type="range"
              min="0"
              max="100"
              value={volume}
              disabled={volumeLoading}
              onInput={(e) =>
                handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
              }
            />
          </div>
          <button class="btn btn-primary btn-stop" onClick={handleStop} disabled={stopping}>
            {stopping ? t('actions.stopBusy') : t('actions.stop')}
          </button>
        </>
      ) : (
        <>
          <div class="form-group">
            <label htmlFor="group">{t('labels.speakerGroup')}</label>
            <select
              id="group"
              value={selectedGroup}
              onChange={(e) => setSelectedGroup((e.target as HTMLSelectElement).value)}
            >
              {groups.map((group: DisplayGroup) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>

          <div class="form-group">
            <label htmlFor="quality">{t('labels.quality')}</label>
            <select
              id="quality"
              value={quality}
              onChange={(e) => setQuality((e.target as HTMLSelectElement).value as QualityPreset)}
            >
              <option value="low">Low (128 kbps)</option>
              <option value="medium">Medium (192 kbps)</option>
              <option value="high">High (320 kbps)</option>
            </select>
          </div>

          <div class="form-group">
            <label htmlFor="volume">
              {t('labels.volume')}: {volume}%
            </label>
            <input
              id="volume"
              type="range"
              min="0"
              max="100"
              value={volume}
              disabled={volumeLoading || !selectedGroup}
              onInput={(e) =>
                handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
              }
            />
          </div>

          <button
            class="btn btn-primary"
            onClick={handleCast}
            disabled={isCasting || !selectedGroup || groupsLoading}
          >
            {isCasting ? castingPhase || t('actions.cast') : getCastButtonLabel(t)}
          </button>
        </>
      )}
    </div>
  );
}
