/**
 * WAV file assembly for Float32 PCM data.
 *
 * Produces a standard 44-byte RIFF/WAV header with IEEE Float format (tag 3).
 * No dither, no quantization — preserves exact sample values for offline analysis.
 */

/**
 * Writes an ASCII string into a DataView at the given offset.
 * @param view - DataView to write into
 * @param offset - Byte offset
 * @param str - ASCII string to write
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Creates a WAV Blob from raw Float32 interleaved PCM data.
 * @param pcmData - Raw Float32 interleaved PCM samples
 * @param sampleRate - Audio sample rate in Hz
 * @param channels - Number of audio channels
 * @returns A Blob containing a valid WAV file
 */
export function createWavBlob(pcmData: ArrayBuffer, sampleRate: number, channels: number): Blob {
  const bitsPerSample = 32;
  const formatTag = 3; // IEEE Float
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.byteLength;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF chunk
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return new Blob([header, pcmData], { type: 'audio/wav' });
}
