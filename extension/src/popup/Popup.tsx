import { useEffect, useState } from 'preact/hooks';
import type { QualityPreset } from '@thaumic-cast/shared';
import { Header, CurrentTabCard, MediaSourceCard, PlaybackControls } from './components';
import { useMediaSources } from './hooks/useMediaSources';
import { useCasting } from './hooks/useCasting';
import type { DisplayGroup } from './hooks/useCasting';
import { t, setLocale } from '../lib/i18n';
import { getExtensionSettings, saveExtensionSettings, DESKTOP_APP_DEEPLINK } from '../lib/settings';

export function Popup() {
  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [quality, setQuality] = useState<QualityPreset>('medium');

  // Initialize from settings
  useEffect(() => {
    getExtensionSettings().then((settings) => {
      setLocale(settings.language);
      setQuality(settings.quality);
      if (settings.selectedGroupId) {
        setSelectedGroup(settings.selectedGroupId);
      }
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
    desktopDetected,
    needsAuthForLocalMode,
    sonosMode,
    backendType,
    sonosLinked,
    groups,
    castStatus,
    casting: isCasting,
    castingPhase,
    volume,
    handleVolumeChange,
    isMuted,
    muteLoading,
    handleMuteToggle,
    stopping,
    handleCast,
    handleStop,
    getCastButtonLabel,
    switchToLocalMode,
    reload,
  } = casting;

  // Validate selected group exists in available groups
  useEffect(() => {
    if (groups.length > 0 && selectedGroup) {
      const groupExists = groups.some((g) => g.id === selectedGroup);
      if (!groupExists) {
        // Saved group no longer exists, fall back to first group
        const firstGroupId = groups[0]?.id || '';
        setSelectedGroup(firstGroupId);
        saveExtensionSettings({ selectedGroupId: firstGroupId });
      }
    }
  }, [groups, selectedGroup]);

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  function openDesktopApp() {
    chrome.tabs.create({ url: DESKTOP_APP_DEEPLINK });
  }

  // Show desktop app link when in local mode (unless explicitly using cloud server)
  // This helps users who haven't run "Test Connection" yet or when the app isn't running
  const showDesktopAppLink = sonosMode === 'local' && backendType !== 'server';

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

  // Not logged in and in cloud mode - show mode selector with cloud disabled
  if (!isLoggedIn && sonosMode === 'cloud') {
    return (
      <div>
        <Header onSettings={openOptions} />

        {desktopDetected && (
          <div class="desktop-detected-banner">
            <p>{t('messages.desktopDetected')}</p>
            <button class="btn btn-primary" onClick={switchToLocalMode}>
              {t('actions.useLocalMode')}
            </button>
          </div>
        )}

        <div class="mode-selector">
          <h3 class="mode-selector-title">{t('labels.sonosMode')}</h3>

          <div class="mode-option mode-option-disabled">
            <div class="mode-option-header">
              <span class="mode-option-name">{t('labels.cloudMode')}</span>
              <span class="mode-badge-disabled">{t('messages.signInRequired')}</span>
            </div>
            <p class="mode-option-hint">{t('hints.cloud')}</p>
          </div>

          <button class="mode-option mode-option-clickable" onClick={switchToLocalMode}>
            <div class="mode-option-header">
              <span class="mode-option-name">{t('labels.localMode')}</span>
              {desktopDetected && (
                <span class="mode-badge-available">{t('messages.available')}</span>
              )}
            </div>
            <p class="mode-option-hint">{t('hints.local')}</p>
          </button>
        </div>

        <p class="settings-hint">{t('messages.signInHint')}</p>
      </div>
    );
  }

  // Local mode on cloud server without auth - show sign-in prompt
  if (needsAuthForLocalMode) {
    return (
      <div>
        <Header onSettings={openOptions} />
        <div class="login-prompt">
          <p>{t('messages.localModeAuthRequired')}</p>
          <button class="btn btn-primary" onClick={openOptions}>
            {t('actions.signIn')}
          </button>
          <p class="hint" style={{ marginTop: '12px', fontSize: '12px', opacity: 0.7 }}>
            {t('messages.localModeDesktopHint')}
          </p>
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
            {groupsLoading ? t('casting.scanning') : t('actions.retry')}
          </button>
          <p class="hint" style={{ marginTop: '8px', fontSize: '12px', opacity: 0.7 }}>
            {t('messages.retryHint')}
          </p>
          {showDesktopAppLink && (
            <div style={{ marginTop: '12px' }}>
              <p class="hint" style={{ fontSize: '12px', opacity: 0.7, marginBottom: '8px' }}>
                {t('messages.desktopAppHint')}
              </p>
              <button class="btn btn-link" onClick={openDesktopApp}>
                {t('messages.openDesktopApp')}
              </button>
            </div>
          )}
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
        <div class="error-container" role="alert">
          <p class="error-message">
            {error}
            <button
              class="dismiss-btn"
              onClick={() => setError(null)}
              aria-label={t('aria.dismissError')}
            >
              ×
            </button>
          </p>
          {showDesktopAppLink && (
            <button class="btn btn-link btn-sm" onClick={openDesktopApp}>
              {t('messages.openDesktopApp')}
            </button>
          )}
        </div>
      )}

      {warning && (
        <p class="warning-message" role="alert">
          {warning}
          <button
            class="dismiss-btn"
            onClick={() => setWarning(null)}
            aria-label={t('aria.dismissWarning')}
          >
            ×
          </button>
        </p>
      )}

      {sonosMode === 'local' && <div class="mode-badge">{t('mode.localBadge')}</div>}

      {groupsLoading && <p class="status-message">{t('messages.findingSpeakers')}</p>}

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
              ? t('messages.showLess')
              : t('messages.showAll', { count: otherMediaSources.length + 1 })}
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
            <div class="value">
              {castStatus.groupName}
              <span class="quality-indicator"> · {t(`quality.${quality}Label`)}</span>
            </div>
          </div>
          <div class="form-group volume-control">
            <label htmlFor="volume-casting">
              {t('labels.volumeCasting')}: {volume}%
            </label>
            <div class="volume-row">
              <button
                class={`mute-btn ${isMuted ? 'muted' : ''}`}
                onClick={handleMuteToggle}
                disabled={muteLoading}
                aria-label={isMuted ? t('aria.unmute') : t('aria.mute')}
              >
                {isMuted ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                id="volume-casting"
                type="range"
                min="0"
                max="100"
                value={volume}
                disabled={isMuted}
                onInput={(e) =>
                  handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
                }
              />
            </div>
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
              onChange={(e) => {
                const newGroup = (e.target as HTMLSelectElement).value;
                setSelectedGroup(newGroup);
                saveExtensionSettings({ selectedGroupId: newGroup });
              }}
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
              onChange={(e) => {
                const newQuality = (e.target as HTMLSelectElement).value as QualityPreset;
                setQuality(newQuality);
                saveExtensionSettings({ quality: newQuality });
              }}
            >
              <option value="ultra-low">{t('quality.ultra-low')}</option>
              <option value="low">{t('quality.low')}</option>
              <option value="medium">{t('quality.medium')}</option>
              <option value="high">{t('quality.high')}</option>
            </select>
          </div>

          <div class="form-group volume-control">
            <label htmlFor="volume">
              {t('labels.volume')}: {volume}%
            </label>
            <div class="volume-row">
              <button
                class={`mute-btn ${isMuted ? 'muted' : ''}`}
                onClick={handleMuteToggle}
                disabled={muteLoading || !selectedGroup}
                aria-label={isMuted ? t('aria.unmute') : t('aria.mute')}
              >
                {isMuted ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                id="volume"
                type="range"
                min="0"
                max="100"
                value={volume}
                disabled={!selectedGroup || isMuted}
                onInput={(e) =>
                  handleVolumeChange(parseInt((e.target as HTMLInputElement).value, 10))
                }
              />
            </div>
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
