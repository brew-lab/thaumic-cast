---
'@thaumic-cast/desktop': patch
'@thaumic-cast/extension': patch
'@thaumic-cast/ui': patch
---

fix(desktop,extension): call what you cast to rooms in both apps

The extension called the places you cast to rooms and the desktop app called them speakers. Both
now say rooms: the desktop's first page is Rooms, and its Not found page goes Back to Rooms. In the
popup the list loads with "Asking for rooms…", and choosing a room that is busy says "Whatever the
room is playing will stop." or "The cast already in this room will end."

"Speakers" stays where it means the devices themselves: Settings › Speakers in the desktop app
(speaker monitoring, the speaker head start, clock drift correction and adding one by its IP
address), finding speakers on the network, and the notices about a speaker that has stopped
answering or is running out of audio.
