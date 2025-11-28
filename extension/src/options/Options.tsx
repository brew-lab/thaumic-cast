import { useState, useEffect } from 'preact/hooks';
import { discoverLocalSpeakers } from '../api/client';
import type { SonosMode } from '@thaumic-cast/shared';

export function Options() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [sonosMode, setSonosMode] = useState<SonosMode>('cloud');
  const [speakerIp, setSpeakerIp] = useState('');
  const [saved, setSaved] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.sync.get(
      ['serverUrl', 'sonosMode', 'speakerIp'],
      (result: { serverUrl?: string; sonosMode?: SonosMode; speakerIp?: string }) => {
        if (result.serverUrl) {
          setServerUrl(result.serverUrl);
        }
        if (result.sonosMode) {
          setSonosMode(result.sonosMode);
        }
        if (result.speakerIp) {
          setSpeakerIp(result.speakerIp);
        }
      }
    );
  }, []);

  const handleSave = async () => {
    // Normalize URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    // Trim speaker IP
    const trimmedIp = speakerIp.trim();
    await chrome.storage.sync.set({ serverUrl: normalizedUrl, sonosMode, speakerIp: trimmedIp });
    setServerUrl(normalizedUrl);
    setSpeakerIp(trimmedIp);
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

  return (
    <div>
      <h1>Thaumic Cast Settings</h1>

      <div class="card">
        <h2>Server Configuration</h2>
        <div class="form-group">
          <label htmlFor="serverUrl">Server URL</label>
          <input
            id="serverUrl"
            type="url"
            value={serverUrl}
            onInput={(e) => setServerUrl((e.target as HTMLInputElement).value)}
            placeholder="https://your-server.com"
          />
          <p class="hint">
            The URL of your Thaumic Cast server. For Local Mode, use the server's LAN IP (e.g.,
            http://192.168.1.100:3000). You must also log in via this URL.
          </p>
        </div>
      </div>

      <div class="card">
        <h2>Sonos Connection Mode</h2>
        <div class="form-group">
          <label>
            <input
              type="radio"
              name="sonosMode"
              value="cloud"
              checked={sonosMode === 'cloud'}
              onChange={() => setSonosMode('cloud')}
            />
            Cloud Mode
          </label>
          <p class="hint">
            Uses Sonos Cloud API. Requires OAuth login and a public server URL (via tunnel or
            domain).
          </p>
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
            Local Mode
          </label>
          <p class="hint">
            Uses UPnP/SOAP on local network. No public URL needed, but server and speakers must be
            on the same network.
          </p>
        </div>

        {sonosMode === 'local' && (
          <>
            <div class="form-group">
              <label htmlFor="speakerIp">Speaker IP Address</label>
              <input
                id="speakerIp"
                type="text"
                value={speakerIp}
                onInput={(e) => setSpeakerIp((e.target as HTMLInputElement).value)}
                placeholder="e.g., 192.168.1.50"
              />
              <p class="hint">
                Enter the IP address of any Sonos speaker on your network. This bypasses
                auto-discovery (useful for WSL2 or VPN setups). Find it in the Sonos app under
                Settings → About My System.
              </p>
            </div>
            {!speakerIp && (
              <div class="form-group">
                <button class="btn btn-secondary" onClick={handleDiscover} disabled={discovering}>
                  {discovering ? 'Scanning...' : 'Scan for Speakers'}
                </button>
                {speakerCount !== null && (
                  <p class="success-message">Found {speakerCount} speaker(s) on network</p>
                )}
                {discoveryError && <p class="error-message">{discoveryError}</p>}
              </div>
            )}
          </>
        )}
      </div>

      <button class="btn btn-primary" onClick={handleSave}>
        Save Settings
      </button>
      {saved && <p class="success-message">Settings saved!</p>}
    </div>
  );
}
