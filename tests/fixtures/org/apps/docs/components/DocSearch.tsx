import React, { useState } from 'react';
import { Input, Tooltip } from '@acme/ui';

interface DocSearchProps {
  placeholder?: string;
}

export function DocSearch({ placeholder = 'Search…' }: DocSearchProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);

  return (
    <div className="doc-search">
      <Tooltip
        content="Search across all components, utilities, and guides"
        placement="bottom"
        disabled={focused}
      >
        <Input
          type="search"
          value={value}
          onChange={e => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          size="lg"
          fullWidth
          aria-label="Search documentation"
        />
      </Tooltip>

      {value.length > 0 && (
        <div className="search-hint">
          <Tooltip content="Clear search field" placement="right">
            <button
              className="clear-btn"
              onClick={() => setValue('')}
              aria-label="Clear"
            >
              ✕
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
