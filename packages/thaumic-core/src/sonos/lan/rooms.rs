//! Rooms joining and leaving groups over port 1443.
//!
//! `groups:1 modifyGroupMembers`, sent to the group's coordinator, adds or
//! removes players. Its reply can come before the change, or seconds after
//! it (2.55 s when a coordinator left its group), so a change counts only
//! once a fresh `getGroups` shows it. As on port 1400 a joining room plays
//! what its new group plays with no command of its own, and a coordinator
//! that leaves hands its group, session and all, to the first room left in
//! it (measured on firmware 86.10).

use std::time::Duration;

use serde_json::json;

use super::client::LanClient;
use super::protocol::{code, transport_error, Groups};
use crate::error::SoapResult;

/// The groups namespace.
const GROUPS: &str = "groups:1";

/// How long a change may take to show in the groups.
pub const CONFIRM_WITHIN: Duration = Duration::from_secs(5);

impl LanClient {
    /// The groups as they are now, read through `ip`.
    async fn fresh_groups(&self, ip: &str) -> SoapResult<Groups> {
        let household_id = self.household()?;
        self.read_groups(ip, &household_id).await
    }

    /// Asks the coordinator at `coordinator_ip` to add and remove players
    /// from its group, then waits until the groups read through
    /// `coordinator_ip` show `done`.
    async fn modify_members(
        &self,
        coordinator_ip: &str,
        add: Vec<String>,
        remove: Vec<String>,
        done: impl Fn(&Groups) -> bool,
    ) -> SoapResult<()> {
        let household_id = self.household()?;
        self.on_group(
            coordinator_ip,
            GROUPS,
            "modifyGroupMembers",
            json!({ "playerIdsToAdd": add, "playerIdsToRemove": remove }),
        )
        .await?;
        let groups = self
            .hub()
            .wait_for_groups(coordinator_ip, &household_id, CONFIRM_WITHIN, done)
            .await?;
        self.keep_groups(&groups);
        Ok(())
    }

    /// Puts the room at `ip` in the group `coordinator_uuid` leads.
    ///
    /// A room leading a cast of ours ends it first: on port 1400 the join's
    /// new transport replaces it, and here nothing else would, leaving its
    /// session on the room and the route held.
    pub(super) async fn join(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        if self.has_cast(ip) {
            self.end_cast(ip).await;
        }
        let groups = self.fresh_groups(ip).await?;
        let player = self.player(ip)?;
        let joined = |g: &Groups| {
            g.group_of(&player)
                .is_some_and(|group| group.coordinator_id == coordinator_uuid)
        };
        if joined(&groups) {
            return Ok(());
        }
        let coordinator_ip = groups
            .group_of(coordinator_uuid)
            .filter(|group| group.coordinator_id == coordinator_uuid)
            .and_then(|_| groups.ip_of(coordinator_uuid))
            .ok_or_else(|| {
                transport_error(
                    code::BAD_REPLY,
                    format!("{coordinator_uuid} leads no group to join"),
                )
            })?
            .to_string();
        self.modify_members(&coordinator_ip, vec![player.clone()], Vec::new(), joined)
            .await
    }

    /// Takes the room at `ip` out of its group, so it stands alone. A
    /// coordinator hands its group to the first room left in it.
    pub(super) async fn leave(&self, ip: &str) -> SoapResult<()> {
        let groups = self.fresh_groups(ip).await?;
        let player = self.player(ip)?;
        let Some(group) = groups.group_of(&player) else {
            return Err(transport_error(
                code::BAD_REPLY,
                format!("{ip} is in no group"),
            ));
        };
        if group.player_ids.len() <= 1 {
            return Ok(());
        }
        let coordinator_ip = groups
            .ip_of(&group.coordinator_id)
            .ok_or_else(|| {
                transport_error(
                    code::BAD_REPLY,
                    format!("no address for {}", group.coordinator_id),
                )
            })?
            .to_string();
        let alone = |g: &Groups| {
            g.group_of(&player)
                .is_some_and(|group| group.player_ids == [player.clone()])
        };
        self.modify_members(&coordinator_ip, Vec::new(), vec![player.clone()], alone)
            .await
    }
}
