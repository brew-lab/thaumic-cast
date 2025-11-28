import { betterAuth } from 'better-auth';
import { Database } from 'bun:sqlite';

const DATABASE_PATH = Bun.env.DATABASE_PATH || './data/thaumic.db';

// Create a separate database instance for Better Auth
const authDb = new Database(DATABASE_PATH, { create: true });

export const auth = betterAuth({
  database: authDb,
  secret: Bun.env.AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
  trustedOrigins: [
    // Chrome extension origins - accept any extension origin
    'chrome-extension://*',
    // Additional origins from env
    ...(Bun.env.TRUSTED_ORIGINS?.split(',').filter(Boolean) || []),
  ],
});

export type Session = typeof auth.$Infer.Session;
