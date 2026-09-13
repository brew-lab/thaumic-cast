//! In-process test doubles and the integration tests built on them.
//!
//! Compiled for tests only. [`fake_sonos`] is a household of fake speakers
//! served over real HTTP; [`harness`] wires the crate's real services to it;
//! the remaining modules are the integration tests.

pub(crate) mod fake_sonos;
pub(crate) mod harness;

mod failure_tests;
mod gena_tests;
mod playback_tests;
