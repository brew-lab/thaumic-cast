import { auth } from '../auth';
import { db } from '../db';
import { signIngestToken } from '../jwt';
import { SonosClient } from '../lib/sonos-client';
import { StreamManager } from '../stream-manager';
import type {
  MeResponse,
  CreateStreamRequest,
  CreateStreamResponse,
  QualityPreset,
} from '@thaumic-cast/shared';

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

export async function handleApiRoutes(req: Request, url: URL): Promise<Response> {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // GET /api/me
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const session = await auth.api.getSession({ headers: req.headers });

    const response: MeResponse = {
      user: session?.user
        ? {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name || undefined,
          }
        : null,
      sonosLinked: false,
    };

    if (session?.user) {
      const sonosClient = new SonosClient(session.user.id);
      response.sonosLinked = sonosClient.isLinked;
    }

    return jsonResponse(response, 200, cors);
  }

  // POST /api/streams
  if (url.pathname === '/api/streams' && req.method === 'POST') {
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

    let body: CreateStreamRequest;
    try {
      body = (await req.json()) as CreateStreamRequest;
    } catch {
      return jsonResponse({ error: 'invalid_json', message: 'Invalid request body' }, 400, cors);
    }

    const { groupId, quality } = body;
    if (!groupId || !quality) {
      return jsonResponse(
        { error: 'missing_fields', message: 'groupId and quality required' },
        400,
        cors
      );
    }

    const validQualities: QualityPreset[] = ['low', 'medium', 'high'];
    if (!validQualities.includes(quality)) {
      return jsonResponse(
        { error: 'invalid_quality', message: 'Invalid quality preset' },
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

    // Generate stream ID
    const streamId = crypto.randomUUID();

    // Create database record
    db.query(
      'INSERT INTO streams (id, user_id, household_id, group_id, quality, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(streamId, session.user.id, sonosAccount.household_id, groupId, quality, 'starting');

    // Initialize stream in manager
    StreamManager.getOrCreate(streamId);

    // Generate ingest token
    const ingestToken = await signIngestToken(session.user.id, streamId);

    // Build URLs
    const playbackUrl = `${PUBLIC_URL}/streams/${streamId}/live.mp3`;
    const wsProtocol = PUBLIC_URL.startsWith('https') ? 'wss' : 'ws';
    const wsHost = PUBLIC_URL.replace(/^https?:\/\//, '');
    const ingestUrl = `${wsProtocol}://${wsHost}/ws/ingest?streamId=${streamId}&token=${ingestToken}`;

    // Create Sonos playback session and load stream URL
    const sessionIdResult = await sonosClient.createPlaybackSession(groupId);
    if (sessionIdResult) {
      await sonosClient.loadStreamUrl(sessionIdResult, playbackUrl, true);
    }

    // Update status to active
    db.query('UPDATE streams SET status = ?, updated_at = unixepoch() WHERE id = ?').run(
      'active',
      streamId
    );

    const response: CreateStreamResponse = {
      streamId,
      ingestUrl,
      playbackUrl,
    };

    return jsonResponse(response, 201, cors);
  }

  // POST /api/streams/:id/stop
  const stopMatch = url.pathname.match(/^\/api\/streams\/([^/]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const streamId = stopMatch[1];
    if (!streamId) {
      return jsonResponse({ error: 'invalid_stream_id', message: 'Invalid stream ID' }, 400, cors);
    }

    // Verify ownership
    const stream = db
      .query<{ user_id: string }, [string]>('SELECT user_id FROM streams WHERE id = ?')
      .get(streamId);

    if (!stream) {
      return jsonResponse({ error: 'not_found', message: 'Stream not found' }, 404, cors);
    }

    if (stream.user_id !== session.user.id) {
      return jsonResponse({ error: 'forbidden', message: 'Not your stream' }, 403, cors);
    }

    // Update status
    db.query('UPDATE streams SET status = ?, updated_at = unixepoch() WHERE id = ?').run(
      'stopped',
      streamId
    );

    // Remove from manager
    StreamManager.remove(streamId);

    return jsonResponse({ success: true }, 200, cors);
  }

  // DEV ONLY: POST /api/test/stream - Create test stream without Sonos
  if (url.pathname === '/api/test/stream' && req.method === 'POST') {
    if (Bun.env.NODE_ENV === 'production') {
      return jsonResponse({ error: 'not_found', message: 'Endpoint not found' }, 404, cors);
    }

    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const streamId = crypto.randomUUID();

    // Initialize stream in manager (no DB, no Sonos)
    StreamManager.getOrCreate(streamId);

    // Generate ingest token
    const ingestToken = await signIngestToken(session.user.id, streamId);

    // Build URLs
    const playbackUrl = `${PUBLIC_URL}/streams/${streamId}/live.mp3`;
    const wsProtocol = PUBLIC_URL.startsWith('https') ? 'wss' : 'ws';
    const wsHost = PUBLIC_URL.replace(/^https?:\/\//, '');
    const ingestUrl = `${wsProtocol}://${wsHost}/ws/ingest?streamId=${streamId}&token=${ingestToken}`;

    return jsonResponse({ streamId, ingestUrl, playbackUrl }, 201, cors);
  }

  return jsonResponse({ error: 'not_found', message: 'Endpoint not found' }, 404, cors);
}
