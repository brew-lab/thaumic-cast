/**
 * GENA (General Event Notification Architecture) listener for Sonos UPnP events
 *
 * Subscribes to Sonos speaker services and receives NOTIFY callbacks when state changes.
 * Events are routed to the StreamManager to forward to connected extensions.
 */

import { getLocalIp } from './ssdp-discovery';
import { unescapeXml } from './soap-client';
import {
  GENA_SERVICE_ENDPOINTS,
  type GenaService,
  type GenaSubscription,
  type SonosEvent,
  type TransportState,
} from '@thaumic-cast/shared';

const SONOS_PORT = 1400;
const DEFAULT_GENA_PORT = 3001;
const GENA_PORT_RANGE = [3001, 3002, 3003, 3004, 3005]; // Fallback ports to try
const DEFAULT_TIMEOUT_SECONDS = 3600;
const RENEWAL_MARGIN_SECONDS = 300; // Renew 5 minutes before expiry

type EventCallback = (speakerIp: string, event: SonosEvent) => void;

interface SubscriptionState extends GenaSubscription {
  renewalTimer?: ReturnType<typeof setTimeout>;
}

class GenaListenerClass {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private subscriptions: Map<string, SubscriptionState> = new Map();
  private eventCallback: EventCallback | null = null;
  private port: number = DEFAULT_GENA_PORT;
  private localIp: string | null = null;

  /**
   * Start the GENA listener HTTP server
   * Tries multiple ports if the primary port is in use
   */
  async start(port: number = DEFAULT_GENA_PORT): Promise<void> {
    if (this.server) {
      console.log('[GENA] Server already running');
      return;
    }

    // LOCAL_SERVER_IP env var takes precedence (needed for WSL2 where getLocalIp returns internal IP)
    this.localIp = Bun.env.LOCAL_SERVER_IP || getLocalIp();

    if (!this.localIp) {
      throw new Error('Could not determine local IP address for GENA callbacks');
    }

    // Build list of ports to try, starting with the requested port
    const portsToTry = [port, ...GENA_PORT_RANGE.filter((p) => p !== port)];
    let lastError: Error | null = null;

    for (const tryPort of portsToTry) {
      try {
        this.server = Bun.serve({
          port: tryPort,
          fetch: async (req) => {
            const url = new URL(req.url);

            // Handle NOTIFY callbacks
            if (req.method === 'NOTIFY' && url.pathname.startsWith('/notify/')) {
              return this.handleNotify(req, url);
            }

            // Health check
            if (url.pathname === '/health') {
              return new Response('GENA listener running', { status: 200 });
            }

            return new Response('Not found', { status: 404 });
          },
        });

        this.port = tryPort;
        console.log(`[GENA] Listener started on http://${this.localIp}:${this.port}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[GENA] Port ${tryPort} unavailable, trying next...`);
      }
    }

    // All ports failed
    throw new Error(
      `Could not start GENA listener: all ports in range ${GENA_PORT_RANGE[0]}-${GENA_PORT_RANGE[GENA_PORT_RANGE.length - 1]} are in use. Last error: ${lastError?.message}`
    );
  }

  /**
   * Stop the GENA listener and unsubscribe from all services
   */
  async stop(): Promise<void> {
    // Unsubscribe from all
    const unsubPromises: Promise<void>[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.renewalTimer) {
        clearTimeout(sub.renewalTimer);
      }
      unsubPromises.push(this.unsubscribe(sub.sid).catch(() => {}));
    }
    await Promise.all(unsubPromises);

    this.subscriptions.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    console.log('[GENA] Listener stopped');
  }

  /**
   * Set the callback for received events
   */
  onEvent(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Subscribe to a service on a Sonos speaker
   */
  async subscribe(speakerIp: string, service: GenaService): Promise<string> {
    if (!this.localIp) {
      throw new Error('GENA listener not started');
    }

    const eventUrl = GENA_SERVICE_ENDPOINTS[service];
    const callbackPath = `/notify/${speakerIp.replace(/\./g, '-')}/${service}`;
    const callbackUrl = `http://${this.localIp}:${this.port}${callbackPath}`;

    console.log(`[GENA] Subscribing to ${service} on ${speakerIp}`);
    console.log(`[GENA] Callback URL: ${callbackUrl}`);

    const response = await fetch(`http://${speakerIp}:${SONOS_PORT}${eventUrl}`, {
      method: 'SUBSCRIBE',
      headers: {
        CALLBACK: `<${callbackUrl}>`,
        NT: 'upnp:event',
        TIMEOUT: `Second-${DEFAULT_TIMEOUT_SECONDS}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GENA] Subscribe failed: ${response.status}`, errorText);
      throw new Error(`GENA subscribe failed: ${response.status}`);
    }

    const sid = response.headers.get('SID');
    const timeoutHeader = response.headers.get('TIMEOUT');

    if (!sid) {
      throw new Error('No SID in SUBSCRIBE response');
    }

    // Parse timeout (format: "Second-3600")
    let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    if (timeoutHeader) {
      const match = timeoutHeader.match(/Second-(\d+)/);
      if (match && match[1]) {
        timeoutSeconds = parseInt(match[1], 10);
      }
    }

    const expiresAt = Date.now() + timeoutSeconds * 1000;

    const subscription: SubscriptionState = {
      sid,
      speakerIp,
      service,
      expiresAt,
      callbackPath,
    };

    // Store subscription
    this.subscriptions.set(sid, subscription);

    // Schedule renewal
    this.scheduleRenewal(subscription);

    console.log(`[GENA] Subscribed: SID=${sid}, expires in ${timeoutSeconds}s`);
    return sid;
  }

  /**
   * Renew a subscription
   */
  async renew(sid: string): Promise<void> {
    const sub = this.subscriptions.get(sid);
    if (!sub) {
      console.warn(`[GENA] Cannot renew unknown subscription: ${sid}`);
      return;
    }

    const eventUrl = GENA_SERVICE_ENDPOINTS[sub.service];

    console.log(`[GENA] Renewing subscription ${sid}`);

    try {
      const response = await fetch(`http://${sub.speakerIp}:${SONOS_PORT}${eventUrl}`, {
        method: 'SUBSCRIBE',
        headers: {
          SID: sid,
          TIMEOUT: `Second-${DEFAULT_TIMEOUT_SECONDS}`,
        },
      });

      if (!response.ok) {
        console.error(`[GENA] Renewal failed: ${response.status}`);
        // Try to re-subscribe
        this.subscriptions.delete(sid);
        await this.subscribe(sub.speakerIp, sub.service);
        return;
      }

      // Update expiry
      const timeoutHeader = response.headers.get('TIMEOUT');
      let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
      if (timeoutHeader) {
        const match = timeoutHeader.match(/Second-(\d+)/);
        if (match && match[1]) {
          timeoutSeconds = parseInt(match[1], 10);
        }
      }

      sub.expiresAt = Date.now() + timeoutSeconds * 1000;
      this.scheduleRenewal(sub);

      console.log(`[GENA] Renewed: SID=${sid}, expires in ${timeoutSeconds}s`);
    } catch (err) {
      console.error(`[GENA] Renewal error:`, err);
      // Try to re-subscribe
      this.subscriptions.delete(sid);
      try {
        await this.subscribe(sub.speakerIp, sub.service);
      } catch (subErr) {
        console.error(`[GENA] Re-subscribe failed:`, subErr);
      }
    }
  }

  /**
   * Unsubscribe from a service
   */
  async unsubscribe(sid: string): Promise<void> {
    const sub = this.subscriptions.get(sid);
    if (!sub) {
      return;
    }

    if (sub.renewalTimer) {
      clearTimeout(sub.renewalTimer);
    }

    const eventUrl = GENA_SERVICE_ENDPOINTS[sub.service];

    try {
      await fetch(`http://${sub.speakerIp}:${SONOS_PORT}${eventUrl}`, {
        method: 'UNSUBSCRIBE',
        headers: {
          SID: sid,
        },
      });
      console.log(`[GENA] Unsubscribed: ${sid}`);
    } catch (err) {
      console.warn(`[GENA] Unsubscribe error:`, err);
    }

    this.subscriptions.delete(sid);
  }

  /**
   * Unsubscribe from all services for a speaker
   */
  async unsubscribeAll(speakerIp: string): Promise<void> {
    const toRemove: string[] = [];

    for (const [sid, sub] of this.subscriptions) {
      if (sub.speakerIp === speakerIp) {
        toRemove.push(sid);
      }
    }

    await Promise.all(toRemove.map((sid) => this.unsubscribe(sid)));
  }

  /**
   * Get active subscription count
   */
  get activeSubscriptions(): number {
    return this.subscriptions.size;
  }

  /**
   * Get diagnostic info for debugging
   */
  getDiagnostics(): {
    running: boolean;
    port: number;
    localIp: string | null;
    subscriptions: Array<{ sid: string; speakerIp: string; service: string }>;
  } {
    return {
      running: this.server !== null,
      port: this.port,
      localIp: this.localIp,
      subscriptions: Array.from(this.subscriptions.values()).map((sub) => ({
        sid: sub.sid,
        speakerIp: sub.speakerIp,
        service: sub.service,
      })),
    };
  }

  /**
   * Schedule subscription renewal
   */
  private scheduleRenewal(sub: SubscriptionState): void {
    if (sub.renewalTimer) {
      clearTimeout(sub.renewalTimer);
    }

    const msUntilRenewal = sub.expiresAt - Date.now() - RENEWAL_MARGIN_SECONDS * 1000;
    const renewIn = Math.max(60000, msUntilRenewal); // At least 1 minute

    sub.renewalTimer = setTimeout(() => {
      this.renew(sub.sid);
    }, renewIn);
  }

  /**
   * Handle NOTIFY callback from Sonos speaker
   */
  private async handleNotify(req: Request, _url: URL): Promise<Response> {
    console.log('[GENA] Received NOTIFY callback');
    const sid = req.headers.get('SID');

    if (!sid) {
      console.warn('[GENA] NOTIFY without SID');
      return new Response('Missing SID', { status: 400 });
    }

    const sub = this.subscriptions.get(sid);
    if (!sub) {
      console.warn(`[GENA] NOTIFY for unknown SID: ${sid}`);
      console.warn(`[GENA] Known SIDs: ${Array.from(this.subscriptions.keys()).join(', ')}`);
      return new Response('Unknown subscription', { status: 412 });
    }

    console.log(`[GENA] NOTIFY for ${sub.service} from ${sub.speakerIp}`);

    try {
      const body = await req.text();
      const events = this.parseNotify(body, sub.service, sub.speakerIp);

      for (const event of events) {
        console.log(`[GENA] Event from ${sub.speakerIp}:`, event.type, event);
        if (this.eventCallback) {
          this.eventCallback(sub.speakerIp, event);
        }
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      console.error('[GENA] Error processing NOTIFY:', err);
      return new Response('Processing error', { status: 500 });
    }
  }

  /**
   * Parse NOTIFY body and extract events
   */
  private parseNotify(body: string, service: GenaService, speakerIp: string): SonosEvent[] {
    const events: SonosEvent[] = [];
    const timestamp = Date.now();

    // Extract LastChange from propertyset (use [\s\S]*? to match any char including newlines)
    const lastChangeMatch = body.match(/<LastChange>([\s\S]*?)<\/LastChange>/);
    if (!lastChangeMatch || !lastChangeMatch[1]) {
      console.warn('[GENA] Failed to extract LastChange from body');
      return events;
    }

    // LastChange content is XML-escaped
    const lastChangeXml = unescapeXml(lastChangeMatch[1]);
    console.log(`[GENA] Parsed LastChange: ${lastChangeXml.substring(0, 200)}...`);

    if (service === 'AVTransport') {
      // Parse transport state
      const stateMatch = lastChangeXml.match(/<TransportState\s+val="([^"]+)"/);
      if (stateMatch && stateMatch[1]) {
        const state = stateMatch[1] as TransportState;
        events.push({
          type: 'transportState',
          state,
          speakerIp,
          timestamp,
        });
      }
    }

    if (service === 'RenderingControl') {
      // Parse volume
      const volumeMatch = lastChangeXml.match(/<Volume\s+channel="Master"\s+val="(\d+)"/);
      if (volumeMatch && volumeMatch[1]) {
        const volume = parseInt(volumeMatch[1], 10);
        events.push({
          type: 'volume',
          volume,
          speakerIp,
          timestamp,
        });
      }

      // Parse mute
      const muteMatch = lastChangeXml.match(/<Mute\s+channel="Master"\s+val="([01])"/);
      if (muteMatch && muteMatch[1]) {
        const mute = muteMatch[1] === '1';
        events.push({
          type: 'mute',
          mute,
          speakerIp,
          timestamp,
        });
      }
    }

    if (service === 'ZoneGroupTopology') {
      // Zone topology changed - just emit a generic event
      // The extension can refresh groups if needed
      events.push({
        type: 'zoneChange',
        timestamp,
      });
    }

    return events;
  }
}

export const GenaListener = new GenaListenerClass();
