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
import { SetListSpecimen } from './settings';
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
import {
  AddressFieldSpecimen,
  CardSpecimen,
  ChoiceGroupSpecimen,
  CopyFieldSpecimen,
  DescriptionListSpecimen,
  DisclosureSpecimen,
  EmptyStateSpecimen,
  FieldSpecimen,
  NoticeLineSpecimen,
  NoticeSpecimen,
  PageHeaderSpecimen,
  SettingsRowSpecimen,
  ToastSpecimen,
  WizardStepSpecimen,
} from './molecules';
import {
  CastBarSpecimen,
  CastTileSpecimen,
  GroupVolumeSpecimen,
  MediaHeaderSpecimen,
  NoticeSlotSpecimen,
  PopupFramesSpecimen,
  PopupShellSpecimen,
  PopupHeaderSpecimen,
  UpdateAvailableSpecimen,
  RoomPickerSpecimen,
  RoomRowCastSpecimen,
  RoomRowListSpecimen,
  RoomRowPickSpecimen,
  StartLevelSpecimen,
  TabCardSpecimen,
  VideoSyncSpecimen,
} from './popup';
import { SizeRuleSpecimen } from './size';
import { ButtonStatesSpecimen } from './button-states';
import { PressStatesSpecimen } from './press-states';
import {
  ContainerFieldsSpecimen,
  ContainerFramesSpecimen,
  FluidSpecimen,
  RailSpecimen,
} from './containers';

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
    id: 'size',
    wide: true,
    title: 'Size and touch',
    tier: 'Tier 0 · F-size',
    summary:
      'sm is 32 everywhere; md (44 in a window) only for a view’s own action. Every target reaches 44 by its hit area. Use “Show hit areas” to see them; the prototype for the Surface Go 2 tap test.',
    Specimen: SizeRuleSpecimen,
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
    id: 'button-states',
    wide: true,
    title: 'Button states',
    tier: 'Tier 1 · A-button',
    summary:
      'A change of state: the Button fits what it shows, its width morphs, and the old words go before the new ones come. Every kind, long to short and back, then beside a field, in a row, full width and in a SettingsRow.',
    Specimen: ButtonStatesSpecimen,
  },
  {
    id: 'press-states',
    wide: true,
    title: 'Press and focus',
    tier: 'Tier 0 · F-grammar',
    summary:
      'Hover is colour; focus-visible is the bevel and the ring; a press morphs to the bevel and back, held for the morph so a quick click or Enter shows it in full. Nothing scales. Every Button kind and every other pressable atom, live, then each state forced.',
    Specimen: PressStatesSpecimen,
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
  {
    id: 'field',
    title: 'Field',
    tier: 'Tier 2 · M-field',
    summary: 'Label, control and one slot: the error replaces the status, which replaces the help.',
    Specimen: FieldSpecimen,
  },
  {
    id: 'settings-row',
    wide: true,
    title: 'SettingsRow',
    tier: 'Tier 2 · M-setrow',
    summary: 'Compact, medium and wide cards; wide controls stack until 45rem; the detail slot.',
    Specimen: SettingsRowSpecimen,
  },
  {
    id: 'choice-group',
    title: 'ChoiceGroup',
    tier: 'Tier 2 · M-choice',
    summary: 'Radio options in option-track columns from 25rem; the chosen one stays calm.',
    Specimen: ChoiceGroupSpecimen,
  },
  {
    id: 'copy-field',
    title: 'CopyField',
    tier: 'Tier 2 · M-copy, P-copy',
    summary: 'Copied shows briefly; a refusal reveals and selects the value, with no timer.',
    Specimen: CopyFieldSpecimen,
  },
  {
    id: 'address-field',
    title: 'AddressField',
    tier: 'Tier 2 · M-address, P-forms',
    summary: 'Only the Button is busy; failed is not invalid; the speaker kind keeps Chips.',
    Specimen: AddressFieldSpecimen,
  },
  {
    id: 'description-list',
    title: 'DescriptionList',
    tier: 'Tier 2 · M-dl',
    summary: 'Readout, stat and checklist; pairs share a row from a 25rem card.',
    Specimen: DescriptionListSpecimen,
  },
  {
    id: 'disclosure',
    title: 'Disclosure',
    tier: 'Tier 2 · M-disclosure',
    summary: 'Always details and summary; the summary truncates before the label.',
    Specimen: DisclosureSpecimen,
  },
  {
    id: 'empty-state',
    title: 'EmptyState',
    tier: 'Tier 2 · M-empty',
    summary: 'The idle mark, or the Clacks while searching; stacked and centred from 25rem.',
    Specimen: EmptyStateSpecimen,
  },
  {
    id: 'notice',
    title: 'Notice',
    tier: 'Tier 2 · M-notice',
    summary: 'Banner and section; no role=alert; X only for a dismiss with no consequence.',
    Specimen: NoticeSpecimen,
  },
  {
    id: 'notice-line',
    title: 'NoticeLine',
    tier: 'Tier 2 · M-noticeline',
    summary: 'One item, one row: the row, tile, CastBar, slot and away lines.',
    Specimen: NoticeLineSpecimen,
  },
  {
    id: 'toast',
    title: 'Toast',
    tier: 'Tier 2 · M-toast',
    summary: 'Neutral, in flow, never timed; Esc and X dismiss it.',
    Specimen: ToastSpecimen,
  },
  {
    id: 'wizard-step',
    title: 'WizardStep',
    tier: 'Tier 2 · M-wizardstep',
    summary: 'The disc beside the h2; focus moves to the h2 on a step change.',
    Specimen: WizardStepSpecimen,
  },
  {
    id: 'page-header',
    title: 'PageHeader',
    tier: 'Tier 2 · M-pageheader',
    summary: 'Every page title: the h1, a summary and actions.',
    Specimen: PageHeaderSpecimen,
  },
  {
    id: 'card',
    title: 'Card',
    tier: 'Tier 3 · C-card',
    summary: 'One look; a titled card is a section named by its SectionHeader.',
    Specimen: CardSpecimen,
  },
  {
    id: 'start-level',
    wide: true,
    title: 'StartLevel',
    tier: 'Tier 2 · M-startlevel, P-start',
    summary:
      'Pending until Cast: start = min(now, limit); a level set by hand wins with no warning; “…” while unknown, “Fixed” for a fixed output.',
    Specimen: StartLevelSpecimen,
  },
  {
    id: 'room-row-pick',
    wide: true,
    title: 'RoomRow pick',
    tier: 'Tier 2 · M-roomrow',
    summary:
      'The Checkbox is the row; StartLevel sits outside its label once chosen. The row never tints or reshapes.',
    Specimen: RoomRowPickSpecimen,
  },
  {
    id: 'room-row-cast',
    wide: true,
    title: 'RoomRow cast',
    tier: 'Tier 2 · M-roomrow',
    summary:
      'Mute, the Slider, its value and Remove; joining is inert; a failure adds a row line; the last room has no Remove.',
    Specimen: RoomRowCastSpecimen,
  },
  {
    id: 'room-row-list',
    wide: true,
    title: 'RoomRow list',
    tier: 'Tier 2 · M-roomrow',
    summary: 'Read only: a disc, the name, a sub line and a Badge; nothing is focusable.',
    Specimen: RoomRowListSpecimen,
  },
  {
    id: 'media-header',
    wide: true,
    title: 'MediaHeader',
    tier: 'Tier 2 · M-media',
    summary:
      'One head for the TabCard and both tile forms: the disclosure follows the grammar; the open tile sits on the artwork-seeded band, and the red guard moves Stop off it.',
    Specimen: MediaHeaderSpecimen,
  },
  {
    id: 'group-volume',
    wide: true,
    title: 'GroupVolume',
    tier: 'Tier 2 · M-groupvol, P-addroom',
    summary:
      'One room: its row and Add a room. From two: the master (the mean), then the rooms fold with Add a room last; the last room has no Remove.',
    Specimen: GroupVolumeSpecimen,
  },
  {
    id: 'video-sync',
    wide: true,
    title: 'VideoSync',
    tier: 'Tier 2 · M-videosync',
    summary:
      'One name, “Video sync”, with its phase Badge; the reason, its one action, and Fine-tune for the trim.',
    Specimen: VideoSyncSpecimen,
  },
  {
    id: 'popup-header',
    wide: true,
    title: 'PopupHeader',
    tier: 'Tier 3 · C-popupheader',
    summary:
      'The mark (lit while casting), the status and Settings; never a count. A change is said once.',
    Specimen: PopupHeaderSpecimen,
  },
  {
    id: 'update-available',
    wide: true,
    title: 'Update available: two options',
    tier: 'Tier 3 · C-popupheader, owner call 3',
    summary:
      'Option 2, built: a mark on Settings that opens About; nothing moves. Option 1, drawn for comparison only: a second status line.',
    Specimen: UpdateAvailableSpecimen,
  },
  {
    id: 'room-picker',
    wide: true,
    title: 'RoomPicker',
    tier: 'Tier 3 · C-picker, P-picker',
    summary:
      'Sets, then rooms; the rooms fold from 8, and search lives in the fold: it never unticks and counts the chosen rooms it hides. Not connected, the fieldset is disabled.',
    Specimen: RoomPickerSpecimen,
  },
  {
    id: 'cast-bar',
    wide: true,
    title: 'CastBar',
    tier: 'Tier 3 · C-castbar',
    summary:
      'Cast counts rooms; busy reads “Starting…”; a failure line above with X; one reserved polite line; add mode is Cancel and Add.',
    Specimen: CastBarSpecimen,
  },
  {
    id: 'notice-slot',
    wide: true,
    title: 'NoticeSlot',
    tier: 'Tier 3 · C-noticeslot, P-notices',
    summary:
      'Everything wrong with one cast: the first item in full, the rest as lines; on a compact tile one slot line that opens it.',
    Specimen: NoticeSlotSpecimen,
  },
  {
    id: 'tab-card',
    wide: true,
    title: 'TabCard',
    tier: 'Tier 3 · C-tabcard',
    summary: 'This tab while it is not casting: its head, large, over the RoomPicker.',
    Specimen: TabCardSpecimen,
  },
  {
    id: 'cast-tile',
    wide: true,
    title: 'CastTile',
    tier: 'Tier 3 · C-casttile, P-stop',
    summary:
      'One running cast, compact or open in place; the head is the same element in both. A single cast has no chevron. Stop has no busy words and no Undo.',
    Specimen: CastTileSpecimen,
  },
  {
    id: 'set-list',
    title: 'SetList',
    tier: 'Tier 3 · C-setlist',
    summary:
      'The saved sets in Settings: each with Rename (in place; an empty name is an error) and Remove (at once; the Toast offers Undo). Last cast and Everywhere are not listed.',
    Specimen: SetListSpecimen,
  },
  {
    id: 'popup-shell',
    wide: true,
    title: 'PopupShell and StickyActionBar',
    tier: 'Tier 5 · L-popup, L-bar',
    summary:
      'One scroller; the bar sticks to its end, publishes its size as --overlay-end and the scroller pads by it plus 8 px, so focus is never under it (2.4.11). The hairline shows only while content runs under the bar.',
    Specimen: PopupShellSpecimen,
  },
  {
    id: 'popup-frames',
    wide: true,
    title: 'Containers: the popup components',
    tier: 'Tier 3 · F-containers',
    summary:
      'The picker, a cast’s volume, an open tile and the CastBar in compact, medium and wide frames at both densities: they fill, wrap and never overflow.',
    Specimen: PopupFramesSpecimen,
  },
  {
    id: 'container-frames',
    title: 'Containers: molecules',
    tier: 'Tier 2 · F-containers',
    summary:
      'Every container-query molecule in a compact (22rem), medium (36rem) and wide (52rem) frame, in the popup and desktop densities. Each frame says if the window is too narrow for it.',
    wide: true,
    Specimen: ContainerFramesSpecimen,
  },
  {
    id: 'container-fields',
    title: 'Containers: fields and clusters',
    tier: 'Tier 2 · F-containers',
    summary:
      'AddressField, the growing IP field, CopyField and a stacking Cluster in every range, both densities.',
    wide: true,
    Specimen: ContainerFieldsSpecimen,
  },
  {
    id: 'rail',
    title: 'The rail, narrow and wide',
    tier: 'Tier 1 · A-nav, A-brand',
    summary:
      'BrandBlock and NavItem in a window under 45rem (the mark alone, icon-only items, a Tooltip on hover and focus) and from 45rem.',
    wide: true,
    Specimen: RailSpecimen,
  },
  {
    id: 'fluid',
    title: 'Fluid ramp and a resizable frame',
    tier: 'Tier 0 · F-fluid',
    summary:
      'The fluid type and space steps measured in 352, 640 and 960 px containers, and a frame to drag through every range.',
    wide: true,
    Specimen: FluidSpecimen,
  },
];
