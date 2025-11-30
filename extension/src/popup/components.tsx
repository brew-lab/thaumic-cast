import type { MediaInfo } from '@thaumic-cast/shared';
import { t } from '../lib/i18n';

export function Header({ onSettings }: { onSettings: () => void }) {
  return (
    <div class="header">
      <h1>{t('app.title')}</h1>
      <button
        class="settings-btn"
        onClick={onSettings}
        aria-label={t('aria.settings')}
        title={t('labels.settings')}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7l2.8-2.8" />
        </svg>
      </button>
    </div>
  );
}

interface CurrentTabCardProps {
  tab: chrome.tabs.Tab;
  mediaInfo: MediaInfo | null | undefined;
  isSelected: boolean;
  onClick: () => void;
}

export function CurrentTabCard({ tab, mediaInfo, isSelected, onClick }: CurrentTabCardProps) {
  const hasMedia = mediaInfo && (mediaInfo.hasMetadata || mediaInfo.isPlaying);
  const title = hasMedia
    ? mediaInfo.title || tab.title || t('media.currentTab')
    : tab.title || t('media.currentTab');
  const subtitle = hasMedia
    ? mediaInfo.artist || t('media.audioPlaying')
    : t('media.noMediaDetected');
  const artwork = hasMedia ? mediaInfo.artwork : null;

  return (
    <button
      class={`media-source-card ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div class="media-artwork">
        {artwork ? (
          <img src={artwork} alt="" />
        ) : tab.favIconUrl ? (
          <img src={tab.favIconUrl} alt="" />
        ) : (
          <div class="media-artwork-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V7h14v12z" />
            </svg>
          </div>
        )}
      </div>
      <div class="media-info">
        <div class="media-title">{title}</div>
        <div class="media-artist">{subtitle}</div>
      </div>
      <div class={`media-select-indicator ${isSelected ? 'selected' : ''}`}>
        {isSelected ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        )}
      </div>
    </button>
  );
}

interface MediaSourceCardProps {
  source: MediaInfo;
  isSelected: boolean;
  onClick: () => void;
}

export function MediaSourceCard({ source, isSelected, onClick }: MediaSourceCardProps) {
  return (
    <button
      class={`media-source-card ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div class="media-artwork">
        {source.artwork ? (
          <img src={source.artwork} alt="" />
        ) : source.tabFavicon ? (
          <img src={source.tabFavicon} alt="" />
        ) : (
          <div class="media-artwork-placeholder">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
        )}
      </div>
      <div class="media-info">
        <div class="media-title">{source.title || source.tabTitle}</div>
        <div class="media-artist">
          {source.hasMetadata ? source.artist : t('media.audioPlaying')}
        </div>
      </div>
      <div class={`media-select-indicator ${isSelected ? 'selected' : ''}`}>
        {isSelected ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        )}
      </div>
    </button>
  );
}

interface PlaybackControlsProps {
  isPlaying: boolean;
  onPrevious: () => void;
  onPlayPause: () => void;
  onNext: () => void;
}

export function PlaybackControls({
  isPlaying,
  onPrevious,
  onPlayPause,
  onNext,
}: PlaybackControlsProps) {
  return (
    <div class="playback-controls">
      <button
        class="playback-btn"
        onClick={onPrevious}
        aria-label={t('playback.previousTrack')}
        title={t('playback.previous')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
        </svg>
      </button>
      <button
        class="playback-btn playback-btn-main"
        onClick={onPlayPause}
        aria-label={isPlaying ? t('playback.pause') : t('playback.play')}
        title={isPlaying ? t('playback.pause') : t('playback.play')}
      >
        {isPlaying ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <button
        class="playback-btn"
        onClick={onNext}
        aria-label={t('playback.nextTrack')}
        title={t('playback.next')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </div>
  );
}
