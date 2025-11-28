import { SignJWT, jwtVerify } from 'jose';

const STREAM_JWT_SECRET = Bun.env.STREAM_JWT_SECRET;

if (!STREAM_JWT_SECRET) {
  console.warn('[JWT] STREAM_JWT_SECRET not set, using insecure default for development');
}

const secret = new TextEncoder().encode(STREAM_JWT_SECRET || 'dev-secret-change-in-production');

export async function signIngestToken(userId: string, streamId: string): Promise<string> {
  return new SignJWT({ streamId })
    .setSubject(userId)
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(secret);
}

export async function verifyIngestToken(
  token: string
): Promise<{ userId: string; streamId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      userId: payload.sub as string,
      streamId: payload.streamId as string,
    };
  } catch {
    return null;
  }
}
