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
//! - it asks again only when the queue runs out
//!   (`reason=queueCompleted`), so anything it is to play must be listed
//!   from the start;
//! - each item is played for its declared `durationMillis`; with the exact
//!   length the queue's end reads as PAUSED at that position;
//! - an ended queue (no items) ends the cast the next time it asks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde_json::{json, Value};

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
    /// Its MIME type.
    pub content_type: String,
    /// Its length, when it has one.
    pub duration_ms: Option<u64>,
    /// What the Sonos app shows for it.
    pub title: String,
    /// The artist line, if any.
    pub artist: Option<String>,
    /// The album art URL, if any.
    pub image_url: Option<String>,
}

impl QueueItem {
    /// The item as `itemWindow` lists it.
    fn to_json(&self) -> Value {
        let mut track = json!({
            "type": "track",
            "mediaUrl": self.media_url,
            "contentType": self.content_type,
            "name": self.title,
            "service": { "name": "Thaumic", "id": "thaumic" },
        });
        if let Some(ms) = self.duration_ms {
            track["durationMillis"] = ms.into();
        }
        if let Some(artist) = &self.artist {
            track["artist"] = json!({ "name": artist });
        }
        if let Some(url) = &self.image_url {
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

/// One loaded queue.
#[derive(Debug, Clone)]
pub struct CloudQueue {
    /// The stream it plays.
    pub stream_id: String,
    /// Its id, and its version.
    pub gen: String,
    /// The items listed, in play order.
    pub items: Vec<QueueItem>,
    /// Whether the cast ended: from then on the queue lists nothing.
    pub ended: bool,
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

    /// The item `item_id`, from whichever queue holds it.
    #[must_use]
    pub fn item(&self, item_id: &str) -> Option<QueueItem> {
        let (gen, _) = item_id.rsplit_once('-')?;
        let queues = self.queues.lock();
        queues
            .get(gen)?
            .items
            .iter()
            .find(|i| i.id == item_id)
            .cloned()
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
                let items = window(&queue, query.get("itemId").map(String::as_str));
                QueueAnswer::Json(json!({
                    "includesBeginningOfQueue": items.first().map_or(true, |i| Some(i) == queue.items.first()),
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

/// The items an `itemWindow` request for `item_id` gets: that item and
/// every one after it, or none once the queue ended. An unknown or missing
/// id gets the whole queue.
fn window<'a>(queue: &'a CloudQueue, item_id: Option<&str>) -> &'a [QueueItem] {
    if queue.ended {
        return &[];
    }
    let from = item_id
        .and_then(|id| queue.items.iter().position(|i| i.id == id))
        .unwrap_or(0);
    &queue.items[from..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(queues: &CloudQueues, segments: &[u32]) -> String {
        let gen = queues.next_gen();
        queues.insert(CloudQueue {
            stream_id: "s1".into(),
            gen: gen.clone(),
            items: segments
                .iter()
                .map(|&segment| QueueItem {
                    id: CloudQueues::item_id(&gen, segment),
                    segment,
                    media_url: format!("http://10.0.0.2:1234/stream/s1/live/{segment}.wav"),
                    content_type: "audio/wav".into(),
                    duration_ms: Some(60_000),
                    title: "Tab".into(),
                    artist: Some("Thaumic".into()),
                    image_url: None,
                })
                .collect(),
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

    #[test]
    fn every_load_gets_a_new_queue_id_and_items_name_their_segment() {
        let queues = CloudQueues::default();
        let (a, b) = (queues.next_gen(), queues.next_gen());
        assert_ne!(a, b);
        assert_eq!(CloudQueues::item_id(&a, 3), format!("{a}-3"));
    }

    #[test]
    fn the_window_lists_the_asked_for_item_and_those_after_it_with_their_length() {
        let queues = CloudQueues::default();
        let gen = queue(&queues, &[4, 5]);
        let first = CloudQueues::item_id(&gen, 4);
        let second = CloudQueues::item_id(&gen, 5);

        let all = get(&queues, &gen, "itemWindow", Some(&first));
        assert_eq!(all["queueVersion"], gen.as_str());
        assert_eq!(all["includesBeginningOfQueue"], true);
        assert_eq!(all["includesEndOfQueue"], true);
        let items = all["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], first.as_str());
        assert_eq!(items[0]["track"]["durationMillis"], 60_000);
        assert_eq!(
            items[0]["track"]["mediaUrl"],
            "http://10.0.0.2:1234/stream/s1/live/4.wav"
        );
        assert_eq!(items[0]["track"]["contentType"], "audio/wav");
        assert!(items[0]["track"].get("imageUrl").is_none());

        let later = get(&queues, &gen, "itemWindow", Some(&second));
        assert_eq!(later["items"].as_array().unwrap().len(), 1);
        assert_eq!(later["includesBeginningOfQueue"], false);

        assert_eq!(queues.item(&second).unwrap().segment, 5);
        assert_eq!(queues.item("nope-1"), None);
    }

    #[test]
    fn an_ended_queue_lists_nothing_and_a_dropped_one_is_not_found() {
        let queues = CloudQueues::default();
        let gen = queue(&queues, &[0]);
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
