//! WASAPI process-specific loopback capture source.
//!
//! Captures audio from a specific process via WASAPI loopback on Windows.
//! Requires Windows 10 build 20348 or later.

use std::mem::ManuallyDrop;
use std::pin::Pin;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use thaumic_core::capture::{AudioSink, AudioSource, BufferFlags, CaptureError, CaptureHandle};
use thaumic_core::stream::AudioFormat;
use tokio_util::sync::CancellationToken;
use windows::core::{implement, IUnknown, Interface, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
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

use std::sync::Mutex;

const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_PCM: u16 = 0x0001;

/// AUDCLNT_E_ALREADY_INITIALIZED
const E_ALREADY_INITIALIZED: u32 = 0x88890002;
/// AUDCLNT_E_DEVICE_INVALIDATED
const E_DEVICE_INVALIDATED: u32 = 0x88890004;

// ─── COM Completion Handler ─────────────────────────────────────────────────

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

// ─── WasapiSource ───────────────────────────────────────────────────────────

/// Single-use WASAPI process loopback capture source.
///
/// Create a new instance for each capture session.
pub struct WasapiSource {
    pid: u32,
    buffer_ms: u32,
    started: AtomicBool,
}

impl WasapiSource {
    /// Create a new WASAPI source targeting the given process ID.
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            buffer_ms: 10,
            started: AtomicBool::new(false),
        }
    }

    /// Set the WASAPI buffer size in milliseconds.
    pub fn with_buffer_ms(mut self, ms: u32) -> Self {
        self.buffer_ms = ms;
        self
    }
}

impl AudioSource for WasapiSource {
    fn start(&self, sink: Arc<dyn AudioSink>) -> Result<CaptureHandle, CaptureError> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(CaptureError::AlreadyStarted);
        }

        let (error_tx, error_rx) = tokio::sync::mpsc::channel(8);
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        let pid = self.pid;
        let buffer_ms = self.buffer_ms;

        let join_handle = std::thread::Builder::new()
            .name("wasapi-capture".to_string())
            .spawn(move || {
                capture_thread(pid, buffer_ms, sink, cancel_clone, error_tx);
            })
            .map_err(|e| CaptureError::ThreadSpawn(e.to_string()))?;

        Ok(CaptureHandle::new(error_rx, cancel, join_handle))
    }

    fn name(&self) -> &str {
        "WASAPI Process Loopback"
    }

    fn format(&self) -> AudioFormat {
        AudioFormat {
            sample_rate: 48000,
            channels: 2,
            bits_per_sample: 32,
        }
    }
}

// ─── Capture Thread ─────────────────────────────────────────────────────────

fn capture_thread(
    pid: u32,
    buffer_ms: u32,
    sink: Arc<dyn AudioSink>,
    cancel: CancellationToken,
    error_tx: tokio::sync::mpsc::Sender<CaptureError>,
) {
    // 1. COM init
    if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        log::error!("Failed to initialize COM: {}", e);
        let _ = error_tx.try_send(CaptureError::Platform(format!("COM init failed: {}", e)));
        return;
    }

    let result = capture_thread_inner(pid, buffer_ms, sink, &cancel, &error_tx);

    // COM cleanup (always runs)
    unsafe { CoUninitialize() };

    if let Err(e) = result {
        log::error!("Capture thread error: {}", e);
        let _ = error_tx.try_send(e);
    }
}

fn capture_thread_inner(
    pid: u32,
    buffer_ms: u32,
    sink: Arc<dyn AudioSink>,
    cancel: &CancellationToken,
    _error_tx: &tokio::sync::mpsc::Sender<CaptureError>,
) -> Result<(), CaptureError> {
    // 2. Activate process loopback
    let audio_client = activate_process_loopback(pid)
        .map_err(|e| CaptureError::Platform(format!("Loopback activation failed: {}", e)))?;

    // 3. Initialize with format/flag trial
    let buffer_duration = (buffer_ms as i64) * 10_000; // 100ns units
    let (audio_client, use_event, channels, sample_rate) =
        initialize_audio_client(audio_client, buffer_duration, pid)?;

    log::info!(
        "WASAPI capture initialized: {}Hz, {}ch, buffer={}ms, event={}",
        sample_rate, channels, buffer_ms, use_event
    );

    // Create capture event if using event-driven mode
    let capture_event = if use_event {
        let evt = unsafe {
            CreateEventW(None, false, false, None)
                .map_err(|e| CaptureError::Platform(format!("CreateEvent failed: {}", e)))?
        };
        unsafe {
            audio_client
                .SetEventHandle(evt)
                .map_err(|e| CaptureError::Platform(format!("SetEventHandle failed: {}", e)))?;
        }
        Some(evt)
    } else {
        None
    };

    let capture_client: IAudioCaptureClient = unsafe {
        audio_client
            .GetService()
            .map_err(|e| CaptureError::Platform(format!("GetService failed: {}", e)))?
    };

    // 4. MMCSS elevation
    // Note: MMCSS code is duplicated from streaming_runtime.rs because that module uses
    // windows-sys 0.61, while this crate uses windows 0.62. The types are incompatible
    // and cannot be shared. Both implementations are small (~30 lines) and stable.
    let mmcss_handle = elevate_thread_mmcss();

    // 5. Start capture
    unsafe {
        audio_client
            .Start()
            .map_err(|e| CaptureError::Platform(format!("IAudioClient::Start failed: {}", e)))?;
    }

    log::info!("WASAPI capture started for PID {}", pid);

    // 6. Capture loop
    let poll_interval = std::time::Duration::from_millis((buffer_ms / 2).max(1) as u64);

    while !cancel.is_cancelled() {
        if let Some(evt) = capture_event {
            let wait_result = unsafe { WaitForSingleObject(evt, 200) };
            if wait_result != WAIT_OBJECT_0 {
                continue;
            }
        } else {
            std::thread::sleep(poll_interval);
        }

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

            match hr {
                Ok(()) => {}
                Err(e) => {
                    let code = e.code().0 as u32;
                    if code == E_DEVICE_INVALIDATED {
                        log::warn!("Audio device invalidated during capture");
                        // Cleanup before returning
                        let _ = unsafe { audio_client.Stop() };
                        revert_mmcss(mmcss_handle);
                        if let Some(evt) = capture_event {
                            let _ = unsafe { CloseHandle(evt) };
                        }
                        return Err(CaptureError::DeviceDisconnected);
                    }
                    // No more data available, break inner loop
                    break;
                }
            }

            if frames_available == 0 {
                break;
            }

            let buf_flags = BufferFlags {
                discontinuity: flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0,
                silent: flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0,
            };

            if buf_flags.discontinuity {
                log::warn!("WASAPI discontinuity detected");
            }

            let sample_count = frames_available as usize * channels as usize;
            if !buffer.is_null() && sample_count > 0 {
                let src =
                    unsafe { std::slice::from_raw_parts(buffer as *const f32, sample_count) };
                sink.push_audio(src, frames_available, channels, buf_flags);
            }

            unsafe {
                let _ = capture_client.ReleaseBuffer(frames_available);
            }
        }
    }

    // 7. Cleanup
    let _ = unsafe { audio_client.Stop() };
    revert_mmcss(mmcss_handle);
    if let Some(evt) = capture_event {
        let _ = unsafe { CloseHandle(evt) };
    }

    log::info!("WASAPI capture stopped for PID {}", pid);
    Ok(())
}

// ─── Audio Client Initialization ────────────────────────────────────────────

/// Try multiple format + flag combinations.
/// Returns (initialized_client, use_event, channels, sample_rate).
///
/// On `AUDCLNT_E_ALREADY_INITIALIZED`, re-activates a fresh `IAudioClient` and retries.
fn initialize_audio_client(
    client: IAudioClient,
    buffer_duration: i64,
    pid: u32,
) -> Result<(IAudioClient, bool, u16, u32), CaptureError> {
    let fmt_float32_48k = make_waveformat(WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 32);
    let fmt_float32_44k = make_waveformat(WAVE_FORMAT_IEEE_FLOAT, 2, 44100, 32);
    let fmt_pcm16_48k = make_waveformat(WAVE_FORMAT_PCM, 2, 48000, 16);
    let fmt_pcm16_44k = make_waveformat(WAVE_FORMAT_PCM, 2, 44100, 16);

    let flag_combos: &[(u32, &str)] = &[
        (
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            "LOOPBACK|EVENTCALLBACK",
        ),
        (AUDCLNT_STREAMFLAGS_LOOPBACK, "LOOPBACK"),
        (AUDCLNT_STREAMFLAGS_EVENTCALLBACK, "EVENTCALLBACK"),
        (0, "none"),
    ];

    let formats: &[(&WAVEFORMATEX, u16, u32, u16)] = &[
        (&fmt_float32_48k, 2, 48000, 32),
        (&fmt_float32_44k, 2, 44100, 32),
        (&fmt_pcm16_48k, 2, 48000, 16),
        (&fmt_pcm16_44k, 2, 44100, 16),
    ];

    let mut current_client = client;
    let mut need_reactivate = false;

    for &(fmt, channels, sample_rate, _bits) in formats {
        for &(flags, flag_desc) in flag_combos {
            if need_reactivate {
                current_client = activate_process_loopback(pid)
                    .map_err(|e| CaptureError::Platform(format!("Re-activation failed: {}", e)))?;
                need_reactivate = false;
            }

            let hr = unsafe {
                current_client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    flags,
                    buffer_duration,
                    0,
                    fmt,
                    None,
                )
            };

            match hr {
                Ok(()) => {
                    let use_event = (flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK) != 0;
                    log::info!("WASAPI initialized with flags={}", flag_desc);
                    return Ok((current_client, use_event, channels, sample_rate));
                }
                Err(e) => {
                    let code = e.code().0 as u32;
                    log::debug!(
                        "Initialize failed: flags={} → 0x{:08X}",
                        flag_desc, code
                    );
                    if code == E_ALREADY_INITIALIZED {
                        // Client is permanently dead, need fresh one
                        need_reactivate = true;
                    }
                }
            }
        }
    }

    Err(CaptureError::UnsupportedFormat)
}

// ─── Process Loopback Activation ────────────────────────────────────────────

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

        // Close activation event handle to prevent leak
        let _ = CloseHandle(event);

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

// ─── MMCSS ──────────────────────────────────────────────────────────────────

fn elevate_thread_mmcss() -> Option<HANDLE> {
    let task_name_wide: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
    let mut task_index: u32 = 0;

    let handle = unsafe {
        AvSetMmThreadCharacteristicsW(PCWSTR(task_name_wide.as_ptr()), &mut task_index)
    };

    match handle {
        Ok(h) => {
            if !h.is_invalid() {
                log::info!(
                    "MMCSS: registered 'Pro Audio' (task index: {})",
                    task_index
                );
                let _ = unsafe { AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH) };
                Some(h)
            } else {
                log::warn!("MMCSS: failed to register");
                None
            }
        }
        Err(e) => {
            log::warn!("MMCSS: unavailable ({})", e);
            None
        }
    }
}

fn revert_mmcss(handle: Option<HANDLE>) {
    if let Some(h) = handle {
        let _ = unsafe { AvRevertMmThreadCharacteristics(h) };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn make_waveformat(tag: u16, channels: u16, sample_rate: u32, bits: u16) -> WAVEFORMATEX {
    let block_align = channels * (bits / 8);
    WAVEFORMATEX {
        wFormatTag: tag,
        nChannels: channels,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}
