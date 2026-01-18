# Privacy Policy

Thaumic Cast is designed to be self-hosted and local-first. The extension runs in your browser and talks to the Thaumic
Cast companion app (Desktop app or headless server) that you run.

## The short version

We are not interested in your data. We would not know where to put it if we had it.

Thaumic Cast does not send your audio or usage data to any servers we operate. The extension talks only to the local
Thaumic Cast companion app on your machine and the Sonos devices on your local network.

There is no cloud. If you see one, it is probably weather.

## What data the extension processes

To provide its single purpose (streaming tab audio to Sonos via your local companion app), the extension processes:

- Tab audio you choose to cast (captured via Chrome’s tab capture APIs).
- Basic tab information used for display and media identification (for example: tab URL/hostname, page title, favicon
  URL).
- Media metadata from the page when available (for example: track title/artist) to show in the extension UI and on Sonos.

## What data the extension stores

The extension stores settings and state to function across sessions, such as:

- Your configured local server URL (for example, a different port).
- Speaker/group selection and onboarding progress.
- Audio quality settings and codec capability cache.

This data is stored locally on your device using Chrome extension storage.

## Where data goes

- The extension connects only to a local companion app on your machine (by default `http://localhost`).
- The extension streams audio and related control/metadata messages to that companion app over a local connection.
- From there, audio is streamed to your Sonos speakers on your local network.

In plain terms, your audio does not go to us. It goes from your tab to your machine to your speakers, and stays inside
your local network.

## What data we collect

We do not operate a cloud service for Thaumic Cast. We do not collect or receive your audio, browsing history, or media
metadata on our servers.

The extension:

- Does not include analytics or advertising trackers.
- Does not sell user data.
- Does not transmit your data to third-party services.
- Only connects to `http://localhost` (the companion app you run).

## Contact

For privacy questions or requests, contact the maintainers via GitHub Issues: https://github.com/brew-lab/thaumic-cast/issues

For security vulnerabilities, see `SECURITY.md`.

## Changes

If this policy changes, we will update this file in the repository.
