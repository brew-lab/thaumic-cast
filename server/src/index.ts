import { auth } from './auth';
import { db } from './db';
import { StreamManager } from './stream-manager';
import { handleApiRoutes } from './routes/api';
import { handleSonosRoutes } from './routes/sonos';
import { handleLocalSonosRoutes } from './routes/local-sonos';

const PORT = Number(Bun.env.PORT) || 3000;
const HOST = Bun.env.HOST || '0.0.0.0';
const USE_TLS = Bun.env.USE_TLS !== 'false'; // Disable TLS with USE_TLS=false

// Ensure database is initialized
db.exec('SELECT 1');

interface WebSocketData {
  streamId: string;
}

// TLS config only if enabled and certs exist
const tlsConfig = USE_TLS
  ? {
      cert: Bun.file('./certs/cert.pem'),
      key: Bun.file('./certs/key.pem'),
    }
  : undefined;

export const server = Bun.serve<WebSocketData>({
  port: PORT,
  hostname: HOST,
  ...(tlsConfig && { tls: tlsConfig }),

  async fetch(req, server) {
    const url = new URL(req.url);
    console.log(`[HTTP] ${req.method} ${url.pathname}`);

    // WebSocket upgrade for ingest
    if (url.pathname === '/ws/ingest') {
      const streamId = url.searchParams.get('streamId');
      const token = url.searchParams.get('token');

      if (!streamId || !token) {
        return new Response('Missing streamId or token', { status: 400 });
      }

      const isValid = await StreamManager.validateToken(streamId, token);
      if (!isValid) {
        return new Response('Unauthorized', { status: 401 });
      }

      const upgraded = server.upgrade(req, { data: { streamId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // HTTP live stream endpoint
    const streamMatch = url.pathname.match(/^\/streams\/([^/]+)\/live\.mp3$/);
    if (streamMatch && req.method === 'GET') {
      const streamId = streamMatch[1];
      if (!streamId) {
        return new Response('Invalid stream ID', { status: 400 });
      }

      const stream = StreamManager.get(streamId);
      if (!stream) {
        return new Response('Stream not found', { status: 404 });
      }

      return new Response(stream.createReadableStream(), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store',
          'Transfer-Encoding': 'chunked',
        },
      });
    }

    // Health check endpoint (no auth required)
    if (url.pathname === '/api/health') {
      const origin = req.headers.get('Origin');
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }

    // Better Auth routes - add CORS for extension
    if (url.pathname.startsWith('/api/auth')) {
      const origin = req.headers.get('Origin');

      // Handle preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      const response = await auth.handler(req);

      // Add CORS headers to auth response
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Access-Control-Allow-Origin', origin || '*');
      newHeaders.set('Access-Control-Allow-Credentials', 'true');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // Sonos routes
    if (url.pathname.startsWith('/api/sonos')) {
      return handleSonosRoutes(req, url);
    }

    // Local Sonos routes (UPnP/SOAP)
    if (url.pathname.startsWith('/api/local')) {
      const response = await handleLocalSonosRoutes(req, url);
      if (response) return response;
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRoutes(req, url);
    }

    // Static files for UI
    if (
      url.pathname === '/' ||
      url.pathname === '/login' ||
      url.pathname === '/signup' ||
      url.pathname === '/sonos/link'
    ) {
      return new Response(Bun.file('./public/index.html'));
    }

    if (url.pathname.startsWith('/assets/')) {
      const file = Bun.file(`./public${url.pathname}`);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { streamId } = ws.data;
      StreamManager.getOrCreate(streamId).attachIngress(ws);
      console.log(`[WS] Ingress connected for stream ${streamId}`);
    },

    message(ws, data) {
      const { streamId } = ws.data;
      if (data instanceof Uint8Array) {
        StreamManager.get(streamId)?.pushFrame(data);
      }
    },

    close(ws) {
      const { streamId } = ws.data;
      StreamManager.get(streamId)?.detachIngress(ws);
      console.log(`[WS] Ingress disconnected for stream ${streamId}`);
    },
  },
});

const protocol = USE_TLS ? 'https' : 'http';
console.log(`Server running on ${protocol}://${HOST}:${PORT}`);
