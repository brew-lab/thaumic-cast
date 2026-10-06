import type { FunctionComponent } from 'preact';
import {
  AnnouncerSpecimen,
  ClusterSpecimen,
  ColourSpecimen,
  ElevationSpecimen,
  FocusSpecimen,
  IconSpecimen,
  MotionSpecimen,
  ShapeSpecimen,
  SizeSpecimen,
  SpaceSpecimen,
  TypeSpecimen,
  UtilitiesSpecimen,
} from './foundations';

/** One catalogue section: an item or a group of tokens, drawn in light and in dark. */
export interface CatalogueSection {
  /** The anchor id, also used to name the section's screenshots. */
  id: string;
  /** The heading. */
  title: string;
  /** The tier and the DESIGN.md id, e.g. "Tier 0 · T-colour". */
  tier: string;
  /** One line on what the section shows. */
  summary: string;
  /** The specimen, rendered once per colour scheme. It must not use ids. */
  Specimen: FunctionComponent;
}

/**
 * Every section, in DESIGN.md order. Phase 0 is the foundations; each later phase adds its
 * items here (atoms, molecules, components, shells), with every kind and §3 state.
 */
export const SECTIONS: CatalogueSection[] = [
  {
    id: 'colour',
    title: 'Colour',
    tier: 'Tier 0 · T-colour',
    summary: 'Semantic tokens, the status sets and the primitive ladders.',
    Specimen: ColourSpecimen,
  },
  {
    id: 'type',
    title: 'Type',
    tier: 'Tier 0 · T-type',
    summary: 'Geist 600 for headings, the system face at 400 and 600 for the rest.',
    Specimen: TypeSpecimen,
  },
  {
    id: 'space',
    title: 'Space',
    tier: 'Tier 0 · T-space',
    summary: 'Steps 1 to 4 are fixed control internals; 5 to 8 are fluid.',
    Specimen: SpaceSpecimen,
  },
  {
    id: 'shape',
    title: 'Radius, shape and line',
    tier: 'Tier 0 · T-shape',
    summary: 'Rest, bevel and pressed shapes, the radii and the two lines.',
    Specimen: ShapeSpecimen,
  },
  {
    id: 'elevation',
    title: 'Elevation',
    tier: 'Tier 0 · T-elev',
    summary: 'The one shadow, for top-layer surfaces, and the surface steps.',
    Specimen: ElevationSpecimen,
  },
  {
    id: 'sizes',
    title: 'Targets and sizes',
    tier: 'Tier 0 · T-target, T-size',
    summary: 'Control heights at both densities, and the fixed geometry.',
    Specimen: SizeSpecimen,
  },
  {
    id: 'motion',
    title: 'Motion',
    tier: 'Tier 0 · T-motion',
    summary: 'Durations and easings. Reduced motion swaps shapes and holds the drift.',
    Specimen: MotionSpecimen,
  },
  {
    id: 'focus',
    title: 'Focus ring',
    tier: 'Tier 0 · T-focus',
    summary: 'A 2 px ring outside a 2 px gap, on the ground and on a card.',
    Specimen: FocusSpecimen,
  },
  {
    id: 'icons',
    title: 'Icons',
    tier: 'Tier 1 · A-icon, F-icons',
    summary: 'The 33 glyphs at sm, md and lg, in currentColor.',
    Specimen: IconSpecimen,
  },
  {
    id: 'utilities',
    title: 'Utilities',
    tier: 'Tier 0 · F-utils',
    summary: '.num, .mono and .visually-hidden.',
    Specimen: UtilitiesSpecimen,
  },
  {
    id: 'cluster',
    title: 'Cluster',
    tier: 'Tier 0 · F-utils',
    summary: 'The one row layout: gap, justify and stack.',
    Specimen: ClusterSpecimen,
  },
  {
    id: 'announcer',
    title: 'Announcer',
    tier: 'Tier 1 · A-announcer',
    summary: 'One polite and one assertive region per surface; nothing is said on open.',
    Specimen: AnnouncerSpecimen,
  },
];
