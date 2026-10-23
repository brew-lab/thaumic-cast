/**
 * Media Reader (MAIN world)
 *
 * Content script that reads MediaSession metadata and action handlers from the page.
 * Runs in MAIN world to access navigator.mediaSession directly. The logic is in reader.ts.
 *
 * Built as a self-contained classic script (see vite.config.ts) and injected at
 * document_start, so it hooks the media session before any page script runs.
 */

import { startMediaReader } from './reader';

startMediaReader({ win: window, session: navigator.mediaSession });
