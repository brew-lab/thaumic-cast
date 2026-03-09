//! Browser process discovery for WASAPI process-tree capture.
//!
//! Enumerates processes via `CreateToolhelp32Snapshot` and finds the root
//! browser PID for process-tree loopback capture.

use std::collections::HashMap;

use thaumic_core::capture::CaptureError;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

/// Known Chromium-based browsers.
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
        let exe_lower = info.exe_name.to_lowercase();
        if !KNOWN_BROWSERS.iter().any(|b| exe_lower == *b) {
            continue;
        }

        let root_pid = walk_to_root(*pid, &info.exe_name, &processes);
        if seen_roots.insert(root_pid) {
            results.push(BrowserProcess {
                pid: root_pid,
                name: info.exe_name.clone(),
            });
        }
    }

    results
}

/// Find browser PID for a specific browser executable name.
///
/// Returns the root PID of the first matching browser process.
pub fn find_browser_pid_by_name(exe_name: &str) -> Result<u32, CaptureError> {
    let processes = enumerate_processes()
        .map_err(|e| CaptureError::Platform(format!("Process enumeration failed: {}", e)))?;

    let exe_lower = exe_name.to_lowercase();
    let mut seen_roots = std::collections::HashSet::new();

    for (pid, info) in &processes {
        if info.exe_name.to_lowercase() != exe_lower {
            continue;
        }

        let root_pid = walk_to_root(*pid, &info.exe_name, &processes);
        if seen_roots.insert(root_pid) {
            return Ok(root_pid);
        }
    }

    Err(CaptureError::Platform(format!(
        "No running process found for '{}'",
        exe_name
    )))
}

struct ProcessInfo {
    exe_name: String,
    parent_pid: u32,
}

/// Walk up the parent chain to find the topmost process with the same executable name.
fn walk_to_root(start_pid: u32, exe_name: &str, processes: &HashMap<u32, ProcessInfo>) -> u32 {
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

        if parent_info.exe_name.to_lowercase() != exe_name.to_lowercase() {
            break;
        }

        current = parent;
    }

    current
}

/// Enumerate all running processes via CreateToolhelp32Snapshot.
fn enumerate_processes() -> Result<HashMap<u32, ProcessInfo>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|e| format!("CreateToolhelp32Snapshot failed: {}", e))?;

    let mut result = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    if ok.is_err() {
        let _ = unsafe { CloseHandle(snapshot) };
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

        result.insert(
            entry.th32ProcessID,
            ProcessInfo {
                exe_name,
                parent_pid: entry.th32ParentProcessID,
            },
        );

        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }

    let _ = unsafe { CloseHandle(snapshot) };
    Ok(result)
}
