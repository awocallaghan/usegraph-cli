import React, { useState } from 'react';
import { Button, Badge, Modal } from '@acme/ui';
import { formatDate } from '@acme/utils';

interface Project {
  id: string;
  name: string;
  createdAt: Date;
  status: 'active' | 'archived';
}

interface ProjectListProps {
  projects: Project[];
  onDelete: (id: string) => void;
}

export function ProjectList({ projects, onDelete }: ProjectListProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <section className="project-list">
      <h2>Projects</h2>
      {projects.map((p) => (
        <div key={p.id} className="project-card">
          <h3>{p.name}</h3>
          <Badge variant={p.status === 'active' ? 'success' : 'neutral'}>
            {p.status}
          </Badge>
          <time>{formatDate(p.createdAt)}</time>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmId(p.id)}
          >
            Delete
          </Button>
        </div>
      ))}
      <Modal
        open={confirmId !== null}
        title="Confirm Delete"
        onClose={() => setConfirmId(null)}
      >
        <Button variant="danger" onClick={() => { onDelete(confirmId!); setConfirmId(null); }}>
          Confirm
        </Button>
        <Button variant="secondary" onClick={() => setConfirmId(null)}>
          Cancel
        </Button>
      </Modal>
    </section>
  );
}

export default ProjectList;
