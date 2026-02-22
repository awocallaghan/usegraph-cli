import React from 'react';
import { Badge } from '@acme/ui';
import { formatCurrency } from '@acme/utils';

interface Stat {
  label: string;
  value: number;
  change: number;
  status: 'up' | 'down' | 'neutral';
}

const STATS: Stat[] = [
  { label: 'Total Revenue',  value: 1_284_500, change: 12.4,  status: 'up'      },
  { label: 'Monthly Active', value: 48_320,    change: -3.1,  status: 'down'    },
  { label: 'New Signups',    value: 2_190,     change: 0,     status: 'neutral' },
  { label: 'Churn Rate',     value: 420,       change: -8.7,  status: 'up'      },
];

export function StatsPanel() {
  return (
    <section className="stats-panel">
      <h2>Key Metrics</h2>
      <div className="stats-grid">
        {STATS.map(stat => (
          <div key={stat.label} className="stat-card">
            <span className="stat-label">{stat.label}</span>
            <span className="stat-value">{formatCurrency(stat.value)}</span>
            <Badge
              variant={stat.status === 'up' ? 'success' : stat.status === 'down' ? 'danger' : 'neutral'}
              size="sm"
            >
              {stat.change > 0 ? '+' : ''}{stat.change}%
            </Badge>
          </div>
        ))}
      </div>

      <div className="revenue-highlight">
        <p>
          Quarterly target:{' '}
          <strong>{formatCurrency(4_000_000)}</strong>
        </p>
        <Badge variant="info">Q3 2024</Badge>
      </div>
    </section>
  );
}
