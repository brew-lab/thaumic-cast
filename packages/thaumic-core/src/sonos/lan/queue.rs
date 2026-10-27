//! The cloud queues Thaumic serves to speakers it casts to over port 1443.
//!
//! A cast is loaded with `playbackSession:1 loadCloudQueue`, which names a
//! queue base URL on this machine; the speaker then reads `context`,
//! `itemWindow` and `version` there and reports `timePlayed` (served by
//! `api::cloud_queue`). Each queue item is one PCM segment of the stream, at
//! the same URL a UPnP cast fetches it from, so serving the audio does not
//! change. Each load gets a fresh queue id (`gen`), used as the queue version
//! too, so a speaker never reuses a queue it has cached.
//!
//! Recorded from firmware 86.10:
//! - the speaker asks for `context`, then `itemWindow?reason=load&itemId=…`
//!   (asking for up to 10 items each side), then fetches the item;
//! - it fetches the next item listed the moment the current one's response
//!   ends, and plays it with no gap; an item it cannot fetch leaves it
//!   PAUSED on that item, never having played it;
//! - it asks again only when the queue runs out
//!   (`reason=queueCompleted`), so anything it is to play next must be
//!   listed by then;
//! - each item is played for its declared `durationMillis`; with the exact
//!   length the queue's end reads as PAUSED at that position;
//! - an ended queue (no items) ends the cast the next time it asks.
//!
//! A queue whose cast continues lists, for an item asked about, that item and
//! the segment after it: the next segment is there from the load, and again
//! whenever the speaker asks at the end of what it has. Whether it plays on
//! from an item listed only at `queueCompleted` is not measured yet; if it
//! does not, the cast ends PAUSED and the services' restart path loads the
//! next segment.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::stream::pcm_segment_uri;

/// The Cloud Queue API version in every queue URL.
pub const API_VERSION: &str = "v2.3";

/// The path every queue URL starts with.
pub const PATH_PREFIX: &str = "/cq";

/// One item: a segment of a stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueItem {
    /// The item id: `<gen>-<segment>`.
    pub id: String,
    /// The PCM segment it plays.
    pub segment: u32,
    /// Where the speaker fetches it: the segment's own stream URL.
    pub media_url: String,
    /// How it is described.
    pub track: TrackInfo,
}

/// What every item of a queue shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackInfo {
    /// The MIME type.
    pub content_type: String,
    /// Each item's length, when it has one.
    pub duration_ms: Option<u64>,
    /// What the Sonos app shows.
    pub title: String,
    /// The artist line, if any.
    pub artist: Option<String>,
    /// The album art URL, if any.
    pub image_url: Option<String>,
}

impl QueueItem {
    /// The item as `itemWindow` lists it.
    fn to_json(&self) -> Value {
        let info = &self.track;
        let mut track = json!({
            "type": "track",
            "mediaUrl": self.media_url,
            "contentType": info.content_type,
            "name": info.title,
            "service": { "name": "Thaumic", "id": "thaumic" },
        });
        if let Some(ms) = info.duration_ms {
            track["durationMillis"] = ms.into();
        }
        if let Some(artist) = &info.artist {
            track["artist"] = json!({ "name": artist });
        }
        if let Some(url) = &info.image_url {
            track["imageUrl"] = url.clone().into();
        }
        json!({
            "id": self.id,
            "deleted": false,
            "policies": { "canSkip": false, "canCrossfade": false },
            "track": track,
        })
    }
}

/// One loaded queue: the segments of a stream from the one it was loaded
/// at.
#[derive(Debug, Clone)]
pub struct CloudQueue {
    /// The stream it plays.
    pub stream_id: String,
    /// Its id, and its version.
    pub gen: String,
    /// The stream's base URL (`…/stream/{id}/live`), each segment's URL
    /// built from it as a UPnP cast's is.
    pub stream_url: String,
    /// The segment it was loaded at, its first item.
    pub first: u32,
    /// Whether each item is followed by the next segment.
    pub continues: bool,
    /// What every item shares.
    pub track: TrackInfo,
    /// Whether the cast ended: from then on the queue lists nothing.
    pub ended: bool,
}

impl CloudQueue {
    /// Segment `segment`'s item, if the queue holds it: the first, and with
    /// `continues` every one after it.
    #[must_use]
    pub fn item(&self, segment: u32) -> Option<QueueItem> {
        let held = segment == self.first || (self.continues && segment > self.first);
        held.then(|| QueueItem {
            id: CloudQueues::item_id(&self.gen, segment),
            segment,
            media_url: pcm_segment_uri(&self.stream_url, segment),
            track: self.track.clone(),
        })
    }

    /// The items an `itemWindow` request for `item_id` gets: that item and,
    /// with `continues`, the next; none once the queue ended. An unknown or
    /// missing id is taken for the first item.
    fn window(&self, item_id: Option<&str>) -> Vec<QueueItem> {
        if self.ended {
            return Vec::new();
        }
        let asked = item_id
            .and_then(|id| CloudQueues::segment_of(&self.gen, id))
            .filter(|segment| self.item(*segment).is_some())
            .unwrap_or(self.first);
        let next = asked.checked_add(1).filter(|_| self.continues);
        std::iter::once(asked)
            .chain(next)
            .filter_map(|segment| self.item(segment))
            .collect()
    }
}

/// What a queue request was answered with.
#[derive(Debug, Clone, PartialEq)]
pub enum QueueAnswer {
    /// 200 with this JSON.
    Json(Value),
    /// 204: `timePlayed` is acknowledged and not kept.
    NoContent,
    /// 404: no such queue, stream or endpoint.
    NotFound,
}

/// Every queue loaded and not yet dropped.
#[derive(Debug, Default)]
pub struct CloudQueues {
    queues: Mutex<HashMap<String, CloudQueue>>,
    next: AtomicU64,
}

impl CloudQueues {
    /// A fresh queue id, unique for the process and unlike any before it.
    pub fn next_gen(&self) -> String {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        format!("q{started:x}{}", self.next.fetch_add(1, Ordering::Relaxed))
    }

    /// The id of segment `segment`'s item in queue `gen`.
    #[must_use]
    pub fn item_id(gen: &str, segment: u32) -> String {
        format!("{gen}-{segment}")
    }

    /// The segment an item id of queue `gen` names.
    #[must_use]
    pub fn segment_of(gen: &str, item_id: &str) -> Option<u32> {
        item_id.strip_prefix(gen)?.strip_prefix('-')?.parse().ok()
    }

    /// Adds a queue.
    pub fn insert(&self, queue: CloudQueue) {
        self.queues.lock().insert(queue.gen.clone(), queue);
    }

    /// The queue `gen`, if it is still kept.
    #[must_use]
    pub fn get(&self, gen: &str) -> Option<CloudQueue> {
        self.queues.lock().get(gen).cloned()
    }

    /// Ends queue `gen`: it lists nothing from now on.
    pub fn end(&self, gen: &str) {
        if let Some(queue) = self.queues.lock().get_mut(gen) {
            queue.ended = true;
        }
    }

    /// Drops queue `gen`.
    pub fn remove(&self, gen: &str) {
        self.queues.lock().remove(gen);
    }

    /// The item `item_id`, from whichever queue holds it, with that queue's
    /// first segment.
    #[must_use]
    pub fn item(&self, item_id: &str) -> Option<(QueueItem, u32)> {
        let (gen, _) = item_id.rsplit_once('-')?;
        let queues = self.queues.lock();
        let queue = queues.get(gen)?;
        let item = queue.item(Self::segment_of(gen, item_id)?)?;
        Some((item, queue.first))
    }

    /// The answer to `method` on `endpoint` of queue `gen` for `stream_id`,
    /// with the request's query.
    #[must_use]
    pub fn answer(
        &self,
        stream_id: &str,
        gen: &str,
        method: &str,
        endpoint: &str,
        query: &HashMap<String, String>,
    ) -> QueueAnswer {
        let Some(queue) = self.get(gen).filter(|q| q.stream_id == stream_id) else {
            return QueueAnswer::NotFound;
        };
        let version = json!({ "contextVersion": "1", "queueVersion": queue.gen });
        match (method, endpoint) {
            ("GET", "version") => QueueAnswer::Json(version),
            ("GET", "context") => QueueAnswer::Json(json!({
                "contextVersion": "1",
                "queueVersion": queue.gen,
                "container": {
                    "type": "trackList",
                    "name": "Thaumic",
                    "service": { "name": "Thaumic", "id": "thaumic" },
                    "id": { "serviceId": "thaumic", "objectId": format!("thaumic:{}", queue.stream_id), "accountId": "" },
                },
                "reports": { "sendUpdateAfterMillis": 1000, "periodicIntervalMillis": 30000, "sendPlaybackActions": true },
                "playbackPolicies": {
                    "canSkip": false, "limitedSkips": false, "canSkipToItem": false,
                    "canSkipBack": false, "canSeek": false, "canRepeat": false,
                    "canRepeatOne": false, "canCrossfade": false, "canShuffle": false,
                },
            })),
            ("GET", "itemWindow") => {
                let items = queue.window(query.get("itemId").map(String::as_str));
                QueueAnswer::Json(json!({
                    "includesBeginningOfQueue": items.first().map_or(true, |i| i.segment == queue.first),
                    "includesEndOfQueue": true,
                    "contextVersion": "1",
                    "queueVersion": queue.gen,
                    "items": items.iter().map(QueueItem::to_json).collect::<Vec<_>>(),
                }))
            }
            ("POST", "timePlayed") => QueueAnswer::NoContent,
            _ => QueueAnswer::NotFound,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: &str = "http://10.0.0.2:1234/stream/s1/live";

    fn queue(queues: &CloudQueues, first: u32, continues: bool) -> String {
        let gen = queues.next_gen();
        queues.insert(CloudQueue {
            stream_id: "s1".into(),
            gen: gen.clone(),
            stream_url: STREAM.into(),
            first,
            continues,
            track: TrackInfo {
                content_type: "audio/wav".into(),
                duration_ms: Some(60_000),
                title: "Tab".into(),
                artist: Some("Thaumic".into()),
                image_url: None,
            },
            ended: false,
        });
        gen
    }

    fn get(queues: &CloudQueues, gen: &str, endpoint: &str, item: Option<&str>) -> Value {
        let mut query = HashMap::new();
        if let Some(id) = item {
            query.insert("itemId".to_string(), id.to_string());
        }
        match queues.answer("s1", gen, "GET", endpoint, &query) {
            QueueAnswer::Json(v) => v,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn ids(window: &Value) -> Vec<String> {
        window["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn every_load_gets_a_new_queue_id_and_items_name_their_segment() {
        let queues = CloudQueues::default();
        let (a, b) = (queues.next_gen(), queues.next_gen());
        assert_ne!(a, b);
        assert_eq!(CloudQueues::item_id(&a, 3), format!("{a}-3"));
        assert_eq!(CloudQueues::segment_of(&a, &format!("{a}-3")), Some(3));
        assert_eq!(CloudQueues::segment_of(&a, &format!("{b}-3")), None);
        assert_eq!(CloudQueues::segment_of(&a, &format!("{a}-x")), None);
    }

    #[test]
    fn items_are_the_stream_s_segments_at_their_upnp_urls_with_their_length() {
        let queues = CloudQueues::default();
        let gen = queue(&queues, 0, false);
        let window = get(
            &queues,
            &gen,
            "itemWindow",
            Some(&CloudQueues::item_id(&gen, 0)),
        );
        assert_eq!(window["queueVersion"], gen.as_str());
        assert_eq!(window["includesBeginningOfQueue"], true);
        assert_eq!(window["includesEndOfQueue"], true);
        let item = &window["items"][0];
        assert_eq!(item["track"]["mediaUrl"], format!("{STREAM}.wav"));
        assert_eq!(item["track"]["durationMillis"], 60_000);
        assert_eq!(item["track"]["contentType"], "audio/wav");
        assert_eq!(item["track"]["artist"]["name"], "Thaumic");
        assert!(item["track"].get("imageUrl").is_none());
        assert_eq!(ids(&window), [CloudQueues::item_id(&gen, 0)]);

        let (held, first) = queues.item(&CloudQueues::item_id(&gen, 0)).unwrap();
        assert_eq!((held.segment, first), (0, 0));
        assert_eq!(queues.item(&CloudQueues::item_id(&gen, 1)), None);
        assert_eq!(queues.item("nope-1"), None);
    }

    #[test]
    fn a_continuing_queue_lists_the_next_segment_behind_each_item_asked_about() {
        let queues = CloudQueues::default();
        let gen = queue(&queues, 3, true);
        let item = |segment| CloudQueues::item_id(&gen, segment);

        let load = get(&queues, &gen, "itemWindow", Some(&item(3)));
        assert_eq!(ids(&load), [item(3), item(4)]);
        assert_eq!(
            load["items"][1]["track"]["mediaUrl"],
            format!("{STREAM}/4.wav")
        );
        assert_eq!(load["includesBeginningOfQueue"], true);

        let completed = get(&queues, &gen, "itemWindow", Some(&item(4)));
        assert_eq!(ids(&completed), [item(4), item(5)]);
        assert_eq!(completed["includesBeginningOfQueue"], false);

        // Before the first, or not ours: from the first.
        assert_eq!(
            ids(&get(&queues, &gen, "itemWindow", Some(&item(2)))),
            [item(3), item(4)]
        );
        assert_eq!(
            ids(&get(&queues, &gen, "itemWindow", None)),
            [item(3), item(4)]
        );
        assert_eq!(queues.item(&item(9)).unwrap().0.segment, 9);
        assert_eq!(queues.item(&item(2)), None);
    }

    #[test]
    fn an_ended_queue_lists_nothing_and_a_dropped_one_is_not_found() {
        let queues = CloudQueues::default();
        let gen = queue(&queues, 0, true);
        assert_eq!(
            get(&queues, &gen, "version", None)["queueVersion"],
            gen.as_str()
        );
        assert_eq!(
            get(&queues, &gen, "context", None)["playbackPolicies"]["canSeek"],
            false
        );

        queues.end(&gen);
        let ended = get(&queues, &gen, "itemWindow", None);
        assert!(ended["items"].as_array().unwrap().is_empty());
        assert_eq!(
            queues.answer("s1", &gen, "POST", "timePlayed", &HashMap::new()),
            QueueAnswer::NoContent
        );
        assert_eq!(
            queues.answer("other", &gen, "GET", "version", &HashMap::new()),
            QueueAnswer::NotFound
        );
        assert_eq!(
            queues.answer("s1", &gen, "GET", "nope", &HashMap::new()),
            QueueAnswer::NotFound
        );
        queues.remove(&gen);
        assert_eq!(
            queues.answer("s1", &gen, "GET", "version", &HashMap::new()),
            QueueAnswer::NotFound
        );
    }
}
