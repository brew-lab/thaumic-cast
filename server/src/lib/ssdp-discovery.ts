/**
 * SSDP Discovery for Sonos speakers
 * Uses UDP multicast to discover UPnP devices on the local network
 */

import { networkInterfaces } from 'os';

const SSDP_MULTICAST_IP = '239.255.255.250';
const SSDP_PORT = 1900;
const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

// Discovery parameters
const MX_VALUE = 3; // Devices respond within 0-MX seconds
const RETRY_COUNT = 3;
const RETRY_INTERVAL_MS = 800;
const DEFAULT_TIMEOUT_MS = 5000;

export interface DiscoveredSpeaker {
  uuid: string;
  ip: string;
  location: string;
}

interface NetworkInterface {
  name: string;
  address: string;
}

/**
 * Get all valid local IPv4 interfaces for discovery
 * Filters out loopback and virtual interfaces (docker, veth, etc.)
 */
function getValidInterfaces(): NetworkInterface[] {
  const interfaces = networkInterfaces();
  const result: NetworkInterface[] = [];

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) continue;

    for (const info of iface) {
      // Skip internal and non-IPv4 addresses
      if (info.internal || info.family !== 'IPv4') continue;

      // Skip virtual interfaces
      if (
        name.startsWith('docker') ||
        name.startsWith('veth') ||
        name.startsWith('br-') ||
        name.startsWith('virbr')
      ) {
        continue;
      }

      result.push({ name, address: info.address });
    }
  }

  return result;
}

/**
 * Parse SSDP response headers to extract device info
 */
function parseSsdpResponse(response: string): DiscoveredSpeaker | null {
  const lines = response.split('\r\n');
  const headers: Record<string, string> = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).toLowerCase().trim();
      const value = line.substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  const location = headers['location'];
  const usn = headers['usn'];

  if (!location || !usn) {
    return null;
  }

  // Extract UUID from USN (format: uuid:RINCON_xxxx::urn:schemas-upnp-org:device:ZonePlayer:1)
  const uuidMatch = usn.match(/uuid:(RINCON_[^:]+)/);
  if (!uuidMatch || !uuidMatch[1]) {
    return null;
  }

  // Extract IP from location URL
  try {
    const locationUrl = new URL(location);
    const ip = locationUrl.hostname;

    return {
      uuid: uuidMatch[1],
      ip,
      location,
    };
  } catch {
    return null;
  }
}

/**
 * Get the local IP address (first valid interface)
 */
export function getLocalIp(): string | null {
  const interfaces = getValidInterfaces();
  return interfaces[0]?.address ?? null;
}

/**
 * Discover Sonos speakers on the local network using SSDP
 * Creates a socket per network interface for reliable discovery
 *
 * @param timeoutMs - How long to wait for responses (default 5000ms)
 */
export async function discoverSpeakers(
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<DiscoveredSpeaker[]> {
  const discovered = new Map<string, DiscoveredSpeaker>();
  const interfaces = getValidInterfaces();

  if (interfaces.length === 0) {
    console.error('[SSDP] No valid network interfaces found');
    return [];
  }

  console.log(
    `[SSDP] Discovering on ${interfaces.length} interface(s): ${interfaces.map((i) => i.name).join(', ')}`
  );

  const mSearchMessage =
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_MULTICAST_IP}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `MX: ${MX_VALUE}\r\n` +
    `ST: ${SONOS_SEARCH_TARGET}\r\n` +
    '\r\n';

  const sockets: Array<{
    send: (data: string, port: number, addr: string) => boolean;
    close: () => void;
  }> = [];

  // Create a socket for each interface
  for (const iface of interfaces) {
    try {
      const socket = await Bun.udpSocket({
        hostname: iface.address,
        socket: {
          data(_socket, buf, _port, _addr) {
            const response = buf.toString();
            const speaker = parseSsdpResponse(response);

            if (speaker && !discovered.has(speaker.uuid)) {
              discovered.set(speaker.uuid, speaker);
              console.log(
                `[SSDP] Discovered: ${speaker.uuid} at ${speaker.ip} (via ${iface.name})`
              );
            }
          },
          error(_socket, error) {
            console.error(`[SSDP] Socket error on ${iface.name}:`, error);
          },
        },
      });
      // Cast to our expected interface (unconnected socket)
      sockets.push(socket as (typeof sockets)[number]);
    } catch (err) {
      console.warn(`[SSDP] Failed to create socket for ${iface.name} (${iface.address}):`, err);
    }
  }

  if (sockets.length === 0) {
    console.error('[SSDP] No sockets could be created');
    return [];
  }

  // Calculate timing
  const sendDuration = (RETRY_COUNT - 1) * RETRY_INTERVAL_MS;
  const listenDuration = Math.max(0, timeoutMs - sendDuration);

  // Send M-SEARCH multiple times with spacing
  for (let i = 0; i < RETRY_COUNT; i++) {
    for (const socket of sockets) {
      socket.send(mSearchMessage, SSDP_PORT, SSDP_MULTICAST_IP);
    }

    if (i < RETRY_COUNT - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }

  // Wait for remaining responses
  await new Promise((resolve) => setTimeout(resolve, listenDuration));

  // Cleanup
  for (const socket of sockets) {
    socket.close();
  }

  console.log(`[SSDP] Discovery complete: found ${discovered.size} speaker(s)`);
  return Array.from(discovered.values());
}
