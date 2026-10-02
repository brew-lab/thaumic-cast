/**
 * ADTS (Audio Data Transport Stream) framing for AAC.
 *
 * Every AAC frame is prefixed by a 7-byte header (no CRC), laid out by
 * ISO/IEC 13818-7 (6.2.1) and ISO/IEC 14496-3 (1.A.3.2):
 *
 * | Bits | Field                                                       |
 * |------|-------------------------------------------------------------|
 * | 12   | syncword, all ones                                          |
 * | 1    | ID, 0 = MPEG-4                                              |
 * | 2    | layer, always 0                                             |
 * | 1    | protection_absent, 1 = no CRC                               |
 * | 2    | profile = audio object type - 1 (Main 0, LC 1, SSR 2, LTP 3) |
 * | 4    | sampling_frequency_index                                    |
 * | 1    | private_bit                                                 |
 * | 3    | channel_configuration                                       |
 * | 4    | original/copy, home, copyright id bit, copyright id start   |
 * | 13   | frame length, header included                               |
 * | 11   | buffer fullness, all ones = variable bitrate                |
 * | 2    | raw data blocks in the frame - 1                            |
 */

/** Length in bytes of an ADTS header without a CRC. */
export const ADTS_HEADER_LENGTH = 7;

/** Largest frame (header included) the 13-bit length field can describe. */
export const ADTS_MAX_FRAME_LENGTH = 0x1fff;

/** MPEG-4 audio object type of AAC Main. */
export const AOT_AAC_MAIN = 1;
/** MPEG-4 audio object type of AAC-LC (Low Complexity). */
export const AOT_AAC_LC = 2;
/** MPEG-4 audio object type of AAC-SSR (Scalable Sample Rate). */
export const AOT_AAC_SSR = 3;
/** MPEG-4 audio object type of AAC-LTP (Long Term Prediction). */
export const AOT_AAC_LTP = 4;

/** Sync word byte 0: the first eight of the twelve sync bits. */
const SYNC_BYTE_0 = 0xff;
/** Sync word byte 1: last four sync bits, then MPEG-4 (0), layer (00), no CRC (1). */
const SYNC_BYTE_1 = 0xf1;
/** The top five of the eleven buffer-fullness bits, all ones for variable bitrate. */
const BUFFER_FULLNESS_VBR_HIGH = 0x1f;
/** The low six buffer-fullness bits (all ones), then one raw data block (00). */
const BUFFER_FULLNESS_VBR_LOW_ONE_BLOCK = 0xfc;

/**
 * sampling_frequency_index for each sample rate ADTS can signal
 * (ISO/IEC 14496-3 table 1.18).
 */
const SAMPLE_RATE_INDEX: Readonly<Record<number, number>> = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11,
  7350: 12,
};

/**
 * channel_configuration for a channel count (ISO/IEC 14496-3 table 1.19).
 * One to six channels signal themselves; 7.1 is configuration 7.
 */
const CHANNEL_CONFIGURATION: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  8: 7,
};

/**
 * What an ADTS header declares about the frames it carries.
 */
export interface AdtsParams {
  /** MPEG-4 audio object type the header names (1 to 4). */
  objectType: number;
  /** Sample rate the header names, in Hz. */
  sampleRate: number;
  /** Channel count the header names. */
  channels: number;
}

/**
 * Builds the 7-byte ADTS header for one raw AAC frame.
 *
 * The 2-bit profile field holds the audio object type minus one, so it can
 * only name Main, LC, SSR and LTP. SBR (object type 5) and PS (29) cannot be
 * named here at all; see {@link aacLcAdtsParams}.
 *
 * @param objectType - MPEG-4 audio object type of the frame (1 to 4; AAC-LC is 2)
 * @param sampleRate - Sample rate to declare, in Hz
 * @param channels - Channel count to declare
 * @param payloadLength - Length of the raw AAC frame in bytes, header excluded
 * @param out - Buffer to write into, to avoid allocating per frame
 * @returns The header (`out` when given)
 * @throws {RangeError} If a value cannot be expressed in an ADTS header
 */
export function buildAdtsHeader(
  objectType: number,
  sampleRate: number,
  channels: number,
  payloadLength: number,
  out: Uint8Array = new Uint8Array(ADTS_HEADER_LENGTH),
): Uint8Array {
  if (!Number.isInteger(objectType) || objectType < AOT_AAC_MAIN || objectType > AOT_AAC_LTP) {
    throw new RangeError(`ADTS cannot signal audio object type ${objectType}`);
  }
  const sampleRateIndex = SAMPLE_RATE_INDEX[sampleRate];
  if (sampleRateIndex === undefined) {
    throw new RangeError(`ADTS cannot signal a sample rate of ${sampleRate} Hz`);
  }
  const channelConfiguration = CHANNEL_CONFIGURATION[channels];
  if (channelConfiguration === undefined) {
    throw new RangeError(`ADTS cannot signal ${channels} channels`);
  }
  const frameLength = payloadLength + ADTS_HEADER_LENGTH;
  if (
    !Number.isInteger(payloadLength) ||
    payloadLength < 0 ||
    frameLength > ADTS_MAX_FRAME_LENGTH
  ) {
    throw new RangeError(`ADTS cannot frame a payload of ${payloadLength} bytes`);
  }

  out[0] = SYNC_BYTE_0;
  out[1] = SYNC_BYTE_1;
  // profile (2) + sampling_frequency_index (4) + private_bit (1) + channel_configuration high bit (1)
  out[2] = ((objectType - 1) << 6) | (sampleRateIndex << 2) | (channelConfiguration >> 2);
  // channel_configuration low bits (2) + original, home, copyright bits (4) + frame length high bits (2)
  out[3] = ((channelConfiguration & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  // frame length middle bits (8)
  out[4] = (frameLength >> 3) & 0xff;
  // frame length low bits (3) + buffer fullness high bits (5)
  out[5] = ((frameLength & 0x07) << 5) | BUFFER_FULLNESS_VBR_HIGH;
  // buffer fullness low bits (6) + raw data blocks - 1 (2)
  out[6] = BUFFER_FULLNESS_VBR_LOW_ONE_BLOCK;
  return out;
}

/**
 * What the ADTS header declares for the frames the browser's AAC encoder gives.
 *
 * Always AAC-LC (object type 2) at the stream's own rate and channels, because
 * that is all Chromium's `AudioEncoder` produces. It ignores the profile in the
 * codec string: measured on Chrome and Edge 154 on Windows, `mp4a.40.2`,
 * `mp4a.40.5` and `mp4a.40.29` give byte-identical AAC-LC at the full rate,
 * with an AudioSpecificConfig naming object type 2 and no SBR or PS extension,
 * and the macOS and Android encoders are LC-only in Chromium's source. That is
 * why the HE-AAC and HE-AAC v2 options were removed: they were AAC-LC under
 * another name.
 *
 * Real HE-AAC in ADTS is labelled differently, by implicit signalling
 * (ISO/IEC 14496-3, 1.6.5): the header names the AAC-LC core at half the output
 * rate, and one channel for v2. Applied to these frames that label is wrong:
 * a decoder then parses full-rate frames with the half-rate band tables and
 * fails. Use it only if an encoder that really emits SBR is ever adopted.
 *
 * @param sampleRate - Output sample rate of the stream, in Hz
 * @param channels - Output channel count of the stream
 * @returns The object type, sample rate and channels to put in the header
 */
export function aacLcAdtsParams(sampleRate: number, channels: number): AdtsParams {
  return { objectType: AOT_AAC_LC, sampleRate, channels };
}
