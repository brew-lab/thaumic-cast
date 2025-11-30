import { useState, useEffect } from 'preact/hooks';
import { discoverLocalSpeakers, testServerConnection } from '../api/client';
import { getExtensionSettings, saveExtensionSettings, clearCachedGroups } from '../lib/settings';
import { isValidIPv4, isValidUrl } from '@thaumic-cast/shared';
import type { SonosMode } from '@thaumic-cast/shared';
import { t, setLocale, type SupportedLocale } from '../lib/i18n';
import { useAuthStatus } from '../hooks/useAuthStatus';

export function Options() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [speakerIp, setSpeakerIp] = useState('');
  const [language, setLanguage] = useState<SupportedLocale>('en');
  const [saved, setSaved] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Track original values to detect changes for cache invalidation
  const [originalMode, setOriginalMode] = useState<SonosMode>('cloud');
  const [originalSpeakerIp, setOriginalSpeakerIp] = useState('');

  // Authentication
  const { isLoggedIn, userEmail, signingOut, handleSignOut } = useAuthStatus();

  // Validation states
  const [urlError, setUrlError] = useState<string | null>(null);
  const [ipError, setIpError] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    getExtensionSettings().then((settings) => {
      setServerUrl(settings.serverUrl);
      setSonosMode(settings.sonosMode);
      setSpeakerIp(settings.speakerIp);
      setLanguage(settings.language);
      setLocale(settings.language);
      // Track original values for cache invalidation
      setOriginalMode(settings.sonosMode);
      setOriginalSpeakerIp(settings.speakerIp);
    });
  }, []);

  // Validate URL on blur
  const validateUrl = () => {
    if (serverUrl && !isValidUrl(serverUrl)) {
      setUrlError(t('errors.invalidUrlExample'));
    } else {
      setUrlError(null);
    }
  };

  // Validate IP on blur
  const validateIp = () => {
    if (speakerIp && !isValidIPv4(speakerIp.trim())) {
      setIpError(t('errors.invalidIpExample'));
    } else {
      setIpError(null);
    }
  };

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setConnectionResult(null);

    // Test the current input value, not the saved one
    const result = await testServerConnection(serverUrl);

    if (result.success) {
      setConnectionResult({
        success: true,
        message: `Connected! (${result.latencyMs}ms)`,
      });
    } else {
      setConnectionResult({
        success: false,
        message: result.error || t('errors.connectionFailed'),
      });
    }

    setTestingConnection(false);
  };

  const handleSave = async () => {
    // Validate before saving
    if (!isValidUrl(serverUrl)) {
      setUrlError(t('errors.invalidUrl'));
      return;
    }

    if (speakerIp && !isValidIPv4(speakerIp.trim())) {
      setIpError(t('errors.invalidIp'));
      return;
    }

    // Normalize URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    // Trim speaker IP
    const trimmedIp = speakerIp.trim();

    // Clear speaker cache if mode or speaker IP changed
    if (sonosMode !== originalMode || trimmedIp !== originalSpeakerIp) {
      await clearCachedGroups();
    }

    await saveExtensionSettings({
      serverUrl: normalizedUrl,
      sonosMode,
      speakerIp: trimmedIp,
      language,
    });
    setServerUrl(normalizedUrl);
    setSpeakerIp(trimmedIp);
    setLocale(language);
    // Update tracked originals
    setOriginalMode(sonosMode);
    setOriginalSpeakerIp(trimmedIp);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setSpeakerCount(null);

    // Clear cache so next popup open fetches fresh data
    await clearCachedGroups();

    const { data, error } = await discoverLocalSpeakers(true);

    if (error) {
      setDiscoveryError(error);
    } else if (data) {
      setSpeakerCount(data.speakers.length);
    }

    setDiscovering(false);
  };

  const handleSignIn = () => {
    chrome.tabs.create({ url: `${serverUrl}/login` });
  };

  const hasValidationErrors = !!urlError || !!ipError;

  return (
    <div>
      <h1>{t('app.title')}</h1>

      <div class="card">
        <h2>{t('labels.serverConfig')}</h2>
        <div class="form-group">
          <label htmlFor="serverUrl">{t('labels.serverUrl')}</label>
          <input
            id="serverUrl"
            type="url"
            value={serverUrl}
            onInput={(e) => {
              setServerUrl((e.target as HTMLInputElement).value);
              setUrlError(null);
              setConnectionResult(null);
            }}
            onBlur={validateUrl}
            placeholder={t('placeholders.serverUrl')}
            class={urlError ? 'input-error' : ''}
          />
          {urlError && <p class="field-error">{urlError}</p>}
          <p class="hint">{t('hints.serverUrl')}</p>
        </div>
        <div class="form-group">
          <button
            class="btn btn-secondary"
            onClick={handleTestConnection}
            disabled={testingConnection || !!urlError}
          >
            {testingConnection ? t('placeholders.testing') : t('actions.testConnection')}
          </button>
          {connectionResult && (
            <p class={connectionResult.success ? 'success-message' : 'error-message'}>
              {connectionResult.message}
            </p>
          )}
        </div>
      </div>

      <div class="card">
        <h2>{t('labels.sonosMode')}</h2>
        <div class="form-group">
          <label>
            <input
              type="radio"
              name="sonosMode"
              value="cloud"
              checked={sonosMode === 'cloud'}
              onChange={() => setSonosMode('cloud')}
            />
            {t('labels.cloudMode')}
          </label>
          <p class="hint">{t('hints.cloud')}</p>
        </div>
        <div class="form-group">
          <label>
            <input
              type="radio"
              name="sonosMode"
              value="local"
              checked={sonosMode === 'local'}
              onChange={() => setSonosMode('local')}
            />
            {t('labels.localMode')}
          </label>
          <p class="hint">{t('hints.local')}</p>
        </div>

        {sonosMode === 'local' && (
          <>
            <div class="form-group">
              <label htmlFor="speakerIp">{t('labels.speakerIp')}</label>
              <input
                id="speakerIp"
                type="text"
                value={speakerIp}
                onInput={(e) => {
                  setSpeakerIp((e.target as HTMLInputElement).value);
                  setIpError(null);
                }}
                onBlur={validateIp}
                placeholder={t('placeholders.speakerIp')}
                class={ipError ? 'input-error' : ''}
              />
              {ipError && <p class="field-error">{ipError}</p>}
              <p class="hint">{t('hints.speakerIp')}</p>
            </div>
            {!speakerIp && (
              <div class="form-group">
                <button class="btn btn-secondary" onClick={handleDiscover} disabled={discovering}>
                  {discovering ? t('placeholders.scanning') : t('placeholders.scanSpeakers')}
                </button>
                {speakerCount !== null && (
                  <p class="success-message">
                    {t('messages.discoveryFound', {
                      count: speakerCount,
                      plural: speakerCount !== 1 ? 's' : '',
                    })}
                  </p>
                )}
                {discoveryError && <p class="error-message">{discoveryError}</p>}
                <p class="hint" style={{ marginTop: '8px' }}>
                  {t('hints.discovery')}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div class="card">
        <h2>{t('labels.language')}</h2>
        <div class="form-group">
          <label htmlFor="language">{t('labels.language')}</label>
          <select
            id="language"
            value={language}
            onChange={(e) => setLanguage((e.target as HTMLSelectElement).value as SupportedLocale)}
          >
            <option value="en">English</option>
          </select>
          <p class="hint">{t('hints.language')}</p>
        </div>
      </div>

      <div class="card">
        <h2>{t('settings.account')}</h2>
        {isLoggedIn ? (
          <div class="account-info">
            <div class="account-email">
              <span class="account-label">{t('labels.signedInAs')}</span>
              <span class="account-value">{userEmail}</span>
            </div>
            <button class="btn btn-secondary" onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? t('actions.signingOut') : t('actions.signOut')}
            </button>
          </div>
        ) : (
          <div class="sign-in-section">
            <p class="hint">{t('messages.signInForCloud')}</p>
            <button class="btn btn-primary" onClick={handleSignIn}>
              {t('actions.signIn')}
            </button>
          </div>
        )}
      </div>

      <button class="btn btn-primary" onClick={handleSave} disabled={hasValidationErrors}>
        {t('actions.saveSettings')}
      </button>
      {saved && <p class="success-message">{t('messages.settingsSaved')}</p>}
      {hasValidationErrors && <p class="error-message">{t('errors.fixBeforeSaving')}</p>}
    </div>
  );
}
