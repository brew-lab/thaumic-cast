import { useState, useEffect } from 'preact/hooks';
import { discoverLocalSpeakers, testServerConnection } from '../api/client';
import { getExtensionSettings, saveExtensionSettings } from '../lib/settings';
import { isValidIPv4, isValidUrl } from '@thaumic-cast/shared';
import type { SonosMode } from '@thaumic-cast/shared';
import { t, setLocale, type SupportedLocale } from '../lib/i18n';

export function Options() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [speakerIp, setSpeakerIp] = useState('');
  const [language, setLanguage] = useState<SupportedLocale>('en');
  const [saved, setSaved] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

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
    });
  }, []);

  // Validate URL on blur
  const validateUrl = () => {
    if (serverUrl && !isValidUrl(serverUrl)) {
      setUrlError('Please enter a valid URL (e.g., http://192.168.1.100:3000)');
    } else {
      setUrlError(null);
    }
  };

  // Validate IP on blur
  const validateIp = () => {
    if (speakerIp && !isValidIPv4(speakerIp.trim())) {
      setIpError('Please enter a valid IP address (e.g., 192.168.1.50)');
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
        message: result.error || 'Connection failed',
      });
    }

    setTestingConnection(false);
  };

  const handleSave = async () => {
    // Validate before saving
    if (!isValidUrl(serverUrl)) {
      setUrlError('Please enter a valid URL');
      return;
    }

    if (speakerIp && !isValidIPv4(speakerIp.trim())) {
      setIpError('Please enter a valid IP address');
      return;
    }

    // Normalize URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    // Trim speaker IP
    const trimmedIp = speakerIp.trim();
    await saveExtensionSettings({
      serverUrl: normalizedUrl,
      sonosMode,
      speakerIp: trimmedIp,
      language,
    });
    setServerUrl(normalizedUrl);
    setSpeakerIp(trimmedIp);
    setLocale(language);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setSpeakerCount(null);

    const { data, error } = await discoverLocalSpeakers(true);

    if (error) {
      setDiscoveryError(error);
    } else if (data) {
      setSpeakerCount(data.speakers.length);
    }

    setDiscovering(false);
  };

  const hasValidationErrors = !!urlError || !!ipError;

  return (
    <div>
      <h1>{t('app.title')}</h1>

      <div class="card">
        <h2>Server Configuration</h2>
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
            placeholder="https://your-server.com"
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
            {testingConnection ? 'Testing...' : t('actions.testConnection')}
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
              <label htmlFor="speakerIp">Speaker IP Address (optional)</label>
              <input
                id="speakerIp"
                type="text"
                value={speakerIp}
                onInput={(e) => {
                  setSpeakerIp((e.target as HTMLInputElement).value);
                  setIpError(null);
                }}
                onBlur={validateIp}
                placeholder="e.g., 192.168.1.50"
                class={ipError ? 'input-error' : ''}
              />
              {ipError && <p class="field-error">{ipError}</p>}
              <p class="hint">
                Enter the IP address of any Sonos speaker on your network. This bypasses
                auto-discovery (useful for WSL2 or VPN setups). Find it in the Sonos app under
                Settings → About My System.
              </p>
            </div>
            {!speakerIp && (
              <div class="form-group">
                <button class="btn btn-secondary" onClick={handleDiscover} disabled={discovering}>
                  {discovering ? 'Scanning network...' : 'Scan for Speakers'}
                </button>
                {speakerCount !== null && (
                  <p class="success-message">
                    Found {speakerCount} speaker{speakerCount !== 1 ? 's' : ''} on network
                  </p>
                )}
                {discoveryError && <p class="error-message">{discoveryError}</p>}
                <p class="hint" style={{ marginTop: '8px' }}>
                  Scans the local network using SSDP. May not work in WSL2 or VPN setups.
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

      <button class="btn btn-primary" onClick={handleSave} disabled={hasValidationErrors}>
        {t('actions.saveSettings')}
      </button>
      {saved && <p class="success-message">Settings saved!</p>}
      {hasValidationErrors && (
        <p class="error-message">Please fix the errors above before saving.</p>
      )}
    </div>
  );
}
