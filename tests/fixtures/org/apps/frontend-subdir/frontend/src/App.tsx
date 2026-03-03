import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { formatDate } from '@acme/utils';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  return (
    <main>
      <h1>Frontend Subdir App</h1>
      <p>Today: {formatDate(today)}</p>
      <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
        {loading ? 'Loading…' : 'Submit'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
    </main>
  );
}

export default App;
