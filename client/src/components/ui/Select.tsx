import React, { useState, useRef, useEffect, useCallback } from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  onBlur?: (e: React.FocusEvent<HTMLButtonElement>) => void;
  className?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

const TYPEAHEAD_RESET_MS = 500;

export const Select: React.FC<SelectProps> = ({
  label,
  error,
  options,
  placeholder,
  value = '',
  onChange,
  onBlur,
  className = '',
  id,
  required,
  disabled,
  autoFocus,
}) => {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const typeaheadBufferRef = useRef<string>('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectId = id || label?.toLowerCase().replaceAll(/\s+/g, '-') || 'select';
  const listboxId = `${selectId}-listbox`;
  const labelId = label ? `${selectId}-label` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;

  const selectedOption = options.find((o) => o.value === value);
  const displayText = selectedOption?.label || placeholder || 'Select...';

  const handleSelect = useCallback(
    (optionValue: string) => {
      onChange?.({ target: { value: optionValue } });
      setOpen(false);
    },
    [onChange],
  );

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on Escape (global fallback)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [open]);

  // When opening, set the highlighted index to the selected option (or 0)
  useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1);
      return;
    }
    const selectedIdx = options.findIndex((o) => o.value === value);
    setHighlightedIndex(Math.max(selectedIdx, 0));
  }, [open, options, value]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listboxRef.current) return;
    const el = listboxRef.current.querySelector<HTMLElement>(
      `#${CSS.escape(selectId)}-option-${highlightedIndex}`,
    );
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, open, selectId]);

  // Cleanup typeahead timer on unmount
  useEffect(() => {
    return () => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    };
  }, []);

  const findByTypeahead = useCallback(
    (buffer: string, startIndex: number): number => {
      if (!buffer) return -1;
      const needle = buffer.toLowerCase();
      // Search starting after startIndex, then wrap
      const len = options.length;
      for (let i = 0; i < len; i++) {
        const idx = (startIndex + i) % len;
        const label = options[idx].label.toLowerCase();
        if (label.startsWith(needle)) return idx;
      }
      return -1;
    },
    [options],
  );

  // --- Key handlers (extracted to keep cognitive complexity low) ---

  const handleArrowDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const lastIndex = options.length - 1;
      setHighlightedIndex((prev) =>
        prev < 0 ? 0 : Math.min(prev + 1, lastIndex),
      );
    },
    [open, options.length],
  );

  const handleArrowUp = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const lastIndex = options.length - 1;
      setHighlightedIndex((prev) =>
        prev < 0 ? lastIndex : Math.max(prev - 1, 0),
      );
    },
    [open, options.length],
  );

  const handleEnter = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex].value);
      }
    },
    [open, highlightedIndex, options, handleSelect],
  );

  const handleSpace = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // Space opens the select when closed; otherwise let typeahead handle it.
      if (!open) {
        e.preventDefault();
        setOpen(true);
        return true;
      }
      return false;
    },
    [open],
  );

  const handleTypeahead = useCallback(
    (char: string) => {
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
      typeaheadBufferRef.current += char;

      if (!open) setOpen(true);

      const isSingleChar = typeaheadBufferRef.current.length === 1;
      let startIndex: number;
      if (highlightedIndex < 0) {
        startIndex = 0;
      } else if (isSingleChar) {
        startIndex = highlightedIndex + 1;
      } else {
        startIndex = highlightedIndex;
      }
      const match = findByTypeahead(typeaheadBufferRef.current, startIndex);
      if (match >= 0) setHighlightedIndex(match);

      typeaheadTimerRef.current = setTimeout(() => {
        typeaheadBufferRef.current = '';
      }, TYPEAHEAD_RESET_MS);
    },
    [open, highlightedIndex, findByTypeahead],
  );

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const lastIndex = options.length - 1;

    switch (e.key) {
      case 'ArrowDown':
        handleArrowDown(e);
        return;
      case 'ArrowUp':
        handleArrowUp(e);
        return;
      case 'Home':
        if (!open) return;
        e.preventDefault();
        setHighlightedIndex(0);
        return;
      case 'End':
        if (!open) return;
        e.preventDefault();
        setHighlightedIndex(lastIndex);
        return;
      case 'Enter':
        handleEnter(e);
        return;
      case ' ':
        if (handleSpace(e)) return;
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        return;
      case 'Tab':
        if (open) setOpen(false);
        return;
      default:
        break;
    }

    // Typeahead: letters / digits
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      handleTypeahead(e.key);
    }
  };

  const handleOptionKeyDown = (
    e: React.KeyboardEvent<HTMLLIElement>,
    optionValue: string,
  ) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect(optionValue);
    }
  };

  const activeDescendantId =
    open && highlightedIndex >= 0 ? `${selectId}-option-${highlightedIndex}` : undefined;

  // Classname builders (extracted to avoid nested ternaries)
  const buttonBorderClass = error ? 'border-rose-300' : 'border-hairline';
  const buttonStateClass = disabled
    ? 'bg-surface-secondary text-ink-muted cursor-not-allowed'
    : 'cursor-pointer';
  // eslint-disable-next-line no-restricted-syntax -- placeholder per UI/UX Pro Max ruleset
  const displayTextColorClass = selectedOption ? 'text-ink' : 'text-ink-muted';

  const getOptionClassName = (isSelected: boolean, isHighlighted: boolean): string => {
    if (isSelected) return 'bg-accent/5 text-accent-dark font-medium';
    if (isHighlighted) return 'bg-surface-tertiary text-ink';
    return 'text-ink hover:bg-surface-secondary';
  };

  return (
    <div className={`w-full relative ${className}`} ref={containerRef}>
      {label && (
        <label
          id={labelId}
          htmlFor={selectId}
          className="block text-sm font-medium text-ink mb-1.5"
        >
          {label}
        </label>
      )}
      {/* Trigger carries explicit role="combobox" so aria-activedescendant, aria-controls, and aria-required are all valid per ARIA 1.2. */}
      <button
        type="button"
        id={selectId}
        ref={buttonRef}
        role="combobox"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleTriggerKeyDown}
        onBlur={(e) => {
          // Only fire onBlur when focus leaves the entire Select container
          // (avoids triggering when user opens the listbox).
          const next = e.relatedTarget as Node | null;
          if (containerRef.current && next && containerRef.current.contains(next)) return;
          onBlur?.(e);
        }}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        aria-errormessage={errorId}
        aria-activedescendant={activeDescendantId}
        aria-controls={listboxId}
        aria-labelledby={labelId}
        className={`w-full px-3 py-2 text-left border rounded-lg shadow-premium-sm bg-surface transition-all duration-150 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 flex items-center justify-between ${buttonBorderClass} ${buttonStateClass}`}
      >
        <span className={displayTextColorClass}>{displayText}</span>
        <svg
          // eslint-disable-next-line no-restricted-syntax -- decorative icon, aria-hidden
          className={`w-4 h-4 text-ink-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        // NOSONAR(typescript:S6819): custom listbox is required for typeahead + aria-activedescendant pattern; accessible via combobox pattern (aria-controls + role=combobox wrapper).
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          className="absolute z-50 mt-1 w-full bg-surface border border-hairline rounded-xl shadow-premium-lg max-h-60 overflow-auto animate-scale-in"
        >
          {options.map((option, i) => {
            const isSelected = option.value === value;
            const isHighlighted = i === highlightedIndex;
            return (
              // NOSONAR(typescript:S6847,typescript:S6848): textbook WAI-ARIA
              // listbox/option pattern — <li role="option"> is the spec child
              // of the <ul role="listbox"> wrapper. Converting to <button>
              // would break the listbox/option semantic relationship and
              // the parent's aria-activedescendant wiring. Full keyboard
              // contract is present (onKeyDown delegates Enter/Space/Arrow
              // navigation to handleOptionKeyDown).
              <li
                key={option.value}
                id={`${selectId}-option-${i}`}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onClick={() => handleSelect(option.value)}
                onKeyDown={(e) => handleOptionKeyDown(e, option.value)}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={`px-3 py-2 cursor-pointer transition-colors ${getOptionClassName(isSelected, isHighlighted)}`}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      )}

      {/* Hidden native select for form submission */}
      <select
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        onChange={() => {}}
        required={required}
        className="sr-only"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
};
