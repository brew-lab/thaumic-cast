/**
 * Reading a SourceBuffer's MIME type: what it carries and in what container.
 */

/** What a SourceBuffer carries. */
export type BufferKind = 'audio' | 'video' | 'muxed' | 'other';

/** Containers the hook can parse. */
export type BufferFormat = 'mp4' | 'webm' | 'unknown';

const AUDIO_CODECS =
  /^(mp4a|opus|vorbis|flac|ac-3|ec-3|ac-4|mp3|alac|dtsc|dtse|dtsh|dtsl|ulaw|alaw|pcm)/i;
const VIDEO_CODECS = /^(avc[1-4]|hev1|hvc1|dvh1|dvhe|vp0?8|vp0?9|vp09|av01|theora|mp4v)/i;

/**
 * Classifies a SourceBuffer by its MIME type: by the codecs parameter when
 * there is one, else by the top-level type.
 * @param mime - The type given to addSourceBuffer or changeType
 * @returns What the buffer carries
 */
export function classify(mime: string): BufferKind {
  const m = String(mime || '').toLowerCase();
  const cm = /codecs\s*=\s*"?([^";]*)/.exec(m);
  const codecs = cm
    ? cm[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const nA = codecs.filter((c) => AUDIO_CODECS.test(c)).length;
  const nV = codecs.filter((c) => VIDEO_CODECS.test(c)).length;
  if (nA && nV) return 'muxed';
  if (nA) return 'audio';
  if (nV) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'other';
}

/**
 * The container of a SourceBuffer's MIME type.
 * @param mime - The type given to addSourceBuffer or changeType
 * @returns `mp4`, `webm`, or `unknown` (MPEG-TS, raw AAC or MP3 in sequence mode, ...)
 */
export function formatOf(mime: string): BufferFormat {
  const m = String(mime || '').toLowerCase();
  if (/\/(mp4|iso\.segment)/.test(m)) return 'mp4';
  if (/\/webm/.test(m)) return 'webm';
  return 'unknown';
}
