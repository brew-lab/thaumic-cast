/**
 * The URL a player such as VLC or a browser can open to hear a running cast,
 * and which cast belongs to which speaker card.
 *
 * The URL is always built from the companion's current address and the cast's
 * stream id, never from the session's `streamUrl`: that is fixed when the cast
 * starts, so it keeps an old address after an IP change, and for a grouped
 * member it is an `x-rincon:` URI rather than an HTTP URL.
 */

/** A codec a cast can be served in, as the core names it. */
export type CastCodec = 'pcm' | 'aac' | 'mp3' | 'flac';

/** The cast a speaker is playing, as far as building its URL needs. */
export interface SpeakerCast {
  /** The cast's stream id. */
  streamId: string;
  /** The codec the cast is served in. */
  codec: CastCodec;
}

/** The fields of a playback session this module reads. */
export interface CastSession {
  /** The stream the speaker plays. */
  streamId: string;
  /** The speaker's IP address. */
  speakerIp: string;
  /** The codec the stream is served in. */
  codec: CastCodec;
  /** Whether the speaker fetches the stream or follows a coordinator. */
  role?: 'coordinator' | 'slave';
}

/**
 * The listen route's file name for each codec. The handler ignores the
 * extension and sends the codec's own Content-Type, but a player may pick its
 * demuxer by the extension, so PCM (served as WAV) and FLAC carry theirs.
 */
const LISTEN_FILE: Record<CastCodec, string> = {
  pcm: 'listen.wav',
  flac: 'listen.flac',
  aac: 'listen',
  mp3: 'listen',
};

/**
 * Writes an IP address as the host part of a URL: IPv6 in brackets, with any
 * zone id's `%` escaped as `%25`.
 * @param ip - An IPv4 or IPv6 address
 * @returns The host as it goes in a URL
 */
function urlHost(ip: string): string {
  if (!ip.includes(':') || ip.startsWith('[')) return ip;
  return `[${ip.replaceAll('%', '%25')}]`;
}

/**
 * Builds the URL a player opens to hear a cast.
 * @param localIp - The address the companion is reachable at now
 * @param port - The port the companion serves on
 * @param cast - The cast's stream id and codec
 * @returns The URL, or null while the address or port is not known
 */
export function listenUrl(localIp: string, port: number, cast: SpeakerCast): string | null {
  if (!localIp || !port || !cast.streamId) return null;
  const file = LISTEN_FILE[cast.codec] ?? 'listen';
  return `http://${urlHost(localIp)}:${port}/stream/${encodeURIComponent(cast.streamId)}/${file}`;
}

/**
 * Maps each casting speaker to the cast it plays. A speaker that fetches the
 * stream itself wins over a stale entry that has it following a coordinator.
 * @param sessions - The playback sessions the core reports
 * @returns The cast per speaker IP
 */
export function castsBySpeaker(sessions: readonly CastSession[]): Record<string, SpeakerCast> {
  const casts: Record<string, SpeakerCast> = {};
  const fetches = new Set<string>();
  for (const session of sessions) {
    const isCoordinator = session.role !== 'slave';
    if (fetches.has(session.speakerIp) && !isCoordinator) continue;
    casts[session.speakerIp] = { streamId: session.streamId, codec: session.codec };
    if (isCoordinator) fetches.add(session.speakerIp);
  }
  return casts;
}
