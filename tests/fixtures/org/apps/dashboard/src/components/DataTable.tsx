import React, { useState, useCallback } from 'react';
import { Button, Badge } from '@acme/ui';
import { formatCurrency, debounce } from '@acme/utils';

interface Row {
  id: string;
  name: string;
  amount: number;
  status: 'active' | 'pending' | 'closed';
}

const MOCK_ROWS: Row[] = [
  { id: 'acc-001', name: 'Acme Corp',        amount: 42_000,  status: 'active'  },
  { id: 'acc-002', name: 'Globex Ltd',        amount: 18_500,  status: 'pending' },
  { id: 'acc-003', name: 'Initech Solutions', amount: 73_250,  status: 'active'  },
  { id: 'acc-004', name: 'Umbrella Inc',      amount: 9_900,   status: 'closed'  },
  { id: 'acc-005', name: 'Soylent Green',     amount: 130_000, status: 'active'  },
];

interface DataTableProps {
  onDelete: (id: string) => void;
}

export function DataTable({ onDelete }: DataTableProps) {
  const [query, setQuery] = useState('');
  const [filtered, setFiltered] = useState(MOCK_ROWS);

  const handleSearch = useCallback(
    debounce((q: string) => {
      setFiltered(MOCK_ROWS.filter(r => r.name.toLowerCase().includes(q.toLowerCase())));
    }, 300),
    [],
  );

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    handleSearch(q);
  }

  return (
    <section className="data-table-section">
      <div className="table-toolbar">
        <input
          type="search"
          value={query}
          onChange={onChange}
          placeholder="Search accounts…"
          className="search-input"
        />
        <Button variant="primary" size="sm" onClick={() => setFiltered(MOCK_ROWS)}>
          Reset
        </Button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(row => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{formatCurrency(row.amount)}</td>
              <td>
                <Badge
                  variant={
                    row.status === 'active'
                      ? 'success'
                      : row.status === 'pending'
                      ? 'warning'
                      : 'neutral'
                  }
                >
                  {row.status}
                </Badge>
              </td>
              <td>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => console.log('edit', row.id)}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => onDelete(row.id)}
                >
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
