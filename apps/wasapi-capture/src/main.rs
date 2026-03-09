//! WASAPI process-specific loopback capture CLI.
//!
//! Diagnostic tool that uses `thaumic-capture` to capture audio from a specific
//! process and writes Float32 WAV output compatible with `tools/capture-analysis/`.
//!
//! Requires Windows 10 build 20348 or later.

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Error: wasapi-capture is Windows-only.");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
fn main() {
    cli::run();
}

#[cfg(target_os = "windows")]
mod cli {
    use std::io::{BufWriter, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use clap::Parser;
    use serde::Serialize;
    use thaumic_core::capture::{AudioSink, BufferFlags};

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

    /// WASAPI process-specific loopback capture for validating frame-drop-free audio.
    #[derive(Parser)]
    #[command(name = "wasapi-capture")]
    struct Cli {
        /// Target process ID (Chrome/Brave)
        #[arg(long)]
        pid: u32,

        /// Capture duration in seconds
        #[arg(long, default_value = "60")]
        duration: f64,

        /// Output WAV path
        #[arg(long)]
        output: Option<PathBuf>,

        /// WASAPI buffer size in ms
        #[arg(long, default_value = "10")]
        buffer_ms: u32,

        /// Output JSON stats path
        #[arg(long)]
        stats_file: Option<PathBuf>,
    }

    #[derive(Serialize)]
    struct CaptureStats {
        pid: u32,
        duration_sec: f64,
        sample_rate: u32,
        channels: u16,
        format: String,
        buffer_ms: u32,
        frames_captured: u64,
        frames_expected: u64,
        discontinuities: u32,
        silent_buffers: u32,
        callbacks: u32,
        timing_p50_ms: f32,
        timing_p99_ms: f32,
        timing_max_ms: f32,
    }

    /// Diagnostic sink that collects Float32 samples and timing for analysis.
    struct DiagnosticSink {
        samples: Mutex<Vec<f32>>,
        timing: Mutex<TimingState>,
    }

    struct TimingState {
        deltas: Vec<f32>,
        last_callback: Instant,
        discontinuities: u32,
        silent_buffers: u32,
        callbacks: u32,
        total_frames: u64,
    }

    impl DiagnosticSink {
        fn new(estimated_samples: usize, estimated_callbacks: usize) -> Self {
            Self {
                samples: Mutex::new(Vec::with_capacity(estimated_samples)),
                timing: Mutex::new(TimingState {
                    deltas: Vec::with_capacity(estimated_callbacks),
                    last_callback: Instant::now(),
                    discontinuities: 0,
                    silent_buffers: 0,
                    callbacks: 0,
                    total_frames: 0,
                }),
            }
        }
    }

    impl AudioSink for DiagnosticSink {
        fn push_audio(&self, data: &[f32], frames: u32, _channels: u16, flags: BufferFlags) {
            // Record timing and flags
            {
                let mut timing = self.timing.lock().unwrap();
                let now = Instant::now();
                timing
                    .deltas
                    .push((now - timing.last_callback).as_secs_f32() * 1000.0);
                timing.last_callback = now;
                timing.callbacks += 1;
                timing.total_frames += frames as u64;
                if flags.discontinuity {
                    timing.discontinuities += 1;
                    let elapsed = timing.deltas.len() as f32 * 10.0 / 1000.0;
                    eprintln!("  DISCONTINUITY at ~{:.3}s", elapsed);
                }
                if flags.silent {
                    timing.silent_buffers += 1;
                }
            }

            // Accumulate samples
            self.samples.lock().unwrap().extend_from_slice(data);
        }
    }

    pub fn run() {
        env_logger::init();
        let cli = Cli::parse();

        if !thaumic_capture::wasapi_available() {
            eprintln!("Error: WASAPI process loopback requires Windows 10 build 20348+.");
            std::process::exit(1);
        }

        let output_path = cli.output.unwrap_or_else(default_output_path);
        let stem = output_path
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let parent = output_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let timing_path = parent.join(format!("{}-timing.bin", stem));
        let stats_path = cli
            .stats_file
            .unwrap_or_else(|| parent.join(format!("{}-stats.json", stem)));

        eprintln!("WASAPI Capture (library mode)");
        eprintln!("  PID:       {}", cli.pid);
        eprintln!("  Duration:  {:.1}s", cli.duration);
        eprintln!("  Buffer:    {}ms", cli.buffer_ms);
        eprintln!("  Output:    {}", output_path.display());

        // Create source from library
        let source = thaumic_capture::WasapiSource::new(cli.pid).with_buffer_ms(cli.buffer_ms);

        // Pre-allocate diagnostic sink
        let sample_rate = 48000u32;
        let channels = 2u16;
        let estimated_samples =
            (cli.duration as usize + 1) * sample_rate as usize * channels as usize;
        let estimated_callbacks =
            (cli.duration as usize + 1) * (1000 / cli.buffer_ms.max(1) as usize);
        let sink = Arc::new(DiagnosticSink::new(estimated_samples, estimated_callbacks));

        // Start capture
        let handle = match source.start(sink.clone()) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("Error: Failed to start capture: {}", e);
                std::process::exit(1);
            }
        };

        // Ctrl+C handler
        let running = Arc::new(AtomicBool::new(true));
        let r = running.clone();
        ctrlc::set_handler(move || {
            eprintln!("\nCtrl+C received, stopping...");
            r.store(false, Ordering::SeqCst);
        })
        .expect("Failed to set Ctrl+C handler");

        eprintln!("  Capturing...");
        let start_time = Instant::now();

        // Wait for duration or Ctrl+C
        let poll = std::time::Duration::from_millis(100);
        while running.load(Ordering::SeqCst) {
            if start_time.elapsed().as_secs_f64() >= cli.duration {
                break;
            }
            std::thread::sleep(poll);
        }

        // Stop and wait for cleanup
        handle.stop_and_wait();

        let actual_duration = start_time.elapsed().as_secs_f64();
        let frames_expected = (actual_duration * sample_rate as f64) as u64;

        // Extract data from sink
        let samples = sink.samples.lock().unwrap();
        let timing = sink.timing.lock().unwrap();

        // Write outputs
        write_wav(&output_path, &samples, sample_rate, channels);
        write_timing_bin(&timing_path, &timing.deltas);

        let mut sorted_timing = timing.deltas.clone();
        sorted_timing.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p50 = percentile(&sorted_timing, 50.0);
        let p99 = percentile(&sorted_timing, 99.0);
        let t_max = sorted_timing.last().copied().unwrap_or(0.0);

        let stats = CaptureStats {
            pid: cli.pid,
            duration_sec: actual_duration,
            sample_rate,
            channels,
            format: "Float32".to_string(),
            buffer_ms: cli.buffer_ms,
            frames_captured: timing.total_frames,
            frames_expected,
            discontinuities: timing.discontinuities,
            silent_buffers: timing.silent_buffers,
            callbacks: timing.callbacks,
            timing_p50_ms: p50,
            timing_p99_ms: p99,
            timing_max_ms: t_max,
        };
        let stats_json = serde_json::to_string_pretty(&stats).unwrap();
        std::fs::write(&stats_path, &stats_json).expect("Failed to write stats JSON");

        // Console report
        let buffer_samples = sample_rate * cli.buffer_ms / 1000;
        eprintln!();
        eprintln!("═══ WASAPI Capture Report ═══");
        eprintln!("  PID:              {}", cli.pid);
        eprintln!("  Duration:         {:.2}s", actual_duration);
        eprintln!(
            "  Format:           {}Hz, {}ch, Float32",
            sample_rate, channels
        );
        eprintln!(
            "  Buffer size:      {}ms ({} samples)",
            cli.buffer_ms, buffer_samples
        );
        eprintln!("  Callbacks:        {}", timing.callbacks);
        eprintln!(
            "  Frames captured:  {}",
            format_number(timing.total_frames)
        );
        eprintln!("  Expected frames:  {}", format_number(frames_expected));
        eprintln!("  Discontinuities:  {}", timing.discontinuities);
        eprintln!("  Silent buffers:   {}", timing.silent_buffers);
        eprintln!(
            "  Timing:           p50={:.1}ms  p99={:.1}ms  max={:.1}ms",
            p50, p99, t_max
        );
        eprintln!("  Output:           {}", output_path.display());
        eprintln!("  Timing:           {}", timing_path.display());
        eprintln!("  Stats:            {}", stats_path.display());
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    fn default_output_path() -> PathBuf {
        let ts = chrono_like_timestamp();
        PathBuf::from(format!("capture-wasapi-{}.wav", ts))
    }

    fn chrono_like_timestamp() -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let secs_per_day = 86400u64;
        let days = now / secs_per_day;
        let time_of_day = now % secs_per_day;
        let hours = time_of_day / 3600;
        let minutes = (time_of_day % 3600) / 60;
        let seconds = time_of_day % 60;
        let (year, month, day) = days_to_ymd(days);
        format!(
            "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
            year, month, day, hours, minutes, seconds
        )
    }

    fn days_to_ymd(days: u64) -> (u64, u64, u64) {
        let z = days + 719468;
        let era = z / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        (y, m, d)
    }

    fn percentile(sorted: &[f32], p: f64) -> f32 {
        if sorted.is_empty() {
            return 0.0;
        }
        let idx = (p / 100.0) * (sorted.len() - 1) as f64;
        let lo = idx.floor() as usize;
        let hi = idx.ceil() as usize;
        if lo == hi {
            sorted[lo]
        } else {
            let frac = idx - lo as f64;
            sorted[lo] * (1.0 - frac as f32) + sorted[hi] * frac as f32
        }
    }

    fn write_wav(path: &std::path::Path, samples: &[f32], sample_rate: u32, channels: u16) {
        let bits_per_sample: u16 = 32;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * block_align as u32;
        let data_size = (samples.len() * 4) as u32;

        let file = std::fs::File::create(path).expect("Failed to create WAV file");
        let mut w = BufWriter::new(file);

        w.write_all(b"RIFF").unwrap();
        w.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        w.write_all(b"WAVE").unwrap();

        w.write_all(b"fmt ").unwrap();
        w.write_all(&16u32.to_le_bytes()).unwrap();
        w.write_all(&WAVE_FORMAT_IEEE_FLOAT.to_le_bytes()).unwrap();
        w.write_all(&channels.to_le_bytes()).unwrap();
        w.write_all(&sample_rate.to_le_bytes()).unwrap();
        w.write_all(&byte_rate.to_le_bytes()).unwrap();
        w.write_all(&block_align.to_le_bytes()).unwrap();
        w.write_all(&bits_per_sample.to_le_bytes()).unwrap();

        w.write_all(b"data").unwrap();
        w.write_all(&data_size.to_le_bytes()).unwrap();

        let byte_slice =
            unsafe { std::slice::from_raw_parts(samples.as_ptr() as *const u8, samples.len() * 4) };
        w.write_all(byte_slice).unwrap();
        w.flush().unwrap();
    }

    fn write_timing_bin(path: &std::path::Path, deltas: &[f32]) {
        let file = std::fs::File::create(path).expect("Failed to create timing file");
        let mut w = BufWriter::new(file);
        let byte_slice =
            unsafe { std::slice::from_raw_parts(deltas.as_ptr() as *const u8, deltas.len() * 4) };
        w.write_all(byte_slice).unwrap();
        w.flush().unwrap();
    }

    fn format_number(n: u64) -> String {
        let s = n.to_string();
        let mut result = String::new();
        for (i, ch) in s.chars().rev().enumerate() {
            if i > 0 && i % 3 == 0 {
                result.push(',');
            }
            result.push(ch);
        }
        result.chars().rev().collect()
    }
}
