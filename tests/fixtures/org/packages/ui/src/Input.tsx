import React from 'react';
import { debounce } from '@acme/utils';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps {
  type?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus?: (event: React.FocusEvent<HTMLInputElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  placeholder?: string;
  size?: InputSize;
  disabled?: boolean;
  readOnly?: boolean;
  fullWidth?: boolean;
  id?: string;
  name?: string;
  'aria-label'?: string;
  className?: string;
}

export function Input({
  type = 'text',
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  placeholder,
  size = 'md',
  disabled = false,
  readOnly = false,
  fullWidth = false,
  id,
  name,
  'aria-label': ariaLabel,
  className,
}: InputProps) {
  const debouncedChange = onChange ? debounce(onChange, 0) : undefined;

  return (
    <input
      type={type}
      id={id}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onChange={debouncedChange}
      onFocus={onFocus}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      aria-label={ariaLabel}
      className={[
        'input',
        `input--${size}`,
        fullWidth ? 'input--full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
