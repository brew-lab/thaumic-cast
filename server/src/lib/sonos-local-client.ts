/**
 * Sonos Local Client - Control Sonos speakers via UPnP/SOAP on LAN
 */

import { discoverSpeakers, getLocalIp, type DiscoveredSpeaker } from './ssdp-discovery';
import { sendSoapRequest, extractSoapValue, unescapeXml } from './soap-client';

// Service URNs
const ZONE_GROUP_TOPOLOGY = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';
const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1';

// Control URLs
const ZONE_GROUP_CONTROL = '/ZoneGroupTopology/Control';
const AV_TRANSPORT_CONTROL = '/MediaRenderer/AVTransport/Control';
const RENDERING_CONTROL_URL = '/MediaRenderer/RenderingControl/Control';

export interface LocalSpeaker {
  uuid: string;
  ip: string;
  zoneName: string;
  model: string;
}

export interface LocalGroup {
  id: string;
  name: string;
  coordinatorUuid: string;
  coordinatorIp: string;
  members: LocalSpeaker[];
}

// Cache discovered speakers
let cachedSpeakers: DiscoveredSpeaker[] = [];
let lastDiscoveryTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Discover Sonos speakers with caching
 */
export async function discover(forceRefresh = false): Promise<DiscoveredSpeaker[]> {
  const now = Date.now();

  if (!forceRefresh && cachedSpeakers.length > 0 && now - lastDiscoveryTime < CACHE_TTL_MS) {
    console.log('[SonosLocal] Using cached speakers');
    return cachedSpeakers;
  }

  console.log('[SonosLocal] Running SSDP discovery...');
  cachedSpeakers = await discoverSpeakers(3000);
  lastDiscoveryTime = now;

  console.log(`[SonosLocal] Found ${cachedSpeakers.length} speakers`);
  return cachedSpeakers;
}

/**
 * Parse ZoneGroupState XML to extract groups and members
 */
function parseZoneGroupState(xml: string): LocalGroup[] {
  const groups: LocalGroup[] = [];

  // The XML is double-escaped in the SOAP response, so unescape it
  const unescapedXml = unescapeXml(xml);

  // Match each ZoneGroup element
  const groupRegex = /<ZoneGroup\s+Coordinator="([^"]+)"[^>]*>([\s\S]*?)<\/ZoneGroup>/g;
  let groupMatch;

  while ((groupMatch = groupRegex.exec(unescapedXml)) !== null) {
    const coordinatorUuid = groupMatch[1];
    const groupContent = groupMatch[2];

    if (!coordinatorUuid || !groupContent) continue;

    // Match ZoneGroupMember elements - capture opening tag with all attributes
    const memberRegex = /<ZoneGroupMember\s+([^>]+)>/g;
    let memberMatch;
    const members: LocalSpeaker[] = [];
    let groupName = '';
    let coordinatorIp = '';

    while ((memberMatch = memberRegex.exec(groupContent)) !== null) {
      const attrs = memberMatch[1];
      if (!attrs) continue;

      // Skip zone bridges (BOOST devices) - they can't play audio
      if (attrs.includes('IsZoneBridge="1"')) {
        continue;
      }

      // Extract attributes
      const uuidMatch = attrs.match(/UUID="([^"]+)"/);
      const locationMatch = attrs.match(/Location="http:\/\/([^:]+):\d+/);
      const zoneNameMatch = attrs.match(/ZoneName="([^"]+)"/);
      const modelMatch = attrs.match(/Icon="[^"]*sonos-([^-"]+)/);

      const uuid = uuidMatch?.[1];
      const ip = locationMatch?.[1];
      const zoneName = zoneNameMatch?.[1];
      const model = modelMatch?.[1] || 'Unknown';

      if (!uuid || !ip || !zoneName) continue;

      members.push({ uuid, ip, zoneName, model });

      if (uuid === coordinatorUuid) {
        coordinatorIp = ip;
      }
    }

    // Build group name from member zone names
    if (members.length > 0) {
      groupName = members.map((m) => m.zoneName).join(' + ');
    }

    if (members.length > 0 && coordinatorIp) {
      groups.push({
        id: coordinatorUuid,
        name: groupName,
        coordinatorUuid,
        coordinatorIp,
        members,
      });
    }
  }

  return groups;
}

/**
 * Get zone groups from a Sonos speaker
 */
export async function getZoneGroups(speakerIp?: string): Promise<LocalGroup[]> {
  // If no IP provided, use first cached speaker or discover
  let ip = speakerIp;

  if (!ip) {
    const speakers = await discover();
    const firstSpeaker = speakers[0];
    if (!firstSpeaker) {
      throw new Error('No Sonos speakers found on network');
    }
    ip = firstSpeaker.ip;
  }

  const response = await sendSoapRequest({
    ip,
    controlUrl: ZONE_GROUP_CONTROL,
    serviceType: ZONE_GROUP_TOPOLOGY,
    action: 'GetZoneGroupState',
  });

  const zoneGroupState = extractSoapValue(response, 'ZoneGroupState');
  if (!zoneGroupState) {
    throw new Error('Failed to get ZoneGroupState from speaker');
  }

  return parseZoneGroupState(zoneGroupState);
}

/**
 * Set the audio stream URL on a Sonos group coordinator
 * Uses x-rincon-mp3radio:// protocol for HTTP streams
 */
export async function setAVTransportURI(coordinatorIp: string, streamUrl: string): Promise<void> {
  // Convert http:// to x-rincon-mp3radio:// for Sonos compatibility
  const sonosUrl = streamUrl.replace(/^https?:\/\//, 'x-rincon-mp3radio://');

  console.log(`[SonosLocal] SetAVTransportURI: ${sonosUrl}`);

  await sendSoapRequest({
    ip: coordinatorIp,
    controlUrl: AV_TRANSPORT_CONTROL,
    serviceType: AV_TRANSPORT,
    action: 'SetAVTransportURI',
    params: {
      InstanceID: 0,
      CurrentURI: sonosUrl,
      CurrentURIMetaData: '',
    },
  });
}

/**
 * Start playback on a Sonos group
 */
export async function play(coordinatorIp: string): Promise<void> {
  console.log(`[SonosLocal] Play on ${coordinatorIp}`);

  await sendSoapRequest({
    ip: coordinatorIp,
    controlUrl: AV_TRANSPORT_CONTROL,
    serviceType: AV_TRANSPORT,
    action: 'Play',
    params: {
      InstanceID: 0,
      Speed: 1,
    },
  });
}

/**
 * Stop playback on a Sonos group
 * Ignores error 701 (transition not available - already stopped)
 */
export async function stop(coordinatorIp: string): Promise<void> {
  console.log(`[SonosLocal] Stop on ${coordinatorIp}`);

  try {
    await sendSoapRequest({
      ip: coordinatorIp,
      controlUrl: AV_TRANSPORT_CONTROL,
      serviceType: AV_TRANSPORT,
      action: 'Stop',
      params: {
        InstanceID: 0,
      },
    });
  } catch (error) {
    // Ignore error 701 (transition not available - already stopped)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.includes('500')) {
      throw error;
    }
    console.log('[SonosLocal] Stop: Speaker may already be stopped (ignoring error)');
  }
}

/**
 * Get current volume of a speaker (0-100)
 */
export async function getVolume(speakerIp: string): Promise<number> {
  const response = await sendSoapRequest({
    ip: speakerIp,
    controlUrl: RENDERING_CONTROL_URL,
    serviceType: RENDERING_CONTROL,
    action: 'GetVolume',
    params: {
      InstanceID: 0,
      Channel: 'Master',
    },
  });

  const volumeStr = extractSoapValue(response, 'CurrentVolume');
  return volumeStr ? parseInt(volumeStr, 10) : 0;
}

/**
 * Set volume of a speaker (0-100)
 */
export async function setVolume(speakerIp: string, volume: number): Promise<void> {
  const clampedVolume = Math.max(0, Math.min(100, Math.round(volume)));

  console.log(`[SonosLocal] SetVolume ${clampedVolume} on ${speakerIp}`);

  await sendSoapRequest({
    ip: speakerIp,
    controlUrl: RENDERING_CONTROL_URL,
    serviceType: RENDERING_CONTROL,
    action: 'SetVolume',
    params: {
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: clampedVolume,
    },
  });
}

/**
 * Load a stream URL and start playback in one call
 */
export async function playStream(coordinatorIp: string, streamUrl: string): Promise<void> {
  await setAVTransportURI(coordinatorIp, streamUrl);
  await play(coordinatorIp);
}

/**
 * Get server's local IP address for stream URLs
 */
export { getLocalIp };
