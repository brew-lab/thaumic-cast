use crate::generated::{GroupStatus, LocalGroup, SonosStateSnapshot};
use parking_lot::RwLock;
use tauri::Emitter;

/// Centralized state manager for all Sonos-related data.
/// Emits `sonos-state-changed` event to frontend whenever state changes.
pub struct SonosState {
    inner: RwLock<SonosStateInner>,
    app_handle: RwLock<Option<tauri::AppHandle>>,
}

struct SonosStateInner {
    groups: Vec<LocalGroup>,
    group_statuses: Vec<GroupStatus>,
    discovered_devices: u64,
    gena_subscriptions: u64,
    last_discovery_at: Option<u64>,
    is_discovering: bool,
}

impl SonosState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(SonosStateInner {
                groups: vec![],
                group_statuses: vec![],
                discovered_devices: 0,
                gena_subscriptions: 0,
                last_discovery_at: None,
                is_discovering: false,
            }),
            app_handle: RwLock::new(None),
        }
    }

    /// Set the Tauri app handle for emitting events.
    /// Must be called after Tauri setup completes.
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Get a snapshot of the current state
    pub fn snapshot(&self) -> SonosStateSnapshot {
        let inner = self.inner.read();
        SonosStateSnapshot {
            groups: inner.groups.clone(),
            group_statuses: inner.group_statuses.clone(),
            discovered_devices: inner.discovered_devices,
            gena_subscriptions: inner.gena_subscriptions,
            last_discovery_at: inner.last_discovery_at,
            is_discovering: inner.is_discovering,
        }
    }

    /// Update groups and emit state change
    pub fn set_groups(&self, groups: Vec<LocalGroup>) {
        {
            let mut inner = self.inner.write();
            inner.groups = groups;
        }
        self.emit();
    }

    /// Update group statuses and emit state change
    pub fn set_group_statuses(&self, statuses: Vec<GroupStatus>) {
        {
            let mut inner = self.inner.write();
            inner.group_statuses = statuses;
        }
        self.emit();
    }

    /// Update discovery state (is_discovering, device count, timestamp)
    pub fn set_discovery_state(&self, is_discovering: bool, devices: u64, last_at: Option<u64>) {
        {
            let mut inner = self.inner.write();
            inner.is_discovering = is_discovering;
            inner.discovered_devices = devices;
            if last_at.is_some() {
                inner.last_discovery_at = last_at;
            }
        }
        self.emit();
    }

    /// Update GENA subscription count
    pub fn set_gena_subscriptions(&self, count: u64) {
        {
            let mut inner = self.inner.write();
            inner.gena_subscriptions = count;
        }
        self.emit();
    }

    /// Emit the current state to the frontend
    fn emit(&self) {
        let handle_guard = self.app_handle.read();
        if let Some(ref handle) = *handle_guard {
            let snapshot = self.snapshot();
            if let Err(e) = handle.emit("sonos-state-changed", &snapshot) {
                log::warn!("[SonosState] Failed to emit state change: {}", e);
            }
        }
    }
}

impl Default for SonosState {
    fn default() -> Self {
        Self::new()
    }
}
