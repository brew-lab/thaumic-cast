import { createAuthClient } from 'better-auth/client';
import { getServerUrl } from './settings';

type AuthClient = ReturnType<typeof createAuthClient>;

let cachedBaseUrl: string | null = null;
let cachedClient: AuthClient | null = null;

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
  return client.getSession();
}
