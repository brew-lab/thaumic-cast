/*
 * The glyph inventory (DESIGN.md F-icons): the 33 glyphs the v1 UI draws, and nothing else.
 * Draw one with <Icon glyph="…" />. Every glyph sits on a 24-unit grid; all but `stop` are
 * stroked in currentColor. `chevron-start` and `external` mirror under right-to-left text.
 *
 * The path data of every glyph except `stop` is from Lucide (lucide-preact 1.8.0):
 * ISC License, Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or
 * without fee is hereby granted, provided that the above copyright notice and this
 * permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR
 * DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.
 */

/** One SVG element of a glyph: its tag and attributes. */
export type GlyphNode = readonly [
  'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon',
  Readonly<Record<string, string>>,
];

/** A glyph: its SVG elements, and how it is painted. */
export interface Glyph {
  /** The SVG elements, on a 24-unit viewBox. */
  readonly nodes: readonly GlyphNode[];
  /** Filled in currentColor instead of stroked. */
  readonly filled?: boolean;
  /** Mirrored under right-to-left text. */
  readonly mirror?: boolean;
}

/** Every glyph in the inventory, by name. */
export const GLYPHS = {
  /** Custom: a 12 × 12 rounded square, filled. Stop, Stop all casts and Remove. */
  stop: {
    filled: true,
    nodes: [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '1.5' }]],
  },
  /** Lucide `plus`. */
  plus: {
    nodes: [
      ['path', { d: 'M5 12h14' }],
      ['path', { d: 'M12 5v14' }],
    ],
  },
  /** Lucide `chevron-down`. */
  'chevron-down': { nodes: [['path', { d: 'm6 9 6 6 6-6' }]] },
  /** Lucide `chevron-left`. */
  'chevron-start': { mirror: true, nodes: [['path', { d: 'm15 18-6-6 6-6' }]] },
  /** Lucide `x`. */
  x: {
    nodes: [
      ['path', { d: 'M18 6 6 18' }],
      ['path', { d: 'm6 6 12 12' }],
    ],
  },
  /** Lucide `check`. */
  check: { nodes: [['path', { d: 'M20 6 9 17l-5-5' }]] },
  /** Lucide `copy`. */
  copy: {
    nodes: [
      ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
      ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
    ],
  },
  /** Lucide `refresh-cw`. */
  refresh: {
    nodes: [
      ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
      ['path', { d: 'M21 3v5h-5' }],
      ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
      ['path', { d: 'M8 16H3v5' }],
    ],
  },
  /** Lucide `search`. */
  search: {
    nodes: [
      ['path', { d: 'm21 21-4.34-4.34' }],
      ['circle', { cx: '11', cy: '11', r: '8' }],
    ],
  },
  /** Lucide `external-link`. */
  external: {
    mirror: true,
    nodes: [
      ['path', { d: 'M15 3h6v6' }],
      ['path', { d: 'M10 14 21 3' }],
      ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
    ],
  },
  /** Lucide `sliders-horizontal`. */
  settings: {
    nodes: [
      ['path', { d: 'M10 5H3' }],
      ['path', { d: 'M12 19H3' }],
      ['path', { d: 'M14 3v4' }],
      ['path', { d: 'M16 17v4' }],
      ['path', { d: 'M21 12h-9' }],
      ['path', { d: 'M21 19h-5' }],
      ['path', { d: 'M21 5h-7' }],
      ['path', { d: 'M8 10v4' }],
      ['path', { d: 'M8 12H3' }],
    ],
  },
  /** Lucide `play`. */
  play: {
    nodes: [
      [
        'path',
        { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' },
      ],
    ],
  },
  /** Lucide `pause`. */
  pause: {
    nodes: [
      ['rect', { x: '14', y: '3', width: '5', height: '18', rx: '1' }],
      ['rect', { x: '5', y: '3', width: '5', height: '18', rx: '1' }],
    ],
  },
  /** Lucide `skip-back`. */
  prev: {
    nodes: [
      [
        'path',
        {
          d: 'M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z',
        },
      ],
      ['path', { d: 'M3 20V4' }],
    ],
  },
  /** Lucide `skip-forward`. */
  next: {
    nodes: [
      ['path', { d: 'M21 4v16' }],
      [
        'path',
        {
          d: 'M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z',
        },
      ],
    ],
  },
  /** Lucide `volume-2`. */
  volume: {
    nodes: [
      [
        'path',
        {
          d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z',
        },
      ],
      ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
      ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
    ],
  },
  /** Lucide `volume-x`. */
  'volume-off': {
    nodes: [
      [
        'path',
        {
          d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z',
        },
      ],
      ['line', { x1: '22', x2: '16', y1: '9', y2: '15' }],
      ['line', { x1: '16', x2: '22', y1: '9', y2: '15' }],
    ],
  },
  /** Lucide `speaker`. */
  speaker: {
    nodes: [
      ['rect', { width: '16', height: '20', x: '4', y: '2', rx: '2' }],
      ['path', { d: 'M12 6h.01' }],
      ['circle', { cx: '12', cy: '14', r: '4' }],
      ['path', { d: 'M12 14h.01' }],
    ],
  },
  /** Lucide `cast`. */
  cast: {
    nodes: [
      ['path', { d: 'M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6' }],
      ['path', { d: 'M2 12a9 9 0 0 1 8 8' }],
      ['path', { d: 'M2 16a5 5 0 0 1 4 4' }],
      ['line', { x1: '2', x2: '2.01', y1: '20', y2: '20' }],
    ],
  },
  /** Lucide `music`. */
  music: {
    nodes: [
      ['path', { d: 'M9 18V5l12-2v13' }],
      ['circle', { cx: '6', cy: '18', r: '3' }],
      ['circle', { cx: '18', cy: '16', r: '3' }],
    ],
  },
  /** Lucide `monitor`. */
  monitor: {
    nodes: [
      ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
      ['line', { x1: '8', x2: '16', y1: '21', y2: '21' }],
      ['line', { x1: '12', x2: '12', y1: '17', y2: '21' }],
    ],
  },
  /** Lucide `server`. */
  server: {
    nodes: [
      ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
      ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
      ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }],
      ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }],
    ],
  },
  /** Lucide `info`. */
  info: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 16v-4' }],
      ['path', { d: 'M12 8h.01' }],
    ],
  },
  /** Lucide `triangle-alert`. */
  warning: {
    nodes: [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }],
    ],
  },
  /** Lucide `circle-x`. */
  danger: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'm15 9-6 6' }],
      ['path', { d: 'm9 9 6 6' }],
    ],
  },
  /** Lucide `history`. */
  history: {
    nodes: [
      ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
      ['path', { d: 'M3 3v5h5' }],
      ['path', { d: 'M12 7v5l4 2' }],
    ],
  },
  /** Lucide `bookmark`. */
  bookmark: {
    nodes: [
      [
        'path',
        {
          d: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
        },
      ],
    ],
  },
  /** Lucide `house`. */
  home: {
    nodes: [
      ['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }],
      [
        'path',
        {
          d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        },
      ],
    ],
  },
  /** Lucide `puzzle`. */
  puzzle: {
    nodes: [
      [
        'path',
        {
          d: 'M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z',
        },
      ],
    ],
  },
  /** Lucide `shield`. */
  shield: {
    nodes: [
      [
        'path',
        {
          d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
        },
      ],
    ],
  },
  /** Lucide `sun`. */
  sun: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      ['path', { d: 'M12 2v2' }],
      ['path', { d: 'M12 20v2' }],
      ['path', { d: 'm4.93 4.93 1.41 1.41' }],
      ['path', { d: 'm17.66 17.66 1.41 1.41' }],
      ['path', { d: 'M2 12h2' }],
      ['path', { d: 'M20 12h2' }],
      ['path', { d: 'm6.34 17.66-1.41 1.41' }],
      ['path', { d: 'm19.07 4.93-1.41 1.41' }],
    ],
  },
  /** Lucide `moon`. */
  moon: {
    nodes: [
      [
        'path',
        {
          d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401',
        },
      ],
    ],
  },
  /** Lucide `contrast`. */
  contrast: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 18a6 6 0 0 0 0-12v12z' }],
    ],
  },
} as const satisfies Record<string, Glyph>;

/** The name of a glyph in the inventory. */
export type GlyphName = keyof typeof GLYPHS;

/** Every glyph name, in inventory order. */
export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];
