import { auth } from '../auth';
import { db } from '../db';
import { signIngestToken } from '../jwt';
import { SonosClient } from '../lib/sonos-client';
import { getLocalIp } from '../lib/sonos-local-client';
import { GenaListener } from '../lib/gena-listener';
import { StreamManager } from '../stream-manager';
import type {
  AudioCodec,
  MeResponse,
  CreateStreamRequest,
  CreateStreamResponse,
  QualityPreset,
  SonosMode,
  StreamMetadata,
} from '@thaumic-cast/shared';

const PUBLIC_URL = Bun.env.PUBLIC_URL || 'http://localhost:3000';
const PORT = Number(Bun.env.PORT) || 3000;

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

    let body: CreateStreamRequest & {
      mode?: SonosMode;
      coordinatorIp?: string;
      codec?: AudioCodec;
    };
    try {
      body = (await req.json()) as CreateStreamRequest & {
        mode?: SonosMode;
        coordinatorIp?: string;
        codec?: AudioCodec;
      };
    } catch {
      return jsonResponse({ error: 'invalid_json', message: 'Invalid request body' }, 400, cors);
    }

    const { groupId, quality, mode, codec } = body;
    const isLocalMode = mode === 'local';

    if (!groupId || !quality) {
      return jsonResponse(
        { error: 'missing_fields', message: 'groupId and quality required' },
        400,
        cors
      );
    }

    const validQualities: QualityPreset[] = ['ultra-low', 'low', 'medium', 'high'];
    if (!validQualities.includes(quality)) {
      return jsonResponse(
        { error: 'invalid_quality', message: 'Invalid quality preset' },
        400,
        cors
      );
    }

    // Determine file extension based on codec
    const streamFormat = codec === 'he-aac' || codec === 'aac-lc' ? 'aac' : 'mp3';

    // For cloud mode, verify Sonos is linked
    let householdId = 'local';
    if (!isLocalMode) {
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
      householdId = sonosAccount.household_id;
    }

    // Generate stream ID
    const streamId = crypto.randomUUID();

    // Create database record
    db.query(
      'INSERT INTO streams (id, user_id, household_id, group_id, quality, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(streamId, session.user.id, householdId, groupId, quality, 'starting');

    // Initialize stream in manager
    const stream = StreamManager.getOrCreate(streamId);

    // For local mode, store the coordinator IP and subscribe to GENA events
    let genaWarning: string | undefined;
    if (isLocalMode && body.coordinatorIp) {
      stream.setSpeakerIp(body.coordinatorIp);

      // Subscribe to GENA events for this speaker
      // We await these to ensure subscriptions are established before responding
      const subscriptionResults = await Promise.allSettled([
        GenaListener.subscribe(body.coordinatorIp, 'AVTransport'),
        GenaListener.subscribe(body.coordinatorIp, 'RenderingControl'),
        GenaListener.subscribe(body.coordinatorIp, 'GroupRenderingControl'),
      ]);

      const failedSubscriptions = subscriptionResults
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);

      if (failedSubscriptions.length > 0) {
        console.warn('[Streams] Some GENA subscriptions failed:', failedSubscriptions);
        genaWarning = 'Real-time speaker feedback may be unavailable';
      }
    }

    // Generate ingest token
    const ingestToken = await signIngestToken(session.user.id, streamId);

    // Build URLs - for local mode, use server's LAN IP
    let playbackUrl: string;
    let ingestUrl: string;

    if (isLocalMode) {
      // LOCAL_SERVER_IP env var takes precedence (needed for WSL2 where getLocalIp returns internal IP)
      const localIp = Bun.env.LOCAL_SERVER_IP || getLocalIp() || 'localhost';
      playbackUrl = `http://${localIp}:${PORT}/streams/${streamId}/live.${streamFormat}`;
      ingestUrl = `ws://${localIp}:${PORT}/ws/ingest?streamId=${streamId}&token=${ingestToken}`;
      console.log('[Streams] Local mode - playbackUrl:', playbackUrl, 'codec:', codec);
    } else {
      playbackUrl = `${PUBLIC_URL}/streams/${streamId}/live.${streamFormat}`;
      const wsProtocol = PUBLIC_URL.startsWith('https') ? 'wss' : 'ws';
      const wsHost = PUBLIC_URL.replace(/^https?:\/\//, '');
      ingestUrl = `${wsProtocol}://${wsHost}/ws/ingest?streamId=${streamId}&token=${ingestToken}`;
    }

    // For cloud mode, create Sonos playback session and load stream URL
    if (!isLocalMode) {
      const sonosClient = new SonosClient(session.user.id);
      console.log('[Streams] Creating Sonos playback session for group:', groupId);
      const sessionIdResult = await sonosClient.createPlaybackSession(groupId);
      console.log('[Streams] Sonos session result:', sessionIdResult);
      if (sessionIdResult) {
        const loadResult = await sonosClient.loadStreamUrl(sessionIdResult, playbackUrl, true);
        console.log('[Streams] Sonos loadStreamUrl result:', loadResult);
      } else {
        console.log('[Streams] Failed to create Sonos playback session');
      }
    }
    // For local mode, the extension will call /api/local/play after receiving this response

    // Update status to active
    db.query('UPDATE streams SET status = ?, updated_at = unixepoch() WHERE id = ?').run(
      'active',
      streamId
    );

    const response: CreateStreamResponse = {
      streamId,
      ingestUrl,
      playbackUrl,
      ...(genaWarning && { warning: genaWarning }),
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

    // Get stream from manager before removing (to get speaker IP for GENA cleanup)
    const managedStream = StreamManager.get(streamId);
    const speakerIp = managedStream?.speakerIp;

    // Unsubscribe from GENA for this speaker
    if (speakerIp) {
      GenaListener.unsubscribeAll(speakerIp).catch((err) => {
        console.error('[Streams] Failed to unsubscribe from GENA:', err);
      });
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

  // POST /api/streams/:id/metadata - Update stream metadata (for ICY injection)
  const metadataMatch = url.pathname.match(/^\/api\/streams\/([^/]+)\/metadata$/);
  if (metadataMatch && req.method === 'POST') {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
    }

    const streamId = metadataMatch[1];
    if (!streamId) {
      return jsonResponse({ error: 'invalid_stream_id', message: 'Invalid stream ID' }, 400, cors);
    }

    // Get the stream from manager
    const stream = StreamManager.get(streamId);
    if (!stream) {
      return jsonResponse({ error: 'not_found', message: 'Stream not found' }, 404, cors);
    }

    // Parse request body
    let body: StreamMetadata;
    try {
      body = (await req.json()) as StreamMetadata;
    } catch {
      return jsonResponse({ error: 'invalid_json', message: 'Invalid request body' }, 400, cors);
    }

    // Update metadata
    stream.setMetadata(body);
    console.log(`[Streams] Updated metadata for stream ${streamId}:`, body.title);

    return jsonResponse({ success: true }, 200, cors);
  }

  // DEV ONLY: GET /api/debug/gena - Check GENA listener status
  if (url.pathname === '/api/debug/gena' && req.method === 'GET') {
    const diagnostics = GenaListener.getDiagnostics();
    return jsonResponse(diagnostics, 200, cors);
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
