---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/protocol': patch
---

feat(core): drive clock drift correction from the speaker monitor

No two clocks agree exactly: a Sonos Playbar in the field plays about 20 ppm faster than audio arrives, so its reserve
drains about 1.2 ms a minute and a 500 ms speaker head start reaches the low floor after roughly five hours. The core
now has a controller that holds each speaker's reserve at the level its head start settled at, by commanding the PCM
rate adapter to stretch or squeeze the audio by at most 150 ppm. It steps on every 30 s reserve estimate: a
proportional term beyond a deadband that follows the estimate's half-width, a gentler damping term inside it, and an
integral that learns the speaker's clock, is kept across reconnects and casts (by speaker UUID where the topology
knows it), never winds up against the cap, and is frozen on held or unlocked estimates. The command holds while the
estimate is unlocked and ramps to 0 after 30 minutes unlocked or 10 without answers; it is refreshed every 500 ms, so
if the monitor stops the cadence's watchdog drops it to 0 within 30 s. The reserve estimate and the time to the floor
use the net rate (the clock less the correction applied), video sync counts the audio inserted, and the 30 s
`[SpeakerMonitor]` line shows `cmd` (or `would_cmd`), the integral and `ins`. Speaker health reports carry `driftMode`,
`commandPpm` and `netInsertedMs`; a `drift_saturated` notice says when correction is pinned at its cap and the speaker
will still run low, and an uncorrected drift notice now adds that turning correction on keeps the speaker topped up.

The mode is `on`, `observe` or `off`, read per connection and `off` whenever speaker monitoring is. With `observe`
the controller works out and logs what it would command while the audio goes out byte for byte as captured; the
default is set in the `drift-default-on` changeset. The desktop app offers an On/Off toggle under Settings > Speakers (Off keeps observing), disabled while
"Speaker monitoring" is off; the server takes `drift_compensation` in its config or `--drift-compensation`, and warns at startup
when it is set but the speaker monitor is off. `THAUMIC_DRIFT_COMPENSATION` outranks both.
