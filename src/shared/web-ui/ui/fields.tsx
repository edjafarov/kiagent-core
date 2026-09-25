import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icon-sprite';
import { Button } from './buttons';
import { cx } from './cx';

/* Every field's `className` goes on its outer box: the wrapper for
   TextField and Select, the element itself for TextArea. */

export interface TextFieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
  /** Adds a leading search icon. */
  search?: boolean;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    props: TextFieldProps,
    ref: React.ForwardedRef<HTMLInputElement>,
  ) {
    const { search, className, ...rest } = props;
    return (
      <span className={cx('ui-input', search && 'is-search', className)}>
        {search && <Icon name="search" size={14} />}
        <input ref={ref} {...rest} />
      </span>
    );
  },
);

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  className?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select(
    props: SelectProps,
    ref: React.ForwardedRef<HTMLSelectElement>,
  ) {
    const { className, ...rest } = props;
    return (
      <span className={cx('ui-select', className)}>
        <select ref={ref} {...rest} />
        <Icon name="chev-down" size={12} />
      </span>
    );
  },
);

export interface TextAreaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea(
    props: TextAreaProps,
    ref: React.ForwardedRef<HTMLTextAreaElement>,
  ) {
    const { className, ...rest } = props;
    return (
      <textarea ref={ref} className={cx('ui-textarea', className)} {...rest} />
    );
  },
);

const COPIED_MS = 1500;

function clipboardCopy(text: string): Promise<void> {
  if (!navigator.clipboard)
    return Promise.reject(new Error('clipboard unavailable'));
  return navigator.clipboard.writeText(text);
}

/** A read-only literal value (URL, path, token) with a Copy button. */
export function CopyField(props: {
  value: string;
  'aria-label': string;
  copy?: (text: string) => Promise<void>;
}): React.ReactElement {
  const { value, copy = clipboardCopy } = props;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async (): Promise<void> => {
    try {
      await copy(value);
    } catch {
      return; // clipboard refused — the button stays "Copy"
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="ui-copy">
      <span className="ui-copy-v" title={value}>
        {value}
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={copied ? 'check' : 'copy'}
        aria-label={`Copy ${props['aria-label']}`}
        onClick={() => void onCopy()}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function CodeBlock(props: { children: string }): React.ReactElement {
  return (
    <pre className="ui-code">
      <code>{props.children}</code>
    </pre>
  );
}
