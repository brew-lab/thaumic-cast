---
'@thaumic-cast/core': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

feat(core): read the three speaker settings once at start-up, and say where each came from

**Behaviour change.** Speaker monitoring, the speaker head start and clock drift correction are now settled once, when
the app starts. Before, `THAUMIC_SPEAKER_MONITOR`, `THAUMIC_PCM_CONNECT_BURST_MS` and `THAUMIC_DRIFT_COMPENSATION` were
read again each time a speaker connected, and there they beat both the flag and the file.

- **Server:** a flag now beats an environment variable, which beats `config.yaml`, which beats the default, for these
  three settings as for every other. If you set both a flag and its variable, the flag is what you get.
- **Desktop app:** an environment variable still beats the setting saved in Settings > Speakers, and the control still
  shows the variable's value and stays locked. A setting you change in the app applies from each speaker's next
  connection, as before.
- **Both:** restart to apply a changed variable. Changing one while the app runs no longer does anything.
- The log says, once at start-up, what each of the three is and where it came from, for example
  `pcm_connect_burst_ms = 500 ms (default)` or `speaker_monitor = off (--speaker-monitor)`.
- `THAUMIC_SPEAKER_DIAGNOSTICS` still works, and still turns speaker monitoring on over everything else, an explicit
  off included. It now warns at start-up that `THAUMIC_SPEAKER_MONITOR=on` replaces it, and the desktop checkbox shows
  ticked and locked while it is set, where it used to show unticked.

No setting, flag or variable is renamed, and no default changes.
