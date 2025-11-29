/**
 * Local Sonos routes - UPnP/SOAP control endpoints
 */

import { auth } from '../auth';
import * as sonosLocal from '../lib/sonos-local-client';
import { isValidIPv4, ErrorCode } from '@thaumic-cast/shared';

function corsHeaders(origin?: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

interface ErrorResponseData {
  error: string;
  message: string;
  code?: ErrorCode;
  details?: Record<string, unknown>;
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

function errorResponse(data: ErrorResponseData, status = 500, headers: HeadersInit = {}): Response {
  return jsonResponse(data, status, headers);
}

/**
 * Parse error to provide user-friendly message
 */
function parseError(error: unknown): { message: string; code: ErrorCode } {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Network/connection errors
    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
      return {
        message:
          'Cannot connect to speaker. Verify the IP address and that the speaker is powered on.',
        code: ErrorCode.CONNECTION_REFUSED,
      };
    }
    if (msg.includes('etimedout') || msg.includes('timeout')) {
      return {
        message: 'Speaker did not respond. It may be unreachable or on a different network.',
        code: ErrorCode.NETWORK_TIMEOUT,
      };
    }
    if (msg.includes('enetunreach') || msg.includes('network is unreachable')) {
      return {
        message:
          'Network unreachable. Check that the server is on the same network as your speakers.',
        code: ErrorCode.NETWORK_UNREACHABLE,
      };
    }
    if (msg.includes('no sonos speakers found')) {
      return {
        message: 'No Sonos speakers found on the network. Try entering an IP address manually.',
        code: ErrorCode.SPEAKER_NOT_FOUND,
      };
    }

    // Return original message with generic code
    return { message: error.message, code: ErrorCode.UNKNOWN_ERROR };
  }

  return { message: 'An unknown error occurred', code: ErrorCode.UNKNOWN_ERROR };
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
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'discovery_failed',
          message,
          code,
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

      // Validate IP if provided
      if (speakerIp && !isValidIPv4(speakerIp)) {
        return errorResponse(
          {
            error: 'invalid_ip',
            message: `Invalid IP address format: ${speakerIp}`,
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      const groups = await sonosLocal.getZoneGroups(speakerIp);

      return jsonResponse({ groups }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Get groups error:', error);
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'groups_failed',
          message,
          code,
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
        return errorResponse(
          {
            error: 'invalid_request',
            message: 'coordinatorIp and streamUrl are required',
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      // Validate IP
      if (!isValidIPv4(body.coordinatorIp)) {
        return errorResponse(
          {
            error: 'invalid_ip',
            message: `Invalid coordinator IP address: ${body.coordinatorIp}`,
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      await sonosLocal.playStream(body.coordinatorIp, body.streamUrl);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Play error:', error);
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'play_failed',
          message,
          code,
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
        return errorResponse(
          {
            error: 'invalid_request',
            message: 'coordinatorIp is required',
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      if (!isValidIPv4(body.coordinatorIp)) {
        return errorResponse(
          {
            error: 'invalid_ip',
            message: `Invalid coordinator IP address: ${body.coordinatorIp}`,
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      await sonosLocal.stop(body.coordinatorIp);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Stop error:', error);
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'stop_failed',
          message,
          code,
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

      if (!isValidIPv4(speakerIp)) {
        return errorResponse(
          {
            error: 'invalid_ip',
            message: `Invalid speaker IP address: ${speakerIp}`,
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      const volume = await sonosLocal.getVolume(speakerIp);

      return jsonResponse({ volume }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Get volume error:', error);
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'volume_failed',
          message,
          code,
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

      if (!isValidIPv4(speakerIp)) {
        return errorResponse(
          {
            error: 'invalid_ip',
            message: `Invalid speaker IP address: ${speakerIp}`,
            code: ErrorCode.INVALID_IP_ADDRESS,
          },
          400,
          cors
        );
      }

      const body = (await req.json()) as { volume?: number };

      if (typeof body.volume !== 'number') {
        return errorResponse(
          {
            error: 'invalid_request',
            message: 'volume (number) is required',
            code: ErrorCode.UNKNOWN_ERROR,
          },
          400,
          cors
        );
      }

      await sonosLocal.setVolume(speakerIp, body.volume);

      return jsonResponse({ success: true }, 200, cors);
    } catch (error) {
      console.error('[LocalSonos] Set volume error:', error);
      const { message, code } = parseError(error);
      return errorResponse(
        {
          error: 'volume_failed',
          message,
          code,
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
