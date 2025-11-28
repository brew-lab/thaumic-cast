/**
 * SSDP Discovery for Sonos speakers
 * Uses UDP multicast to discover UPnP devices on the local network
 */

import { networkInterfaces } from 'os';

const SSDP_MULTICAST_IP = '239.255.255.250';
const SSDP_PORT = 1900;
const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

export interface DiscoveredSpeaker {
  uuid: string;
  ip: string;
  location: string;
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
  const locationUrl = new URL(location);
  const ip = locationUrl.hostname;

  return {
    uuid: uuidMatch[1],
    ip,
    location,
  };
}

/**
 * Get the local IP address to bind to
 */
export function getLocalIp(): string | null {
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const info of iface) {
      // Skip internal and non-IPv4 addresses
      if (info.internal || info.family !== 'IPv4') continue;
      // Skip docker/virtual interfaces
      if (name.startsWith('docker') || name.startsWith('veth') || name.startsWith('br-')) continue;
      return info.address;
    }
  }

  return null;
}

/**
 * Discover Sonos speakers on the local network using SSDP
 * @param timeoutMs - How long to wait for responses (default 3000ms)
 */
export async function discoverSpeakers(timeoutMs = 3000): Promise<DiscoveredSpeaker[]> {
  const discovered = new Map<string, DiscoveredSpeaker>();

  const mSearchMessage =
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_MULTICAST_IP}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 1\r\n' +
    `ST: ${SONOS_SEARCH_TARGET}\r\n` +
    '\r\n';

  const socket = await Bun.udpSocket({
    socket: {
      data(_socket, buf, _port, _addr) {
        const response = buf.toString();
        const speaker = parseSsdpResponse(response);

        if (speaker && !discovered.has(speaker.uuid)) {
          discovered.set(speaker.uuid, speaker);
          console.log(`[SSDP] Discovered speaker: ${speaker.uuid} at ${speaker.ip}`);
        }
      },
      error(_socket, error) {
        console.error('[SSDP] Socket error:', error);
      },
    },
  });

  // Send M-SEARCH to multicast address
  socket.send(mSearchMessage, SSDP_PORT, SSDP_MULTICAST_IP);

  // Also send a second time after a short delay for reliability
  await new Promise((resolve) => setTimeout(resolve, 500));
  socket.send(mSearchMessage, SSDP_PORT, SSDP_MULTICAST_IP);

  // Wait for responses
  await new Promise((resolve) => setTimeout(resolve, timeoutMs - 500));

  socket.close();
  return Array.from(discovered.values());
}
