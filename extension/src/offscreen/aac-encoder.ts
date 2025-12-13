/**
 * AAC Encoder using WebCodecs AudioEncoder API
 *
 * This encoder wraps the native WebCodecs AudioEncoder to provide an interface
 * compatible with wasm-media-encoders, allowing seamless fallback between
 * native AAC and WASM MP3 encoding.
 */

export type AacCodec = 'mp4a.40.2' | 'mp4a.40.5'; // AAC-LC or HE-AAC

export interface AacEncoderConfig {
  codec: AacCodec;
  sampleRate: number;
  channels: 1 | 2;
  bitrate: number;
}

export interface AacEncoder {
  configure(config: AacEncoderConfig): void;
  encode(samples: [Float32Array, Float32Array]): Uint8Array | null;
  finalize(): Uint8Array | null;
  close(): void;
}

/**
 * Check if AAC encoding is supported for a given configuration
 */
export async function isAacSupported(config: AacEncoderConfig): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') {
    console.log('[AAC Encoder] AudioEncoder is undefined in this context');
    return false;
  }

  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate,
    });
    console.log('[AAC Encoder] isConfigSupported result:', result);
    return result.supported === true;
  } catch (error) {
    console.log('[AAC Encoder] isConfigSupported error:', error);
    return false;
  }
}

/**
 * Create an AAC encoder using WebCodecs AudioEncoder
 */
export async function createAacEncoder(): Promise<AacEncoder> {
  let encoder: AudioEncoder | null = null;
  let outputBuffer: Uint8Array[] = [];
  let sampleRate = 48000;
  let channels: 1 | 2 = 2;
  let codec: AacCodec = 'mp4a.40.2';
  let samplesProcessed = 0;
  let isConfigured = false;

  // Collect encoded chunks
  const handleOutput = (chunk: EncodedAudioChunk) => {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    // Wrap in ADTS header for streaming
    const adtsFrame = wrapWithAdts(data, sampleRate, channels, codec);
    outputBuffer.push(adtsFrame);
  };

  const handleError = (error: DOMException) => {
    console.error('[AAC Encoder] Error:', error);
  };

  return {
    configure(config: AacEncoderConfig): void {
      sampleRate = config.sampleRate;
      channels = config.channels;
      codec = config.codec;
      samplesProcessed = 0;

      encoder = new AudioEncoder({
        output: handleOutput,
        error: handleError,
      });

      encoder.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
        bitrate: config.bitrate,
      });

      isConfigured = true;
    },

    encode(samples: [Float32Array, Float32Array]): Uint8Array | null {
      if (!encoder || !isConfigured) {
        console.error('[AAC Encoder] Not configured');
        return null;
      }

      const left = samples[0];
      const right = samples[1];
      const numSamples = left.length;

      // Create planar audio data for AudioData constructor
      // AudioData expects planar format: [left channel samples...][right channel samples...]
      const planarData = new Float32Array(numSamples * channels);

      if (channels === 2) {
        // Planar stereo: first half is left, second half is right
        for (let i = 0; i < numSamples; i++) {
          planarData[i] = left[i]!;
          planarData[numSamples + i] = right[i]!;
        }
      } else {
        // Mono: average channels
        for (let i = 0; i < numSamples; i++) {
          planarData[i] = (left[i]! + right[i]!) / 2;
        }
      }

      // Create AudioData from planar samples
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: sampleRate,
        numberOfFrames: numSamples,
        numberOfChannels: channels,
        timestamp: Math.floor((samplesProcessed / sampleRate) * 1_000_000), // microseconds
        data: planarData.buffer as ArrayBuffer,
      });

      samplesProcessed += numSamples;

      try {
        encoder.encode(audioData);
        audioData.close();
      } catch (error) {
        console.error('[AAC Encoder] Encode error:', error);
        audioData.close();
        return null;
      }

      // Return accumulated output
      if (outputBuffer.length === 0) {
        return null;
      }

      const result = concatenateBuffers(outputBuffer);
      outputBuffer = [];
      return result;
    },

    finalize(): Uint8Array | null {
      if (!encoder || !isConfigured) {
        return null;
      }

      try {
        encoder.flush();
      } catch {
        // Flush may fail if encoder is already closed
      }

      if (outputBuffer.length === 0) {
        return null;
      }

      const result = concatenateBuffers(outputBuffer);
      outputBuffer = [];
      return result;
    },

    close(): void {
      if (encoder) {
        try {
          encoder.close();
        } catch {
          // May already be closed
        }
        encoder = null;
      }
      isConfigured = false;
      outputBuffer = [];
    },
  };
}

/**
 * Concatenate multiple Uint8Array buffers into one
 */
function concatenateBuffers(buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Wrap raw AAC frame with ADTS header for streaming
 *
 * ADTS (Audio Data Transport Stream) header format:
 * - 7 bytes for fixed + variable header (no CRC)
 * - Allows each AAC frame to be decoded independently
 */
function wrapWithAdts(
  aacFrame: Uint8Array,
  sampleRate: number,
  channels: 1 | 2,
  codec: AacCodec
): Uint8Array {
  const frameLength = aacFrame.length + 7; // 7 byte ADTS header

  // Sample rate index
  const sampleRateIndex = getSampleRateIndex(sampleRate);

  // Object type: 1 = AAC Main, 2 = AAC-LC, 5 = HE-AAC
  const objectType = codec === 'mp4a.40.5' ? 5 : 2;

  // Channel configuration
  const channelConfig = channels;

  // Build ADTS header (7 bytes, no CRC)
  const header = new Uint8Array(7);

  // Syncword: 0xFFF (12 bits)
  header[0] = 0xff;
  header[1] = 0xf9; // 0xF9 = syncword (4 bits) + MPEG-4 + Layer 0 + no CRC

  // Object type (2 bits) + Sample rate index (4 bits) + Private bit (1) + Channel config high (1 bit)
  header[2] =
    ((objectType - 1) << 6) | // Object type is stored as (type - 1)
    (sampleRateIndex << 2) |
    (0 << 1) | // Private bit
    ((channelConfig >> 2) & 0x01);

  // Channel config low (2 bits) + Original (1) + Home (1) + Copyright ID (1) + Copyright start (1) + Frame length high (2 bits)
  header[3] =
    ((channelConfig & 0x03) << 6) |
    (0 << 5) | // Original/copy
    (0 << 4) | // Home
    (0 << 3) | // Copyright ID bit
    (0 << 2) | // Copyright ID start
    ((frameLength >> 11) & 0x03);

  // Frame length middle (8 bits)
  header[4] = (frameLength >> 3) & 0xff;

  // Frame length low (3 bits) + Buffer fullness high (5 bits)
  header[5] = ((frameLength & 0x07) << 5) | 0x1f; // Buffer fullness 0x7FF means VBR

  // Buffer fullness low (6 bits) + Number of AAC frames - 1 (2 bits)
  header[6] = 0xfc; // Buffer fullness low + 0 additional frames

  // Combine header and frame
  const result = new Uint8Array(frameLength);
  result.set(header, 0);
  result.set(aacFrame, 7);

  return result;
}

/**
 * Get ADTS sample rate index
 */
function getSampleRateIndex(sampleRate: number): number {
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  const index = rates.indexOf(sampleRate);
  return index >= 0 ? index : 4; // Default to 44100Hz if not found
}
