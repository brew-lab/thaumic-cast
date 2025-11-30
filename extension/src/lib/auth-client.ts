import { createAuthClient } from 'better-auth/client';
import { getServerUrl } from './settings';

type AuthClient = ReturnType<typeof createAuthClient>;

let cachedBaseUrl: string | null = null;
let cachedClient: AuthClient | null = null;
const SESSION_RETRY_DELAY_MS = 300;
const SESSION_ATTEMPTS = 2;

async function getAuthClient(): Promise<AuthClient> {
  const baseURL = await getServerUrl();

  if (!cachedClient || cachedBaseUrl !== baseURL) {
    cachedBaseUrl = baseURL;
    cachedClient = createAuthClient({ baseURL });
  }

  return cachedClient;
}

export async function getSession() {
  const client = await getAuthClient();

  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
    const result = await client.getSession();
    if (!result.error) return result;

    if (attempt < SESSION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
    } else {
      return result;
    }
  }

  // Fallback (should never reach here)
  return client.getSession();
}

// Wrapped with loose typing because better-auth exposes nested signIn variants
export async function signIn(...args: any[]) {
  const client = await getAuthClient();
  const fn = (client as any).signIn as (...fnArgs: any[]) => unknown;
  return fn(...args);
}

export async function signOut(...args: any[]) {
  const client = await getAuthClient();
  const fn = (client as any).signOut as (...fnArgs: any[]) => unknown;
  return fn(...args);
}
