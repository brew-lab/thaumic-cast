import { useState, useEffect } from 'preact/hooks';

export function Options() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3000');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.sync.get('serverUrl', (result: { serverUrl?: string }) => {
      if (result.serverUrl) {
        setServerUrl(result.serverUrl);
      }
    });
  }, []);

  const handleSave = async () => {
    // Normalize URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    await chrome.storage.sync.set({ serverUrl: normalizedUrl });
    setServerUrl(normalizedUrl);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
            The URL of your Thaumic Cast server. Include the protocol (http:// or https://).
          </p>
        </div>
        <button class="btn btn-primary" onClick={handleSave}>
          Save
        </button>
        {saved && <p class="success-message">Settings saved!</p>}
      </div>
    </div>
  );
}
