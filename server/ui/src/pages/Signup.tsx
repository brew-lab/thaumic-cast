import { useState } from 'preact/hooks';

interface SignupProps {
  onNavigate: (path: string) => void;
}

export function Signup({ onNavigate }: SignupProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Sign up failed');
      }

      onNavigate('/sonos/link');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="card">
      <h1>Create Account</h1>
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            required
            autocomplete="name"
          />
        </div>
        <div class="form-group">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            required
            autocomplete="email"
          />
        </div>
        <div class="form-group">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
            minLength={8}
            autocomplete="new-password"
          />
        </div>
        {error && (
          <p class="error-message" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="btn btn-primary" disabled={loading}>
          {loading ? 'Creating account...' : 'Create Account'}
        </button>
      </form>
      <p class="link-text">
        Already have an account?{' '}
        <button type="button" onClick={() => onNavigate('/login')}>
          Sign in
        </button>
      </p>
    </div>
  );
}
