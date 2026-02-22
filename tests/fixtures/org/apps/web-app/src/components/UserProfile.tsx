import React from 'react';
import { Button, Badge, Tooltip } from '@acme/ui';
import { formatDate } from '@acme/utils';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  joinedAt: Date;
  isActive: boolean;
}

interface UserProfileProps {
  user: User;
  onEdit: (id: string) => void;
  onDeactivate: (id: string) => void;
}

export function UserProfile({ user, onEdit, onDeactivate }: UserProfileProps) {
  const joined = formatDate(user.joinedAt);

  return (
    <article className="user-profile">
      <div className="user-header">
        <h2>{user.name}</h2>
        <Badge variant={user.isActive ? 'success' : 'neutral'}>
          {user.isActive ? 'Active' : 'Inactive'}
        </Badge>
        <Badge variant="info">{user.role}</Badge>
      </div>

      <dl>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Joined</dt>
        <dd>{joined}</dd>
      </dl>

      <div className="user-actions">
        <Tooltip content="Edit this user's profile">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(user.id)}
          >
            Edit
          </Button>
        </Tooltip>

        {user.isActive && (
          <Button
            variant="danger"
            size="sm"
            disabled={user.role === 'admin'}
            onClick={() => onDeactivate(user.id)}
          >
            Deactivate
          </Button>
        )}
      </div>
    </article>
  );
}
