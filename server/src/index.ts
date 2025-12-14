import { auth } from './auth';
import { db } from './db';
import { StreamManager, ICY_METAINT, formatIcyMetadata } from './stream-manager';
import { handleApiRoutes } from './routes/api';
import { handleSonosRoutes } from './routes/sonos';
import { handleLocalSonosRoutes } from './routes/local-sonos';
import { GenaListener } from './lib/gena-listener';

const PORT = Number(Bun.env.PORT) || 3000;
const HOST = Bun.env.HOST || '0.0.0.0';
const GENA_PORT = Number(Bun.env.GENA_PORT) || 3001;
const USE_TLS = Bun.env.USE_TLS !== 'false'; // Disable TLS with USE_TLS=false

// Ensure database is initialized
db.exec('SELECT 1');

// Start GENA listener for Sonos UPnP events
GenaListener.start(GENA_PORT)
  .then(() => {
    // Wire up GENA events to StreamManager
    GenaListener.onEvent((speakerIp, event) => {
      StreamManager.sendEventByIp(speakerIp, event);
    });
  })
  .catch((err) => {
    console.error('[GENA] Failed to start listener:', err);
  });

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

    // HTTP live stream endpoint (supports both .mp3 and .aac)
    const streamMatch = url.pathname.match(/^\/streams\/([^/]+)\/live\.(mp3|aac)$/);
    if (streamMatch && req.method === 'GET') {
      const streamId = streamMatch[1];
      const format = streamMatch[2] as 'mp3' | 'aac';
      if (!streamId) {
        return new Response('Invalid stream ID', { status: 400 });
      }

      const stream = StreamManager.get(streamId);
      if (!stream) {
        return new Response('Stream not found', { status: 404 });
      }

      // Set Content-Type based on format
      const contentType = format === 'aac' ? 'audio/aac' : 'audio/mpeg';

      // Check if client requested ICY metadata
      const wantsIcy = req.headers.get('icy-metadata') === '1';
      console.log(
        `[Stream] New subscriber for ${streamId} (format: ${format}, icy_metadata: ${wantsIcy})`
      );

      const baseStream = stream.createReadableStream();

      // If ICY metadata not requested, return plain stream
      if (!wantsIcy) {
        return new Response(baseStream, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'Transfer-Encoding': 'chunked',
          },
        });
      }

      // Wrap stream with ICY metadata injection
      let bytesSinceMeta = 0;

      const icyStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          let offset = 0;

          while (offset < chunk.length) {
            const bytesUntilMeta = ICY_METAINT - bytesSinceMeta;
            const bytesRemaining = chunk.length - offset;

            if (bytesRemaining < bytesUntilMeta) {
              // Not enough bytes to reach metadata point
              controller.enqueue(chunk.subarray(offset));
              bytesSinceMeta += bytesRemaining;
              break;
            } else {
              // Output audio up to metadata point
              controller.enqueue(chunk.subarray(offset, offset + bytesUntilMeta));

              // Inject metadata
              const metadata = stream.getMetadata();
              const metaBlock = formatIcyMetadata(metadata);
              controller.enqueue(metaBlock);

              offset += bytesUntilMeta;
              bytesSinceMeta = 0;
            }
          }
        },
      });

      const wrappedStream = baseStream.pipeThrough(icyStream);

      return new Response(wrappedStream, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Transfer-Encoding': 'chunked',
          'icy-metaint': String(ICY_METAINT),
          'icy-name': 'Thaumic Cast',
        },
      });
    }

    // Health check endpoint (no auth required)
    if (url.pathname === '/api/health') {
      const origin = req.headers.get('Origin');
      return new Response(
        JSON.stringify({ status: 'ok', service: 'thaumic-cast-server', timestamp: Date.now() }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Credentials': 'true',
          },
        }
      );
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
