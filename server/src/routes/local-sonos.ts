/**
 * Local Sonos routes - UPnP/SOAP control endpoints
 */

import { auth } from '../auth';
import * as sonosLocal from '../lib/sonos-local-client';

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

export async function handleLocalSonosRoutes(req: Request, url: URL): Promise<Response | null> {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // All local routes require authentication
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return jsonResponse({ error: 'unauthorized', message: 'Not authenticated' }, 401, cors);
  }

  // GET /api/local/discover - Discover Sonos speakers on LAN
  if (url.pathname === '/api/local/discover' && req.method === 'GET') {
    try {
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      const speakers = await sonosLocal.discover(forceRefresh);

      return jsonResponse(
        {
          speakers: speakers.map((s) => ({
            uuid: s.uuid,
            ip: s.ip,
          })),
        },
        200,
        cors
      );
    } catch (error) {
      console.error('[LocalSonos] Discovery error:', error);
      return jsonResponse(
        {
          error: 'discovery_failed',
          message: error instanceof Error ? error.message : 'Discovery failed',
        },
        500,
        cors
      );
    }
  }

  // GET /api/local/groups - Get zone groups from discovered speakers
  if (url.pathname === '/api/local/groups' && req.method === 'GET') {
    try {
      const speakerIp = url.searchParams.get('ip') || undefined;
      const groups = await sonosLocal.getZoneGroups(speakerIp);

      return jsonResponse({ groups }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Get groups error:', error);
      return jsonResponse(
        {
          error: 'groups_failed',
          message: error instanceof Error ? error.message : 'Failed to get groups',
        },
        500,
        cors
      );
    }
  }

  // POST /api/local/play - Load stream URL and play
  if (url.pathname === '/api/local/play' && req.method === 'POST') {
    try {
      const body = (await req.json()) as { coordinatorIp?: string; streamUrl?: string };

      if (!body.coordinatorIp || !body.streamUrl) {
        return jsonResponse(
          {
            error: 'invalid_request',
            message: 'coordinatorIp and streamUrl are required',
          },
          400,
          cors
        );
      }

      await sonosLocal.playStream(body.coordinatorIp, body.streamUrl);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Play error:', error);
      return jsonResponse(
        {
          error: 'play_failed',
          message: error instanceof Error ? error.message : 'Failed to play stream',
        },
        500,
        cors
      );
    }
  }

  // POST /api/local/stop - Stop playback
  if (url.pathname === '/api/local/stop' && req.method === 'POST') {
    try {
      const body = (await req.json()) as { coordinatorIp?: string };

      if (!body.coordinatorIp) {
        return jsonResponse(
          {
            error: 'invalid_request',
            message: 'coordinatorIp is required',
          },
          400,
          cors
        );
      }

      await sonosLocal.stop(body.coordinatorIp);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Stop error:', error);
      return jsonResponse(
        {
          error: 'stop_failed',
          message: error instanceof Error ? error.message : 'Failed to stop playback',
        },
        500,
        cors
      );
    }
  }

  // GET /api/local/volume/:ip - Get volume
  const getVolumeMatch = url.pathname.match(/^\/api\/local\/volume\/(.+)$/);
  if (getVolumeMatch && getVolumeMatch[1] && req.method === 'GET') {
    try {
      const speakerIp = decodeURIComponent(getVolumeMatch[1]);
      const volume = await sonosLocal.getVolume(speakerIp);

      return jsonResponse({ volume }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Get volume error:', error);
      return jsonResponse(
        {
          error: 'volume_failed',
          message: error instanceof Error ? error.message : 'Failed to get volume',
        },
        500,
        cors
      );
    }
  }

  // POST /api/local/volume/:ip - Set volume
  if (getVolumeMatch && getVolumeMatch[1] && req.method === 'POST') {
    try {
      const speakerIp = decodeURIComponent(getVolumeMatch[1]);
      const body = (await req.json()) as { volume?: number };

      if (typeof body.volume !== 'number') {
        return jsonResponse(
          {
            error: 'invalid_request',
            message: 'volume (number) is required',
          },
          400,
          cors
        );
      }

      await sonosLocal.setVolume(speakerIp, body.volume);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Set volume error:', error);
      return jsonResponse(
        {
          error: 'volume_failed',
          message: error instanceof Error ? error.message : 'Failed to set volume',
        },
        500,
        cors
      );
    }
  }

  // GET /api/local/server-ip - Get server's local IP address
  if (url.pathname === '/api/local/server-ip' && req.method === 'GET') {
    const localIp = sonosLocal.getLocalIp();

    if (!localIp) {
      return jsonResponse(
        {
          error: 'no_local_ip',
          message: 'Could not determine server local IP address',
        },
        500,
        cors
      );
    }

    return jsonResponse({ ip: localIp }, 200, cors);
  }

  // Not found for this route handler
  return null;
}
