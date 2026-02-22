import React from 'react';
import { Button } from '@acme/ui';
import { formatDate } from '@acme/utils';

interface HeaderProps {
  lastUpdated: Date;
}

export function Header({ lastUpdated }: HeaderProps) {
  return (
    <header className="header">
      <nav>
        <Button variant="ghost" size="sm" onClick={() => {}}>
          Home
        </Button>
        <Button variant="ghost" size="sm">
          About
        </Button>
      </nav>

      <div className="header-actions">
        <span className="last-updated">
          Updated: {formatDate(lastUpdated, 'short')}
        </span>
        <Button variant="primary" size="md" onClick={() => alert('sign in')}>
          Sign In
        </Button>
      </div>
    </header>
  );
}
