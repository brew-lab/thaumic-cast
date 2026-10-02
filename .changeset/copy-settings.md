---
'@thaumic-cast/extension': patch
'@thaumic-cast/desktop': patch
'@thaumic-cast/server': patch
---

fix(extension,desktop): reword the settings pages

Every label and line of help on the extension's Settings page and in the desktop app's Settings view has been
rewritten. Each line of help now says what the setting does and when a change takes effect: the extension's audio,
video sync, keep-awake, speaker and capture settings from the next cast you start, and the desktop app's speaker
settings when a speaker next connects.

The settings use the same words as the notices: reserve, speaker head start, smoothing and clock drift correction.

Some labels have changed, so here is where things went:

- Extension: "Server" is now "Companion", with "Find it automatically" and "Enter the address". "Audio Quality" is
  "Audio". "Here Be Dragons" is "Finer points". "Video sync controls" is "Video sync". "Synchronize speakers" is "Play
  speakers as one group".
- Desktop app: "Keep an eye on speakers" is "Speaker monitoring". "Hand-added" is "Added by IP address", and its
  button says "Remove speaker".

The Quality names (Economical, Sensible, Luxurious, Bespoke) are the same. No setting behaves differently.

The server's install script now prints "Server address", the name of the field the address goes in.
