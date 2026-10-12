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
import {
  ArtworkSpecimen,
  BadgeSpecimen,
  BrandBlockSpecimen,
  ButtonSpecimen,
  CheckboxSpecimen,
  ChipSpecimen,
  ClacksSpecimen,
  DividerSpecimen,
  IconButtonSpecimen,
  MeterSpecimen,
  NavItemSpecimen,
  RadioSpecimen,
  SectionHeaderSpecimen,
  SegmentedSpecimen,
  SelectSpecimen,
  SliderSpecimen,
  StatusDotSpecimen,
  StepIndicatorSpecimen,
  SwitchSpecimen,
  TextInputSpecimen,
  TooltipSpecimen,
} from './atoms';

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
  /** Draw the two schemes one above the other, for a specimen wider than half the page. */
  wide?: boolean;
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
  {
    id: 'button',
    wide: true,
    title: 'Button',
    tier: 'Tier 1 · A-button',
    summary: 'Every kind and state; done and failed hold until the next press.',
    Specimen: ButtonSpecimen,
  },
  {
    id: 'icon-button',
    wide: true,
    title: 'IconButton',
    tier: 'Tier 1 · A-iconbtn',
    summary: 'Quiet and tonal; pressed swaps the glyph; never under the target.',
    Specimen: IconButtonSpecimen,
  },
  {
    id: 'text-input',
    title: 'TextInput',
    tier: 'Tier 1 · A-text',
    summary: 'Text, address and search. It never reshapes.',
    Specimen: TextInputSpecimen,
  },
  {
    id: 'switch',
    title: 'Switch',
    tier: 'Tier 1 · A-switch',
    summary: 'Only the thumb reshapes; the ring goes round the track.',
    Specimen: SwitchSpecimen,
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    tier: 'Tier 1 · A-check',
    summary: 'The row takes the layer and the ring; the box takes the small bevel.',
    Specimen: CheckboxSpecimen,
  },
  {
    id: 'radio',
    title: 'Radio',
    tier: 'Tier 1 · A-radio',
    summary: 'Round in every state; the option takes the layer and the ring.',
    Specimen: RadioSpecimen,
  },
  {
    id: 'segmented',
    title: 'SegmentedControl',
    tier: 'Tier 1 · A-segment',
    summary: 'Chosen: fill, weight and the check. The ring goes round the track.',
    Specimen: SegmentedSpecimen,
  },
  {
    id: 'select',
    title: 'Select',
    tier: 'Tier 1 · A-select',
    summary: 'A real select; a styled listbox where the browser draws one.',
    Specimen: SelectSpecimen,
  },
  {
    id: 'slider',
    title: 'Slider',
    tier: 'Tier 1 · A-slider',
    summary: 'Click anywhere on the track to set it; Page Up and Down step ten.',
    Specimen: SliderSpecimen,
  },
  {
    id: 'badge',
    wide: true,
    title: 'Badge',
    tier: 'Tier 1 · A-badge',
    summary: 'Never colour alone: warning, danger and busy carry a shape.',
    Specimen: BadgeSpecimen,
  },
  {
    id: 'status-dot',
    title: 'StatusDot',
    tier: 'Tier 1 · A-dot',
    summary: 'A dot, the Clacks, circle-x and the lamp; always beside words.',
    Specimen: StatusDotSpecimen,
  },
  {
    id: 'clacks',
    title: 'Clacks',
    tier: 'Tier 1 · A-clacks',
    summary: 'The only busy indicator, always with words.',
    Specimen: ClacksSpecimen,
  },
  {
    id: 'artwork',
    title: 'Artwork',
    tier: 'Tier 1 · A-art',
    summary: 'The placeholder stays under the image; a failed image keeps it.',
    Specimen: ArtworkSpecimen,
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    tier: 'Tier 1 · A-tooltip',
    summary: 'After 500 ms of hover, at once on focus; Esc hides it.',
    Specimen: TooltipSpecimen,
  },
  {
    id: 'divider',
    title: 'Divider',
    tier: 'Tier 1 · A-divider',
    summary: 'A hairline of --divider.',
    Specimen: DividerSpecimen,
  },
  {
    id: 'chip',
    title: 'Chip',
    tier: 'Tier 1 · A-chip',
    summary: 'Input kind only; Delete or Backspace removes it.',
    Specimen: ChipSpecimen,
  },
  {
    id: 'section-header',
    title: 'SectionHeader',
    tier: 'Tier 1 · A-heading',
    summary: 'Card and live ("Casting now", once per screen).',
    Specimen: SectionHeaderSpecimen,
  },
  {
    id: 'nav-item',
    title: 'NavItem',
    tier: 'Tier 1 · A-nav',
    summary: 'Current: fill, edge and weight; calm.',
    Specimen: NavItemSpecimen,
  },
  {
    id: 'brand-block',
    title: 'BrandBlock',
    tier: 'Tier 1 · A-brand',
    summary: 'The mark (lit while casting) and the name.',
    Specimen: BrandBlockSpecimen,
  },
  {
    id: 'step-indicator',
    title: 'StepIndicator',
    tier: 'Tier 1 · A-step',
    summary: 'Done, current and to come differ in shape.',
    Specimen: StepIndicatorSpecimen,
  },
  {
    id: 'meter',
    title: 'Meter',
    tier: 'Tier 1 · A-meter',
    summary: 'Desktop diagnostics: low adds the warning fill and glyph.',
    Specimen: MeterSpecimen,
  },
];
