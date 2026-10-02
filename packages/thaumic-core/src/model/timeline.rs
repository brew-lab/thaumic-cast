//! Which segment of a PCM playout a speaker's position was counted on.

/// How the speaker came to be playing the playout segment a position was
/// counted on, which decides how it counts RelTime there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimelineEntry {
    /// Told to play it: the playout's first segment, or a restart onto a
    /// later one. RelTime runs a little ahead of the audio.
    Played,
    /// Moved on to it gaplessly as its next item. RelTime counts from the
    /// audio.
    Next,
    /// Any other way (the user skipped to it, or it reopened a segment):
    /// left as it always was.
    Other,
}

/// Which segment of a PCM playout a position poll was counted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PlayoutTimeline {
    /// Output byte the segment's data starts at, which names it.
    pub start: u64,
    /// How the speaker came to be playing it.
    pub entry: TimelineEntry,
}
