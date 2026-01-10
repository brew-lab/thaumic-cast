import { JSX, Ref } from 'preact';
import { forwardRef } from 'preact/compat';
import styles from './Input.module.css';

export interface InputProps extends Omit<JSX.IntrinsicElements['input'], 'type'> {
  /** Input type */
  type?: 'text' | 'password' | 'email' | 'url' | 'number';
}

/**
 * Shared Input Component
 *
 * Supports ref forwarding for focus management and other DOM operations.
 *
 * @param props - Standard HTML input props
 * @param props.type - Input type
 * @param props.className - Additional CSS class
 * @param ref - Forwarded ref to the underlying input element
 * @returns The rendered Input component
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ type = 'text', className, ...props }, ref: Ref<HTMLInputElement>) => {
    const combinedClass = [styles.input, className].filter(Boolean).join(' ');

    return <input ref={ref} {...props} type={type} className={combinedClass} />;
  },
);
