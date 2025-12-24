//! Shared domain types used across the application.
//!
//! This module re-exports domain types from their source modules to provide
//! a clean import path for the rest of the codebase.

// Zone topology and transport types
pub use crate::sonos::types::{TransportState, ZoneGroup};
