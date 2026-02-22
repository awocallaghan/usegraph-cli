import React, { useState } from 'react';
import { Button, Modal } from '@acme/ui';
import { StatsPanel } from './components/StatsPanel';
import { DataTable } from './components/DataTable';

type ViewMode = 'overview' | 'details';

export function App() {
  const [view, setView] = useState<ViewMode>('overview');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function handleDelete(id: string) {
    setSelectedId(id);
    setConfirmOpen(true);
  }

  function handleConfirm() {
    console.log('Deleting', selectedId);
    setConfirmOpen(false);
    setSelectedId(null);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Analytics Dashboard</h1>
        <nav>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView('overview')}
            disabled={view === 'overview'}
          >
            Overview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView('details')}
            disabled={view === 'details'}
          >
            Details
          </Button>
        </nav>
      </header>

      <main>
        {view === 'overview' ? (
          <StatsPanel />
        ) : (
          <DataTable onDelete={handleDelete} />
        )}
      </main>

      <Modal
        open={confirmOpen}
        title="Confirm Delete"
        onClose={() => setConfirmOpen(false)}
      >
        <p>Are you sure you want to delete item {selectedId}?</p>
        <Button variant="danger" onClick={handleConfirm}>
          Delete
        </Button>
        <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
          Cancel
        </Button>
      </Modal>
    </div>
  );
}

export default App;
