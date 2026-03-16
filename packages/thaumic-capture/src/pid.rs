//! Browser process discovery for WASAPI process-tree capture.
//!
//! Enumerates processes via `CreateToolhelp32Snapshot` and finds the root
//! browser PID for process-tree loopback capture.

use std::collections::HashMap;

use thaumic_core::capture::CaptureError;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Known Chromium-based browsers for WASAPI process-tree capture.
///
/// **Limitation:** Only these three browsers are supported. Firefox, Opera, Vivaldi,
/// Arc, etc. are excluded because they haven't been tested with WASAPI process-tree
/// loopback. To add a browser, append its process name (e.g., `"vivaldi.exe"`)
/// and verify capture works end-to-end.
const KNOWN_BROWSERS: &[&str] = &["chrome.exe", "brave.exe", "msedge.exe"];

/// Maximum parent-walk depth to prevent cycles from PID reuse.
const MAX_WALK_DEPTH: usize = 10;

/// A detected browser process.
#[derive(Debug, Clone)]
pub struct BrowserProcess {
    /// The root process ID (topmost browser process in the tree).
    pub pid: u32,
    /// The executable name (e.g., "chrome.exe").
    pub name: String,
}

/// Find all running browser processes suitable for WASAPI process-tree capture.
///
/// Returns unique root PIDs for each detected browser. The root PID is found by
/// walking the parent chain to the topmost process with the same executable name.
/// `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` captures the entire tree
/// including the Audio Service utility process, so the root PID is correct.
pub fn find_browser_pids() -> Vec<BrowserProcess> {
    let processes = match enumerate_processes() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to enumerate processes: {}", e);
            return Vec::new();
        }
    };

    let mut seen_roots = std::collections::HashSet::new();
    let mut results = Vec::new();

    for (pid, info) in &processes {
        if !KNOWN_BROWSERS.iter().any(|b| info.exe_name_lower == *b) {
            continue;
        }

        let root_pid = walk_to_root(*pid, &info.exe_name_lower, &processes);
        if seen_roots.insert(root_pid) {
            results.push(BrowserProcess {
                pid: root_pid,
                name: info.exe_name.clone(),
            });
        }
    }

    // Sort by PID ascending for deterministic results (lowest PID = oldest process)
    results.sort_by_key(|b| b.pid);
    results
}

/// Find browser PID for a specific browser executable name.
///
/// Returns the root PID of the matching browser process (lowest PID if multiple).
pub fn find_browser_pid_by_name(exe_name: &str) -> Result<u32, CaptureError> {
    let processes = enumerate_processes()
        .map_err(|e| CaptureError::Platform(format!("Process enumeration failed: {}", e)))?;

    let exe_lower = exe_name.to_lowercase();
    let mut seen_roots = std::collections::HashSet::new();
    let mut root_pids = Vec::new();

    for (pid, info) in &processes {
        if info.exe_name_lower != exe_lower {
            continue;
        }

        let root_pid = walk_to_root(*pid, &info.exe_name_lower, &processes);
        if seen_roots.insert(root_pid) {
            root_pids.push(root_pid);
        }
    }

    // Pick lowest PID for deterministic results (lowest = oldest process)
    root_pids.sort();
    root_pids.first().copied().ok_or_else(|| {
        CaptureError::Platform(format!("No running process found for '{}'", exe_name))
    })
}

struct ProcessInfo {
    /// Original exe name (mixed case, for display).
    exe_name: String,
    /// Lowercased exe name (for comparisons — normalized once at enumeration).
    exe_name_lower: String,
    parent_pid: u32,
}

/// Walk up the parent chain to find the topmost process with the same executable name.
/// `exe_name_lower` must already be lowercased.
fn walk_to_root(
    start_pid: u32,
    exe_name_lower: &str,
    processes: &HashMap<u32, ProcessInfo>,
) -> u32 {
    let mut current = start_pid;

    for _ in 0..MAX_WALK_DEPTH {
        let Some(info) = processes.get(&current) else {
            break;
        };

        let parent = info.parent_pid;
        if parent == 0 || parent == current {
            break;
        }

        // Verify parent has the same executable name
        let Some(parent_info) = processes.get(&parent) else {
            break;
        };

        if parent_info.exe_name_lower != exe_name_lower {
            break;
        }

        current = parent;
    }

    current
}

/// RAII wrapper for a Windows HANDLE that calls CloseHandle on drop.
struct HandleGuard(windows::Win32::Foundation::HANDLE);

impl Drop for HandleGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Enumerate all running processes via CreateToolhelp32Snapshot.
fn enumerate_processes() -> Result<HashMap<u32, ProcessInfo>, String> {
    let snapshot = HandleGuard(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|e| format!("CreateToolhelp32Snapshot failed: {}", e))?,
    );

    let mut result = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let ok = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    if ok.is_err() {
        return Err("Process32First failed".to_string());
    }

    loop {
        let exe_name = String::from_utf16_lossy(
            &entry.szExeFile[..entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len())],
        );

        let exe_name_lower = exe_name.to_lowercase();
        result.insert(
            entry.th32ProcessID,
            ProcessInfo {
                exe_name,
                exe_name_lower,
                parent_pid: entry.th32ParentProcessID,
            },
        );

        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }

    Ok(result)
}
