import { useEffect, useState } from 'preact/hooks';
import { isCodecSupported, type EncoderConfig } from '@thaumic-cast/protocol';

/** The part of an encoder config the browser's encoder is asked about. */
type Combination = Pick<EncoderConfig, 'codec' | 'bitrate' | 'sampleRate' | 'channels'>;

/**
 * Asks the browser whether it will encode one exact combination of codec,
 * bitrate, sample rate and channels.
 *
 * Codec detection tries each bitrate at 48 kHz stereo and each sample rate at
 * the codec's default bitrate, so a combination picked from those lists has
 * not itself been tried. This makes the same call the encoder makes when a
 * cast starts, so the answer is known before then.
 *
 * @param combination - The combination to ask about, or null for none
 * @returns Whether the browser encodes it; null while unknown
 */
export function useCombinationSupport(combination: Combination | null): boolean | null {
  const codec = combination?.codec;
  const bitrate = combination?.bitrate;
  const sampleRate = combination?.sampleRate;
  const channels = combination?.channels;
  const key = combination ? `${codec}/${bitrate}/${sampleRate}/${channels}` : null;
  const [answer, setAnswer] = useState<{ key: string; supported: boolean } | null>(null);

  useEffect(() => {
    if (key === null || codec === undefined || bitrate === undefined) return;
    let cancelled = false;
    isCodecSupported(codec, bitrate, sampleRate, channels).then((supported) => {
      if (!cancelled) setAnswer({ key, supported });
    });
    return () => {
      cancelled = true;
    };
  }, [key, codec, bitrate, sampleRate, channels]);

  // An answer for an earlier combination says nothing about this one.
  return answer !== null && answer.key === key ? answer.supported : null;
}
