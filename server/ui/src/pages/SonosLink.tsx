import { useState, useEffect } from 'preact/hooks';
import type { MeResponse } from '@thaumic-cast/shared';

interface SonosLinkProps {
  onNavigate: (path: string) => void;
}

export function SonosLink({ onNavigate }: SonosLinkProps) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<MeResponse['user']>(null);
  const [sonosLinked, setSonosLinked] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    // Check URL params for OAuth callback result
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      setSuccess('Sonos connected successfully!');
      window.history.replaceState({}, '', '/sonos/link');
    } else if (params.get('error')) {
      setError(`Connection failed: ${params.get('error')}`);
      window.history.replaceState({}, '', '/sonos/link');
    }

    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      const response = await fetch('/api/me', { credentials: 'include' });
      const data: MeResponse = await response.json();

      if (!data.user) {
        onNavigate('/login');
        return;
      }

      setUser(data.user);
      setSonosLinked(data.sonosLinked);
    } catch {
      setError('Failed to check status');
    } finally {
      setLoading(false);
    }
  };

  const handleConnectSonos = () => {
    window.location.href = '/api/sonos/login';
  };

  if (loading) {
    return (
      <div class="card">
        <div class="status-card">
          <p class="status-text">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div class="card">
      <h1>Connect Sonos</h1>
      <div class="status-card">
        {sonosLinked ? (
          <>
            <div class="status-icon" aria-hidden="true">
              ✓
            </div>
            <p class="status-text">Sonos is connected!</p>
            <p class="link-text">
              You can now use the browser extension to cast audio to your Sonos speakers.
            </p>
          </>
        ) : (
          <>
            <div class="status-icon" aria-hidden="true">
              🔊
            </div>
            <p class="status-text">Connect your Sonos account to start casting.</p>
            <button type="button" class="btn btn-primary" onClick={handleConnectSonos}>
              Connect Sonos
            </button>
          </>
        )}
        {error && (
          <p class="error-message" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p class="success-message" role="status">
            {success}
          </p>
        )}
      </div>
      <p class="link-text">
        Signed in as {user?.email}.{' '}
        <button
          type="button"
          onClick={async () => {
            await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
            onNavigate('/login');
          }}
        >
          Sign out
        </button>
      </p>
    </div>
  );
}
