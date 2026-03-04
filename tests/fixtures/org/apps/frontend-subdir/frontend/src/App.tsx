import React, { useState } from 'react';
import { Button, Badge } from '@acme/ui';
import { formatDate } from '@acme/utils';

interface User {
  id: string;
  name: string;
  joinedAt: Date;
  isActive: boolean;
}

interface DashboardProps {
  user: User;
  onAction: (id: string) => void;
}

export function Dashboard({ user, onAction }: DashboardProps) {
  const [loading, setLoading] = useState(false);
  const joined = formatDate(user.joinedAt);

  return (
    <main className="dashboard">
      <header>
        <h1>Welcome, {user.name}</h1>
        <Badge variant={user.isActive ? 'success' : 'neutral'}>
          {user.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </header>
      <p>Member since: {joined}</p>
      <Button
        variant="primary"
        size="lg"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          onAction(user.id);
        }}
      >
        {loading ? 'Processing…' : 'Take Action'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
    </main>
  );
}

export default Dashboard;
