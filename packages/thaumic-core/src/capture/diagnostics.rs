//! Diagnostics for captured audio: what the samples contain, and a tap that
//! writes them to disk.
//!
//! The pipeline's timing counters cannot tell a healthy stream from a
//! perfectly punctual stream of broken audio: a source that starves and
//! renders gaps still hands the capture the right number of samples at the
//! right time. These look at the samples themselves, and the tap keeps a copy
//! so a failed session can be listened to and measured afterwards.

use std::fmt;
use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::stream::AudioFormat;

/// Environment variable naming the directory captured audio is written to.
pub const CAPTURE_TAP_DIR_ENV: &str = "THAUMIC_CAPTURE_TAP_DIR";

/// Shortest run of exact digital silence inside a packet that otherwise
/// carries audio to count as a dropout. Two milliseconds is far longer than
/// any zero crossing and far shorter than a packet, so it catches a renderer
/// that missed part of its deadline without flagging quiet music.
const GAP_MIN_MS: u32 = 2;

/// How often content statistics are summarised.
const CONTENT_WINDOW: Duration = Duration::from_secs(5);

/// A summary of one statistics window.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContentSummary {
    /// Packets observed in the window.
    pub packets: u64,
    /// Packets in which every sample was exactly zero.
    pub silent_packets: u64,
    /// Packets carrying audio that also contained a run of silence of at
    /// least [`GAP_MIN_MS`]: a dropout inside the packet.
    pub gap_packets: u64,
    /// Packets identical to the packet before them (silence excluded).
    pub repeated_packets: u64,
    /// Samples at or beyond full scale.
    pub clipped_samples: u64,
    /// Largest absolute sample value.
    pub peak: f32,
    /// Root mean square over the window.
    pub rms: f32,
    /// Length of the window in seconds.
    pub window_secs: f32,
}

impl ContentSummary {
    /// Whether the window shows audio being delivered with holes in it: the
    /// source is producing gaps, which the timing counters cannot see.
    pub fn has_dropouts(&self) -> bool {
        self.gap_packets > 0 || (self.repeated_packets > 0 && self.rms > 0.01)
    }
}

impl fmt::Display for ContentSummary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "packets={}, peak={:.3}, rms={:.4}, gap_packets={}, repeated_packets={}, \
             silent_packets={}, clipped_samples={} over {:.1}s",
            self.packets,
            self.peak,
            self.rms,
            self.gap_packets,
            self.repeated_packets,
            self.silent_packets,
            self.clipped_samples,
            self.window_secs
        )
    }
}

/// Accumulates content statistics over successive windows.
pub(crate) struct ContentStats {
    window: Duration,
    window_started: Option<Instant>,
    packets: u64,
    silent_packets: u64,
    gap_packets: u64,
    repeated_packets: u64,
    clipped_samples: u64,
    peak: f32,
    sum_squares: f64,
    samples: u64,
    last_hash: Option<u64>,
}

impl ContentStats {
    /// Creates statistics summarised every [`CONTENT_WINDOW`].
    pub fn new() -> Self {
        Self::with_window(CONTENT_WINDOW)
    }

    /// Creates statistics summarised every `window`.
    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            window_started: None,
            packets: 0,
            silent_packets: 0,
            gap_packets: 0,
            repeated_packets: 0,
            clipped_samples: 0,
            peak: 0.0,
            sum_squares: 0.0,
            samples: 0,
            last_hash: None,
        }
    }

    /// Observes one packet of interleaved samples. Returns the summary of the
    /// window that has just closed, if this packet closed one.
    pub fn observe(
        &mut self,
        data: &[f32],
        channels: u16,
        sample_rate: u32,
    ) -> Option<ContentSummary> {
        let started = *self.window_started.get_or_insert_with(Instant::now);
        self.packets += 1;

        let gap_samples = (u64::from(GAP_MIN_MS) * u64::from(sample_rate) / 1000
            * u64::from(channels.max(1)))
        .max(1) as usize;
        let mut zero_run = 0usize;
        let mut longest_zero_run = 0usize;
        let mut any_audio = false;
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &sample in data {
            let magnitude = sample.abs();
            if magnitude > 0.0 {
                any_audio = true;
                zero_run = 0;
            } else {
                zero_run += 1;
                longest_zero_run = longest_zero_run.max(zero_run);
            }
            if magnitude >= 1.0 {
                self.clipped_samples += 1;
            }
            if magnitude > self.peak {
                self.peak = magnitude;
            }
            self.sum_squares += f64::from(sample) * f64::from(sample);
            // FNV-1a over the sample's bits, for repeat detection.
            hash ^= u64::from(sample.to_bits());
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        self.samples += data.len() as u64;

        if !any_audio {
            self.silent_packets += 1;
        } else {
            if longest_zero_run >= gap_samples {
                self.gap_packets += 1;
            }
            if self.last_hash == Some(hash) {
                self.repeated_packets += 1;
            }
        }
        self.last_hash = Some(hash);

        let elapsed = started.elapsed();
        if elapsed < self.window {
            return None;
        }
        let summary = ContentSummary {
            packets: self.packets,
            silent_packets: self.silent_packets,
            gap_packets: self.gap_packets,
            repeated_packets: self.repeated_packets,
            clipped_samples: self.clipped_samples,
            peak: self.peak,
            rms: if self.samples == 0 {
                0.0
            } else {
                (self.sum_squares / self.samples as f64).sqrt() as f32
            },
            window_secs: elapsed.as_secs_f32(),
        };
        self.window_started = Some(Instant::now());
        self.packets = 0;
        self.silent_packets = 0;
        self.gap_packets = 0;
        self.repeated_packets = 0;
        self.clipped_samples = 0;
        self.peak = 0.0;
        self.sum_squares = 0.0;
        self.samples = 0;
        Some(summary)
    }
}

/// The tap directory named by [`CAPTURE_TAP_DIR_ENV`], if set.
pub(crate) fn tap_dir_from_env() -> Option<PathBuf> {
    std::env::var_os(CAPTURE_TAP_DIR_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Writes PCM frames to a WAV file as they enter the pipeline.
///
/// Frames are handed to a writer thread over a channel, so the capture
/// thread, which runs at audio priority and must never block, does no disk
/// I/O. The header is written with placeholder sizes and patched when the tap
/// is dropped, so an interrupted session still leaves a readable file up to
/// the last flushed frame for any tool that ignores the declared length.
pub(crate) struct WavTap {
    sender: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    writer: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
}

impl WavTap {
    /// Creates `<dir>/capture-<stream_id>.wav` for `format` (16-bit PCM).
    pub fn open(dir: &Path, stream_id: &str, format: &AudioFormat) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("capture-{stream_id}.wav"));
        let mut file = BufWriter::new(File::create(&path)?);
        file.write_all(&wav_header(format, 0))?;

        let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let thread_path = path.clone();
        let writer = std::thread::Builder::new()
            .name("capture-tap".into())
            .spawn(move || {
                let mut data_bytes: u64 = 0;
                for frame in receiver {
                    if let Err(e) = file.write_all(&frame) {
                        log::warn!(
                            "[Capture] Capture tap {} failed, stopping it: {}",
                            thread_path.display(),
                            e
                        );
                        break;
                    }
                    data_bytes += frame.len() as u64;
                }
                if let Err(e) = finish_wav(&mut file, data_bytes) {
                    log::warn!(
                        "[Capture] Could not finalise tap {}: {}",
                        thread_path.display(),
                        e
                    );
                }
            })?;

        Ok(Self {
            sender: Some(sender),
            writer: Some(writer),
            path,
        })
    }

    /// Where the file is being written.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Queues one frame for the writer thread. Fails once the writer has
    /// stopped, after which the caller should drop the tap.
    pub fn write(&mut self, frame: &[u8]) -> io::Result<()> {
        match self.sender.as_ref() {
            Some(sender) => sender
                .send(frame.to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "capture tap stopped")),
            None => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "capture tap closed",
            )),
        }
    }
}

impl Drop for WavTap {
    fn drop(&mut self) {
        // Closing the channel ends the writer's loop; joining it waits for the
        // header to be patched so the file is complete when this returns.
        drop(self.sender.take());
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

/// Flushes the file and patches the RIFF and data sizes in its header.
fn finish_wav(file: &mut BufWriter<File>, data_bytes: u64) -> io::Result<()> {
    file.flush()?;
    let inner = file.get_mut();
    let data = u32::try_from(data_bytes).unwrap_or(u32::MAX);
    inner.seek(SeekFrom::Start(4))?;
    inner.write_all(&(36u32.saturating_add(data)).to_le_bytes())?;
    inner.seek(SeekFrom::Start(40))?;
    inner.write_all(&data.to_le_bytes())?;
    inner.flush()
}

/// A 44-byte canonical WAV header for 16-bit PCM with `data_bytes` of audio.
fn wav_header(format: &AudioFormat, data_bytes: u32) -> [u8; 44] {
    let channels = format.channels;
    let bits = 16u16;
    let block_align = channels * (bits / 8);
    let byte_rate = format.sample_rate * u32::from(block_align);
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36u32.saturating_add(data_bytes)).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&format.sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&bits.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(samples: usize, value: f32) -> Vec<f32> {
        vec![value; samples]
    }

    /// A stats window that closes on the next packet.
    fn immediate() -> ContentStats {
        ContentStats::with_window(Duration::ZERO)
    }

    #[test]
    fn a_silent_packet_is_silent_not_a_dropout() {
        let mut stats = immediate();
        let summary = stats.observe(&packet(960, 0.0), 2, 48_000).expect("window");
        assert_eq!(summary.silent_packets, 1);
        assert_eq!(summary.gap_packets, 0);
        assert!(!summary.has_dropouts());
    }

    #[test]
    fn a_zero_run_inside_audio_is_a_dropout() {
        // 10 ms stereo at 48 kHz: 960 samples. A 3 ms hole is 288 samples.
        let mut data = packet(960, 0.25);
        for s in &mut data[300..588] {
            *s = 0.0;
        }
        let mut stats = immediate();
        let summary = stats.observe(&data, 2, 48_000).expect("window");
        assert_eq!(summary.gap_packets, 1);
        assert!(summary.has_dropouts());
    }

    #[test]
    fn a_zero_crossing_is_not_a_dropout() {
        // A 1 ms run of zeros (96 samples) is below the threshold.
        let mut data = packet(960, 0.25);
        for s in &mut data[400..496] {
            *s = 0.0;
        }
        let mut stats = immediate();
        let summary = stats.observe(&data, 2, 48_000).expect("window");
        assert_eq!(summary.gap_packets, 0);
    }

    #[test]
    fn an_identical_packet_is_a_repeat_but_repeated_silence_is_not() {
        let mut stats = ContentStats::with_window(Duration::from_secs(3600));
        let tone: Vec<f32> = (0..960).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        assert!(stats.observe(&tone, 2, 48_000).is_none());
        assert!(stats.observe(&tone, 2, 48_000).is_none());
        assert!(stats.observe(&packet(960, 0.0), 2, 48_000).is_none());
        assert!(stats.observe(&packet(960, 0.0), 2, 48_000).is_none());
        assert_eq!(stats.repeated_packets, 1);
        assert_eq!(stats.silent_packets, 2);
    }

    #[test]
    fn peak_rms_and_clipping_are_measured() {
        let mut data = packet(4, 0.5);
        data[0] = 1.0;
        data[1] = -1.5;
        let mut stats = immediate();
        let summary = stats.observe(&data, 2, 48_000).expect("window");
        assert_eq!(summary.clipped_samples, 2);
        assert!((summary.peak - 1.5).abs() < 1e-6);
        let expected_rms = ((1.0f64 + 2.25 + 0.25 + 0.25) / 4.0).sqrt() as f32;
        assert!((summary.rms - expected_rms).abs() < 1e-5);
    }

    #[test]
    fn the_tap_writes_a_wav_whose_sizes_are_patched_on_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let format = AudioFormat::new(48_000, 2, 16);
        {
            let mut tap = WavTap::open(dir.path(), "abc", &format).expect("open");
            tap.write(&[1u8; 1920]).expect("write");
            tap.write(&[2u8; 1920]).expect("write");
            assert!(tap.path().ends_with("capture-abc.wav"));
        }
        let bytes = std::fs::read(dir.path().join("capture-abc.wav")).expect("read");
        assert_eq!(bytes.len(), 44 + 3840);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            36 + 3840
        );
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(
            u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
            192_000
        );
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 3840);
        assert_eq!(bytes[44], 1);
        assert_eq!(bytes[44 + 1920], 2);
    }
}
