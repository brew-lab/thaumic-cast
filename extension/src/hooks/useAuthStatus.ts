import { useState, useEffect } from 'preact/hooks';
import { getSession, signOut } from '../lib/auth-client';

interface AuthStatus {
  isLoggedIn: boolean;
  userEmail: string | null;
  loading: boolean;
  signingOut: boolean;
  handleSignOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAuthStatus(): AuthStatus {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  const checkSession = async () => {
    setLoading(true);
    try {
      const { data: session } = await getSession();
      if (session?.user) {
        setIsLoggedIn(true);
        setUserEmail(session.user.email || null);
      } else {
        setIsLoggedIn(false);
        setUserEmail(null);
      }
    } catch {
      setIsLoggedIn(false);
      setUserEmail(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkSession();
  }, []);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      setIsLoggedIn(false);
      setUserEmail(null);
    } catch (err) {
      console.error('Failed to sign out:', err);
    } finally {
      setSigningOut(false);
    }
  };

  return {
    isLoggedIn,
    userEmail,
    loading,
    signingOut,
    handleSignOut,
    refresh: checkSession,
  };
}
