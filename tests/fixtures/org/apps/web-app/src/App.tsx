import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { Icon } from '@acme/ui/icons';
import { formatDate } from '@acme/utils';
import { Header } from './components/Header';
import { UserProfile } from './components/UserProfile';
import { localHelper } from '@/lib/helpers';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  // localHelper comes from an internal @/ alias — should NOT be tracked
  const greeting = localHelper('hello');

  return (
    <main className="app">
      {/* Header and UserProfile are local components — should NOT be tracked */}
      <Header lastUpdated={today} />
      <UserProfile />

      <h1>Web App</h1>

      <p>Today: {formatDate(today)}</p>

      <section className="actions">
        <Button
          variant="primary"
          onClick={() => setLoading(true)}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Submit'}
        </Button>

        <Button variant="secondary" onClick={() => setLoading(false)}>
          Reset
        </Button>

        <Button variant="ghost" size="sm">
          Learn more
        </Button>

        <Icon name="arrow-right" size={16} />
      </section>
    </main>
  );
}

export default App;
