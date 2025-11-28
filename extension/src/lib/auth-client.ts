import { createAuthClient } from 'better-auth/client';

// Create auth client with default URL
// Note: baseURL is set at creation time
export const authClient = createAuthClient({
  baseURL: 'http://localhost:3000',
});

// Export commonly used methods
export const { signIn, signUp, signOut, getSession } = authClient;
