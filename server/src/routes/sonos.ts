import { auth } from '../auth';
import { db } from '../db';
import { SonosClient } from '../lib/sonos-client';
import type { SonosGroupsResponse, SonosStatusResponse } from '@thaumic-cast/shared';

const SONOS_AUTH_BASE = 'https://api.sonos.com/login/v3/oauth';
const PUBLIC_URL = Bun.env.PUBLIC_URL || 'http://localhost:3000';

function corsHeaders(origin?: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse<T>(data: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

// Store CSRF state tokens temporarily (in production, use session or Redis)
const stateTokens = new Map<string, { userId: string; expiresAt: number }>();

export async function handleSonosRoutes(req: Request, url: URL): Promise<Response> {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // GET /api/sonos/status
  if (url.pathname === '/api/sonos/status' && req.method === 'GET') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const sonosClient = new SonosClient(session.user.id);
    const sonosAccount = db
      .query<
        { household_id: string },
        [string]
      >('SELECT household_id FROM sonos_accounts WHERE user_id = ?')
      .get(session.user.id);

    const response: SonosStatusResponse = {
      linked: sonosClient.isLinked,
      householdId: sonosAccount?.household_id,
    };

    return jsonResponse(response, 200, cors);
  }

  // GET /api/sonos/login - Initiate Sonos OAuth
  if (url.pathname === '/api/sonos/login' && req.method === 'GET') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return new Response('Unauthorized', { status: 401 });
    }

    const clientId = Bun.env.SONOS_CLIENT_ID;
    if (!clientId) {
      return new Response('Sonos not configured', { status: 500 });
    }

    // Generate state token
    const state = crypto.randomUUID();
    stateTokens.set(state, {
      userId: session.user.id,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Clean up old state tokens
    const now = Date.now();
    for (const [key, value] of stateTokens) {
      if (value.expiresAt < now) {
        stateTokens.delete(key);
      }
    }

    const redirectUri = `${PUBLIC_URL}/api/sonos/callback`;
    const authUrl = new URL(`${SONOS_AUTH_BASE}/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'playback-control-all');
    authUrl.searchParams.set('redirect_uri', redirectUri);

    return Response.redirect(authUrl.toString(), 302);
  }

  // GET /api/sonos/callback - Handle Sonos OAuth callback
  if (url.pathname === '/api/sonos/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return Response.redirect(`${PUBLIC_URL}/sonos/link?error=${error}`, 302);
    }

    if (!code || !state) {
      return Response.redirect(`${PUBLIC_URL}/sonos/link?error=missing_params`, 302);
    }

    // Validate state
    const stateData = stateTokens.get(state);
    if (!stateData || stateData.expiresAt < Date.now()) {
      stateTokens.delete(state);
      return Response.redirect(`${PUBLIC_URL}/sonos/link?error=invalid_state`, 302);
    }

    stateTokens.delete(state);
    const userId = stateData.userId;

    const clientId = Bun.env.SONOS_CLIENT_ID;
    const clientSecret = Bun.env.SONOS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return Response.redirect(`${PUBLIC_URL}/sonos/link?error=config_error`, 302);
    }

    // Exchange code for tokens
    try {
      const redirectUri = `${PUBLIC_URL}/api/sonos/callback`;
      const tokenResponse = await fetch(`${SONOS_AUTH_BASE}/access`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('[Sonos] Token exchange failed:', errorText);
        return Response.redirect(`${PUBLIC_URL}/sonos/link?error=token_exchange_failed`, 302);
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

      // Fetch households to get household ID
      const householdsResponse = await fetch('https://api.ws.sonos.com/control/api/v1/households', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      let householdId: string | null = null;
      if (householdsResponse.ok) {
        const householdsData = (await householdsResponse.json()) as {
          households: { id: string }[];
        };
        householdId = householdsData.households[0]?.id ?? null;
      }

      // Store tokens (upsert)
      const existingAccount = db
        .query<{ id: string }, [string]>('SELECT id FROM sonos_accounts WHERE user_id = ?')
        .get(userId);

      if (existingAccount) {
        db.query(
          'UPDATE sonos_accounts SET household_id = ?, access_token = ?, refresh_token = ?, expires_at = ?, updated_at = unixepoch() WHERE user_id = ?'
        ).run(householdId, tokens.access_token, tokens.refresh_token, expiresAt, userId);
      } else {
        const id = crypto.randomUUID();
        db.query(
          'INSERT INTO sonos_accounts (id, user_id, household_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, userId, householdId, tokens.access_token, tokens.refresh_token, expiresAt);
      }

      return Response.redirect(`${PUBLIC_URL}/sonos/link?success=true`, 302);
    } catch (error) {
      console.error('[Sonos] OAuth error:', error);
      return Response.redirect(`${PUBLIC_URL}/sonos/link?error=unknown`, 302);
    }
  }

  // GET /api/sonos/groups
  if (url.pathname === '/api/sonos/groups' && req.method === 'GET') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const sonosClient = new SonosClient(session.user.id);
    if (!sonosClient.isLinked) {
      return jsonResponse(
        { error: 'sonos_not_linked', message: 'Sonos account not linked' },
        400,
        cors
      );
    }

    // Get household ID
    const sonosAccount = db
      .query<
        { household_id: string },
        [string]
      >('SELECT household_id FROM sonos_accounts WHERE user_id = ?')
      .get(session.user.id);

    if (!sonosAccount?.household_id) {
      return jsonResponse(
        { error: 'no_household', message: 'No Sonos household found' },
        400,
        cors
      );
    }

    const groups = await sonosClient.getGroups(sonosAccount.household_id);
    if (!groups) {
      return jsonResponse({ error: 'sonos_error', message: 'Failed to fetch groups' }, 500, cors);
    }

    const response: SonosGroupsResponse = {
      householdId: sonosAccount.household_id,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
      })),
    };

    return jsonResponse(response, 200, cors);
  }

  // GET /api/sonos/groups/:groupId/volume - Get group volume
  const getVolumeMatch = url.pathname.match(/^\/api\/sonos\/groups\/([^/]+)\/volume$/);
  if (getVolumeMatch && req.method === 'GET') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const groupId = getVolumeMatch[1];
    if (!groupId) {
      return jsonResponse({ error: 'invalid_group_id', message: 'Invalid group ID' }, 400, cors);
    }

    const sonosClient = new SonosClient(session.user.id);
    if (!sonosClient.isLinked) {
      return jsonResponse(
        { error: 'sonos_not_linked', message: 'Sonos account not linked' },
        400,
        cors
      );
    }

    const volume = await sonosClient.getGroupVolume(groupId);
    if (volume === null) {
      return jsonResponse({ error: 'volume_error', message: 'Failed to get volume' }, 500, cors);
    }

    return jsonResponse({ volume }, 200, cors);
  }

  // POST /api/sonos/groups/:groupId/volume - Set group volume
  if (getVolumeMatch && req.method === 'POST') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const groupId = getVolumeMatch[1];
    if (!groupId) {
      return jsonResponse({ error: 'invalid_group_id', message: 'Invalid group ID' }, 400, cors);
    }

    let body: { volume?: number };
    try {
      body = (await req.json()) as { volume?: number };
    } catch {
      return jsonResponse({ error: 'invalid_json', message: 'Invalid request body' }, 400, cors);
    }

    if (typeof body.volume !== 'number') {
      return jsonResponse(
        { error: 'missing_volume', message: 'volume (number) required' },
        400,
        cors
      );
    }

    const sonosClient = new SonosClient(session.user.id);
    if (!sonosClient.isLinked) {
      return jsonResponse(
        { error: 'sonos_not_linked', message: 'Sonos account not linked' },
        400,
        cors
      );
    }

    const success = await sonosClient.setGroupVolume(groupId, body.volume);
    if (!success) {
      return jsonResponse({ error: 'volume_error', message: 'Failed to set volume' }, 500, cors);
    }

    return jsonResponse({ success: true }, 200, cors);
  }

  return jsonResponse({ error: 'not_found', message: 'Endpoint not found' }, 404, cors);
}
