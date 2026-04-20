/**
 * Popup UI — Start/Stop, config, live stats, download status.
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { CaptureConfig, CaptureStats, RelayMessage } from '../lib/messages';
import styles from './styles.module.css';

type CaptureState = 'idle' | 'capturing' | 'stopping';

const SAMPLE_RATES: Array<{ label: string; value: number | null }> = [
  { label: 'Auto (native)', value: null },
  { label: '48000 Hz', value: 48000 },
  { label: '44100 Hz', value: 44100 },
  { label: '32000 Hz', value: 32000 },
  { label: '16000 Hz', value: 16000 },
];

const BUFFER_SIZES = [1, 5, 10, 50, 200];

/** Timeout for the "stopping" state before showing an error (ms). */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Formats a byte count as a human-readable string.
 * @param bytes - The byte count
 * @returns Formatted string (e.g. "16.4 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Formats a number with locale-appropriate thousand separators.
 * @param n - The number to format
 * @returns Formatted string
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Safely formats a number with toFixed, returning a dash for non-finite values.
 * @param value - The number to format
 * @param digits - Number of decimal places
 * @returns Formatted string
 */
function safeFixed(value: number, digits: number): string {
  if (!isFinite(value)) return '\u2014';
  return value.toFixed(digits);
}

export function App(): preact.JSX.Element {
  const [state, setState] = useState<CaptureState>('idle');
  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [downloadsComplete, setDownloadsComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Config state
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [channelCount, setChannelCount] = useState<1 | 2>(2);
  const [maxBufferSize, setMaxBufferSize] = useState(5);

  // Recover state from background on popup open
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.capturing) {
        setState('capturing');
        if (response.stats) setStats(response.stats);
      }
    });
  }, []);

  // Listen for messages from background
  useEffect(() => {
    const listener = (msg: RelayMessage & { type: string; error?: string }): void => {
      if (msg.type === 'CAPTURE_STARTED') {
        setState('capturing');
        setError(null);
      } else if (msg.type === 'CAPTURE_STOPPED') {
        setState('stopping');
      } else if (msg.type === 'CAPTURE_STATS') {
        setStats(msg.stats);
      } else if (msg.type === 'DOWNLOADS_COMPLETE') {
        if (stopTimerRef.current) {
          clearTimeout(stopTimerRef.current);
          stopTimerRef.current = null;
        }
        setDownloadsComplete(true);
        setState('idle');
      } else if (msg.type === 'CAPTURE_ERROR') {
        setError(msg.error || 'Unknown error');
        setState('idle');
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleStart = useCallback(() => {
    const config: CaptureConfig = {
      sampleRate,
      channelCount,
      maxBufferSize,
    };

    setError(null);

    chrome.runtime.sendMessage({ type: 'START_CAPTURE', config }, (response) => {
      if (response && !response.success) {
        setError(response.error || 'Failed to start capture');
        setState('idle');
      }
    });
  }, [sampleRate, channelCount, maxBufferSize]);

  const handleStop = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    setState('stopping');

    // Timeout: if downloads don't complete within 15s, show error
    stopTimerRef.current = setTimeout(() => {
      setState('idle');
      setError('Stop timeout \u2014 files may not have been saved');
    }, STOP_TIMEOUT_MS);
  }, []);

  const handleDismissError = useCallback(() => {
    setError(null);
  }, []);

  const handleNewCapture = useCallback(() => {
    setDownloadsComplete(false);
    setStats(null);
    setError(null);
  }, []);

  return (
    <div class={styles.container}>
      <h1 class={styles.title}>PCM Capture PoC</h1>

      {error && (
        <div class={styles.errorPanel}>
          <div class={styles.errorText}>{error}</div>
          <button class={styles.dismissBtn} onClick={handleDismissError}>
            Dismiss
          </button>
        </div>
      )}

      {state === 'idle' && !downloadsComplete && !error && (
        <div class={styles.configPanel}>
          <label class={styles.field}>
            <span>Sample Rate</span>
            <select
              value={sampleRate === null ? '' : String(sampleRate)}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setSampleRate(v === '' ? null : Number(v));
              }}
            >
              {SAMPLE_RATES.map((sr) => (
                <option key={sr.label} value={sr.value === null ? '' : String(sr.value)}>
                  {sr.label}
                </option>
              ))}
            </select>
          </label>

          <label class={styles.field}>
            <span>Channels</span>
            <select
              value={String(channelCount)}
              onChange={(e) =>
                setChannelCount(Number((e.target as HTMLSelectElement).value) as 1 | 2)
              }
            >
              <option value="2">Stereo</option>
              <option value="1">Mono</option>
            </select>
          </label>

          <label class={styles.field}>
            <span>MSTP Buffer Size</span>
            <select
              value={String(maxBufferSize)}
              onChange={(e) => setMaxBufferSize(Number((e.target as HTMLSelectElement).value))}
            >
              {BUFFER_SIZES.map((bs) => (
                <option key={bs} value={String(bs)}>
                  {bs}
                </option>
              ))}
            </select>
          </label>

          <button class={styles.startBtn} onClick={handleStart}>
            Start Capture
          </button>
        </div>
      )}

      {state === 'capturing' && stats && (
        <div class={styles.statsPanel}>
          <table class={styles.statsTable}>
            <tbody>
              <tr>
                <td>Duration</td>
                <td>{safeFixed(stats.elapsedSec, 1)}s</td>
              </tr>
              <tr>
                <td>Frames</td>
                <td>{formatNumber(stats.totalFrames)}</td>
              </tr>
              <tr>
                <td>Gaps</td>
                <td>
                  {stats.gapCount} ({safeFixed(stats.totalGapMs, 1)}ms total)
                </td>
              </tr>
              <tr>
                <td>Zero blocks</td>
                <td>{stats.zeroBlockCount}</td>
              </tr>
              <tr>
                <td>Frame dur</td>
                <td>
                  {safeFixed(stats.frameDurationAvgMs, 2)}ms avg (
                  {safeFixed(stats.frameDurationMinMs, 2)}&ndash;
                  {safeFixed(stats.frameDurationMaxMs, 2)}ms)
                </td>
              </tr>
              <tr>
                <td>Process time</td>
                <td>
                  {safeFixed(stats.processingTimeAvgUs, 2)}us avg (
                  {safeFixed(stats.processingTimeMaxUs, 2)}us max)
                </td>
              </tr>
              <tr>
                <td>Sample rate</td>
                <td>{stats.actualSampleRate} Hz</td>
              </tr>
              <tr>
                <td>Channels</td>
                <td>{stats.actualChannels}</td>
              </tr>
              <tr>
                <td>PCM size</td>
                <td>{formatBytes(stats.accumulatedBytes)}</td>
              </tr>
            </tbody>
          </table>

          <button class={styles.stopBtn} onClick={handleStop}>
            Stop Capture
          </button>
        </div>
      )}

      {state === 'capturing' && !stats && <div class={styles.status}>Starting capture...</div>}

      {state === 'stopping' && <div class={styles.status}>Saving files...</div>}

      {downloadsComplete && state === 'idle' && (
        <div class={styles.donePanel}>
          <div class={styles.status}>Files saved</div>
          <button class={styles.startBtn} onClick={handleNewCapture}>
            New Capture
          </button>
        </div>
      )}
    </div>
  );
}
