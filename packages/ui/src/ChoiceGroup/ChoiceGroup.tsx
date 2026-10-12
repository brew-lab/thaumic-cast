import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Radio } from '../Radio';
import styles from './ChoiceGroup.module.css';

/** One choice in a {@link ChoiceGroup}. */
export interface ChoiceOption<T extends string> {
  /** The value. */
  value: T;
  /** The choice's name. */
  label: string;
  /** A line under the name; it is part of the choice's name. */
  description?: ComponentChildren;
}

/** Props for {@link ChoiceGroup}. */
export interface ChoiceGroupProps<T extends string> {
  /** The group's name, e.g. "Quality". */
  legend: string;
  /** Hide the legend visually, when the card heading above already names the group. */
  legendHidden?: boolean;
  /** The chosen value. Every v1 group always has one, so there is no error state. */
  value: T;
  /** Called with the chosen value. */
  onChange: (value: T) => void;
  /** The choices. */
  options: readonly ChoiceOption<T>[];
  /** The radios' group name; one is made when omitted. */
  name?: string;
  /** Disabled: the whole group at 38 %. */
  disabled?: boolean;
}

/**
 * A set of mutually exclusive choices, each with a description (DESIGN.md M-choice). It is
 * a `<fieldset>` of Radio options; each option is one control that takes the state layer,
 * carries the ring and never reshapes or scales, and the chosen one stays calm (the dot, no
 * fill, no weight change). Under 25rem the options are one column; from 25rem they flow into
 * `--track-option` columns. The group bleeds by the option's padding, so each radio lines
 * up with the text above it. It absorbs OptionGroup; the radio-card frame is retired.
 * @param props - Component props
 * @param props.legend - The group's name
 * @param props.legendHidden - Hide the legend visually
 * @param props.value - The chosen value
 * @param props.onChange - Called with the chosen value
 * @param props.options - The choices
 * @param props.name - The radios' group name
 * @param props.disabled - Disabled
 * @returns The group
 */
export function ChoiceGroup<T extends string>({
  legend,
  legendHidden = false,
  value,
  onChange,
  options,
  name,
  disabled = false,
}: ChoiceGroupProps<T>): JSX.Element {
  const ownName = useId();
  const group = name ?? ownName;
  return (
    <fieldset class={styles.group} disabled={disabled}>
      <legend class={legendHidden ? 'visually-hidden' : styles.legend}>{legend}</legend>
      <div class={styles.options}>
        {options.map((option) => (
          <Radio
            key={option.value}
            name={group}
            value={option.value}
            label={option.label}
            description={option.description}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
        ))}
      </div>
    </fieldset>
  );
}
