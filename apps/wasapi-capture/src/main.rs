//! WASAPI process-specific loopback capture CLI.
//!
//! Captures audio from a specific process (Chrome/Brave) via WASAPI loopback,
//! writes Float32 WAV output compatible with `tools/capture-analysis/`.
//!
//! Requires Windows 10 build 20348 or later.

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Error: wasapi-capture is Windows-only.");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
fn main() {
    wasapi::run();
}

#[cfg(target_os = "windows")]
mod wasapi {
    use std::io::{BufWriter, Write};
    use std::mem::ManuallyDrop;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use clap::Parser;
    use serde::Serialize;
    use windows::core::{implement, IUnknown, Interface, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
        CreateEventW, SetEvent, WaitForSingleObject, AVRT_PRIORITY_HIGH,
    };
    use windows::Win32::System::Variant::VT_BLOB;
    use windows_core::AsImpl;

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

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

    /// AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM — tells Windows to convert to our
    /// requested format automatically.
    const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x80000000;

    /// Hard-coded capture format: Float32, 48 kHz, stereo.
    /// Process loopback clients return E_NOTIMPL from GetMixFormat(),
    /// so we specify the format ourselves and use AUTOCONVERTPCM.
    const CAPTURE_SAMPLE_RATE: u32 = 48000;
    const CAPTURE_CHANNELS: u16 = 2;
    const CAPTURE_BITS_PER_SAMPLE: u16 = 32;

    // ─── COM Completion Handler ──────────────────────────────────────────────

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct CompletionHandler {
        event: HANDLE,
        result: Mutex<Option<windows::core::Result<IAudioClient>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            activate_operation: windows_core::Ref<IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let client_result = (|| -> windows::core::Result<IAudioClient> {
                let mut hr = HRESULT(0);
                let mut activated: Option<IUnknown> = None;

                unsafe {
                    activate_operation
                        .as_ref()
                        .ok_or_else(|| windows::core::Error::from(HRESULT(-1)))?
                        .GetActivateResult(&mut hr, &mut activated)?
                };
                hr.ok()?;

                match activated {
                    Some(unk) => unk.cast::<IAudioClient>(),
                    None => Err(windows::core::Error::from(HRESULT(-1))),
                }
            })();

            *self.result.lock().unwrap() = Some(client_result);
            let _ = unsafe { SetEvent(self.event) };
            Ok(())
        }
    }

    // ─── Entry point ─────────────────────────────────────────────────────────

    pub fn run() {
        let cli = Cli::parse();

        check_windows_version();

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

        let sample_rate = CAPTURE_SAMPLE_RATE;
        let channels = CAPTURE_CHANNELS;

        eprintln!("WASAPI Capture");
        eprintln!("  PID:       {}", cli.pid);
        eprintln!("  Duration:  {:.1}s", cli.duration);
        eprintln!("  Buffer:    {}ms", cli.buffer_ms);
        eprintln!("  Format:    {}Hz, {}ch, Float32", sample_rate, channels);
        eprintln!("  Output:    {}", output_path.display());

        // ── COM init ─────────────────────────────────────────────────────────
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("Failed to initialize COM");

        // ── Activate audio client via process loopback ───────────────────────
        let audio_client = match activate_process_loopback(cli.pid) {
            Ok(client) => client,
            Err(e) => {
                eprintln!("Error: Failed to activate process loopback: {}", e);
                eprintln!("  HRESULT: 0x{:08X}", e.code().0 as u32);
                eprintln!("  Hints:");
                eprintln!("    - Try the main browser process PID (highest memory)");
                eprintln!("    - Ensure the process is running and producing audio");
                eprintln!("    - Process-specific loopback requires Windows 10 build 20348+");
                unsafe { CoUninitialize() };
                std::process::exit(1);
            }
        };

        // ── Build capture format ───────────────────────────────────────────
        let block_align = channels * (CAPTURE_BITS_PER_SAMPLE / 8);
        let avg_bytes_per_sec = sample_rate * block_align as u32;

        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: avg_bytes_per_sec,
            nBlockAlign: block_align,
            wBitsPerSample: CAPTURE_BITS_PER_SAMPLE,
            cbSize: 0,
        };

        // ── Initialize audio client ──────────────────────────────────────────
        let buffer_duration = (cli.buffer_ms as i64) * 10_000; // 100ns units
        let capture_event = unsafe {
            CreateEventW(None, false, false, None).expect("Failed to create capture event")
        };

        unsafe {
            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    buffer_duration,
                    0,
                    &format,
                    None,
                )
                .expect("IAudioClient::Initialize failed");

            audio_client
                .SetEventHandle(capture_event)
                .expect("SetEventHandle failed");
        }

        let capture_client: IAudioCaptureClient = unsafe {
            audio_client
                .GetService()
                .expect("GetService<IAudioCaptureClient> failed")
        };

        // ── Ctrl+C handler ───────────────────────────────────────────────────
        let running = Arc::new(AtomicBool::new(true));
        let r = running.clone();
        ctrlc::set_handler(move || {
            eprintln!("\nCtrl+C received, stopping...");
            r.store(false, Ordering::SeqCst);
        })
        .expect("Failed to set Ctrl+C handler");

        // ── Start capture ────────────────────────────────────────────────────
        unsafe { audio_client.Start().expect("IAudioClient::Start failed") };
        eprintln!("  Capturing...");

        // ── MMCSS elevation ──────────────────────────────────────────────────
        let mmcss_handle = elevate_thread_mmcss();

        let start_time = Instant::now();
        let estimated_samples =
            (cli.duration as usize + 1) * sample_rate as usize * channels as usize;
        let mut samples: Vec<f32> = Vec::with_capacity(estimated_samples);
        let estimated_callbacks =
            (cli.duration as usize + 1) * (1000 / cli.buffer_ms.max(1) as usize);
        let mut timing_deltas: Vec<f32> = Vec::with_capacity(estimated_callbacks);
        let mut last_callback = Instant::now();
        let mut discontinuity_count: u32 = 0;
        let mut silent_count: u32 = 0;
        let mut callback_count: u32 = 0;
        let mut total_frames: u64 = 0;

        // ── Capture loop ─────────────────────────────────────────────────────
        while running.load(Ordering::SeqCst) {
            let elapsed = start_time.elapsed().as_secs_f64();
            if elapsed >= cli.duration {
                break;
            }

            let wait_result = unsafe { WaitForSingleObject(capture_event, 200) };
            if wait_result != WAIT_OBJECT_0 {
                continue;
            }

            let now = Instant::now();
            timing_deltas.push((now - last_callback).as_secs_f32() * 1000.0);
            last_callback = now;

            // Drain all available packets
            loop {
                let mut buffer: *mut u8 = ptr::null_mut();
                let mut frames_available: u32 = 0;
                let mut flags: u32 = 0;

                let hr = unsafe {
                    capture_client.GetBuffer(
                        &mut buffer,
                        &mut frames_available,
                        &mut flags,
                        None,
                        None,
                    )
                };

                if hr.is_err() || frames_available == 0 {
                    break;
                }

                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    discontinuity_count += 1;
                    let elapsed_s = start_time.elapsed().as_secs_f64();
                    eprintln!("  DISCONTINUITY at {:.3}s", elapsed_s);
                }
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                    silent_count += 1;
                }

                let sample_count = frames_available as usize * channels as usize;
                if !buffer.is_null() && sample_count > 0 {
                    let src =
                        unsafe { std::slice::from_raw_parts(buffer as *const f32, sample_count) };
                    samples.extend_from_slice(src);
                }

                total_frames += frames_available as u64;
                callback_count += 1;

                unsafe {
                    let _ = capture_client.ReleaseBuffer(frames_available);
                }
            }
        }

        // ── Cleanup ──────────────────────────────────────────────────────────
        unsafe {
            let _ = audio_client.Stop();
        }
        revert_mmcss(mmcss_handle);

        let actual_duration = start_time.elapsed().as_secs_f64();
        let frames_expected = (actual_duration * sample_rate as f64) as u64;

        // ── Write outputs ────────────────────────────────────────────────────
        write_wav(&output_path, &samples, sample_rate, channels);
        write_timing_bin(&timing_path, &timing_deltas);

        let mut sorted_timing = timing_deltas.clone();
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
            frames_captured: total_frames,
            frames_expected,
            discontinuities: discontinuity_count,
            silent_buffers: silent_count,
            callbacks: callback_count,
            timing_p50_ms: p50,
            timing_p99_ms: p99,
            timing_max_ms: t_max,
        };
        let stats_json = serde_json::to_string_pretty(&stats).unwrap();
        std::fs::write(&stats_path, &stats_json).expect("Failed to write stats JSON");

        // ── Console report ───────────────────────────────────────────────────
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
        eprintln!("  Callbacks:        {}", callback_count);
        eprintln!("  Frames captured:  {}", format_number(total_frames));
        eprintln!("  Expected frames:  {}", format_number(frames_expected));
        eprintln!("  Discontinuities:  {}", discontinuity_count);
        eprintln!("  Silent buffers:   {}", silent_count);
        eprintln!(
            "  Timing:           p50={:.1}ms  p99={:.1}ms  max={:.1}ms",
            p50, p99, t_max
        );
        eprintln!("  Output:           {}", output_path.display());
        eprintln!("  Timing:           {}", timing_path.display());
        eprintln!("  Stats:            {}", stats_path.display());

        unsafe { CoUninitialize() };
    }

    // ─── Process loopback activation ─────────────────────────────────────────

    fn activate_process_loopback(pid: u32) -> windows::core::Result<IAudioClient> {
        unsafe {
            let event = CreateEventW(None, false, false, None)?;

            let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
                event,
                result: Mutex::new(None),
            }
            .into();

            let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: pid,
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            };

            let pinned_params = Pin::new(&mut params);

            // Build PROPVARIANT with VT_BLOB pointing to our activation params.
            let prop = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_BLOB,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            blob: BLOB {
                                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                                pBlobData: &*pinned_params as *const _ as *mut u8,
                            },
                        },
                    }),
                },
            };

            let activation_prop = ManuallyDrop::new(prop);

            let _async_op: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*activation_prop),
                &handler,
            )?;

            // Wait for completion (up to 5 seconds)
            let wait_result = WaitForSingleObject(event, 5000);
            if wait_result != WAIT_OBJECT_0 {
                return Err(windows::core::Error::from(HRESULT(-1)));
            }

            let inner: &CompletionHandler = handler.as_impl();
            let guard = inner.result.lock().unwrap();
            match guard.as_ref() {
                Some(Ok(client)) => Ok(client.clone()),
                Some(Err(e)) => Err(e.clone()),
                None => Err(windows::core::Error::from(HRESULT(-1))),
            }
        }
    }

    // ─── MMCSS ───────────────────────────────────────────────────────────────

    fn elevate_thread_mmcss() -> Option<HANDLE> {
        let task_name_wide: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
        let mut task_index: u32 = 0;

        let handle = unsafe {
            AvSetMmThreadCharacteristicsW(PCWSTR(task_name_wide.as_ptr()), &mut task_index)
        };

        match handle {
            Ok(h) => {
                if !h.is_invalid() {
                    eprintln!(
                        "  MMCSS: registered 'Pro Audio' (task index: {})",
                        task_index
                    );
                    let _ = unsafe { AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH) };
                    Some(h)
                } else {
                    eprintln!("  MMCSS: failed to register");
                    None
                }
            }
            Err(e) => {
                eprintln!("  MMCSS: unavailable ({})", e);
                None
            }
        }
    }

    fn revert_mmcss(handle: Option<HANDLE>) {
        if let Some(h) = handle {
            let _ = unsafe { AvRevertMmThreadCharacteristics(h) };
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fn check_windows_version() {
        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                "/v",
                "CurrentBuildNumber",
            ])
            .output();

        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(build_str) = text
                    .lines()
                    .find(|l| l.contains("CurrentBuildNumber"))
                    .and_then(|l| l.split_whitespace().last())
                {
                    if let Ok(build) = build_str.parse::<u32>() {
                        if build < 20348 {
                            eprintln!(
                                "Error: Process-specific loopback requires Windows 10 \
                                 build 20348+. Current build: {}.",
                                build
                            );
                            std::process::exit(1);
                        }
                        eprintln!("Windows build: {}", build);
                        return;
                    }
                }
                eprintln!("Warning: Could not parse Windows build number, proceeding anyway.");
            }
            Err(_) => {
                eprintln!("Warning: Could not query Windows version, proceeding anyway.");
            }
        }
    }

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

        // RIFF header
        w.write_all(b"RIFF").unwrap();
        w.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        w.write_all(b"WAVE").unwrap();

        // fmt sub-chunk (IEEE Float, tag = 3)
        w.write_all(b"fmt ").unwrap();
        w.write_all(&16u32.to_le_bytes()).unwrap();
        w.write_all(&WAVE_FORMAT_IEEE_FLOAT.to_le_bytes()).unwrap();
        w.write_all(&channels.to_le_bytes()).unwrap();
        w.write_all(&sample_rate.to_le_bytes()).unwrap();
        w.write_all(&byte_rate.to_le_bytes()).unwrap();
        w.write_all(&block_align.to_le_bytes()).unwrap();
        w.write_all(&bits_per_sample.to_le_bytes()).unwrap();

        // data sub-chunk
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
