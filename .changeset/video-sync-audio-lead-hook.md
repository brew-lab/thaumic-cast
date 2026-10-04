---
'@thaumic-cast/extension': patch
---

feat(extension): add the audio-lead hook for video sync

Video sync needs the page's sound to play early by as much as the speakers lag, so that picture and words arrive
together. This adds the part that does it, inside the page's own player: a small script that moves the page's audio
earlier in the player's buffer and shows the player its own timeline unchanged. The picture is never touched, and the
script never seeks or pauses. If playback sticks, or a live broadcast is too near its edge for the sound to run
ahead, it puts the sound back where it was. If the extension goes away (reloaded, turned off or updated), the sound
goes back after ten seconds.

The script is only placed in pages while video sync is on in Settings, and turning it on now asks Chrome for access
to every site, because the script has to run inside each site's player. Pages that were already open need a reload.
Nothing drives the script yet: a later change sets the amount from the companion's measurement. Players that keep
sound and picture in one stream, or run in a worker, cannot be adjusted and say so.
