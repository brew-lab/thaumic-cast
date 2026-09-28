---
'@thaumic-cast/server': patch
---

docs(server): document speaker monitoring and the head start

The example config the installer copies now spells out `speaker_monitor: true` and `pcm_connect_burst_ms: 500`, the
defaults (so new installs pin them in `/etc/thaumic-server/config.yaml`, and a later change to the shipped defaults will
not reach those installs), and describes them the way the apps do: the speaker monitor is what drives the speaker
notices clients show, and the speaker head start (0 to 2000 ms) is audio each speaker gets at once when it connects to a
PCM cast, which helps one speaker on a weak Wi-Fi link and adds that much delay; every speaker cutting out at once needs
more smoothing in the browser extension instead. The README's option and environment tables add `--speaker-monitor`,
`--pcm-connect-burst-ms` and `--strict-stream-access` with their `THAUMIC_*` variables, noting that the speaker monitor
and head start variables outrank the flags, and tests check that the example config parses to the shipped defaults and
sets both speaker keys.
