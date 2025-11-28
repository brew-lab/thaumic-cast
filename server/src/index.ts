import { auth } from './auth';
import { db } from './db';
import { StreamManager } from './stream-manager';
import { handleApiRoutes } from './routes/api';
import { handleSonosRoutes } from './routes/sonos';

const PORT = Number(Bun.env.PORT) || 3000;
const HOST = Bun.env.HOST || '0.0.0.0';

// Ensure database is initialized
db.exec('SELECT 1');

interface WebSocketData {
  streamId: string;
}

export const server = Bun.serve<WebSocketData>({
  port: PORT,
  hostname: HOST,

  async fetch(req, server) {
    const url = new URL(req.url);

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

    // Better Auth routes
    if (url.pathname.startsWith('/api/auth')) {
      return auth.handler(req);
    }

    // Sonos routes
    if (url.pathname.startsWith('/api/sonos')) {
      return handleSonosRoutes(req, url);
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

console.log(`Server running on http://${HOST}:${PORT}`);
