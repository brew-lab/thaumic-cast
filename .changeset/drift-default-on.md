---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): turn clock drift correction on by default

No two clocks agree exactly, so over a long cast a speaker slowly uses up its head start and eventually cuts out.
Clock drift correction stretches or squeezes the audio by a tiny amount (at most 150 parts per million, far too little
to hear) to keep each speaker topped up. It is now on unless you say otherwise. In long runs on a Playbar and a Play:1
(3 and 9.4 hours) it held each speaker's reserve within a few milliseconds of where it started, where an uncorrected
speaker lost about 85 ms in the first hour.

- **Desktop app:** "Clock drift correction" under Settings > Speakers starts ticked. A setting already saved in
  the settings file is kept; no released version has one, so this only affects builds made from the main branch since
  the option was added, where saving any speaker setting also stored the old `observe`. Unticking it leaves the audio exactly as captured and keeps logging what correction would do.
- **Server:** a config file without `drift_compensation` now gets `on`. A config file that sets it keeps its value;
  write `drift_compensation: observe` (or `off`) to go back.
- `THAUMIC_DRIFT_COMPENSATION` still outranks both.
- Correction needs speaker monitoring ("Speaker monitoring" / `speaker_monitor`), which is also on by default.
  With monitoring off, correction is off, as before.
- PCM casts only, as before.
- With correction on, a PCM cast that has to restart at a segment boundary keeps up to 2 s of the pause as extra delay
  and pays it back gradually, instead of rejoining with only its head start.
