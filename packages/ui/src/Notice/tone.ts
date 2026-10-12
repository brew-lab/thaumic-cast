import type { GlyphName } from '../Icon/glyphs';

/** The notice tones (DESIGN.md M-notice, M-noticeline). There is no success tone. */
export type NoticeTone = 'danger' | 'warning' | 'info';

/** Each tone's glyph: the tone is the container, the glyph and the lead's words together. */
export const TONE_GLYPH: Record<NoticeTone, GlyphName> = {
  danger: 'danger',
  warning: 'warning',
  info: 'info',
};

/**
 * What a notice says through the Announcer when it arrives after the surface opened: the
 * lead and the text as one message. A danger banner is the one notice said urgently (S2).
 * @param parts - The notice's words and kind
 * @param parts.lead - The lead
 * @param parts.text - The text
 * @param parts.prefix - Words said before the lead, such as "While you were away:"
 * @param parts.urgent - Whether it is a danger banner
 * @returns The message and its urgency, or null when there is nothing to say
 */
export function noticeAnnouncement({
  lead,
  text,
  prefix,
  urgent = false,
}: {
  lead?: string;
  text?: string;
  prefix?: string;
  urgent?: boolean;
}): { message: string; urgent: boolean } | null {
  const head = [prefix, lead].filter(Boolean).join(' ');
  const message = [head && !/[.!?:]$/.test(head) && text ? `${head}.` : head, text]
    .filter(Boolean)
    .join(' ');
  return message ? { message, urgent } : null;
}
