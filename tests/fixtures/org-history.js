/**
 * Git history definitions for the 6 fixture projects.
 *
 * Each project has a `remote` URL and a `commits` array, ordered oldest-first.
 * Each commit is { date, message, files } where `files` maps relative paths to
 * file content strings. Files carry forward across commits — only specify files
 * that change in each commit. A `null` value removes the file.
 *
 * The final commit of each project reads its content from the existing static
 * fixture files (via readAllFixtures), so those files stay the canonical source
 * of truth. Earlier commits define simpler/older versions inline.
 *
 * Used by:
 *   - tests/e2e.test.js (via initHistoricalRepo)
 *   - scripts/dev-dashboard.js (via initHistoricalRepo)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, 'org');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns an ISO date string for N days before now. */
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Read a single fixture file. */
function readFixture(projectKey, filePath) {
  return readFileSync(join(FIXTURES_ROOT, projectKey, filePath), 'utf-8');
}

/**
 * Recursively read all files in a fixture project dir.
 * Returns { [relativePath]: content } for every file found.
 */
function readAllFixtures(projectKey) {
  const base = join(FIXTURES_ROOT, projectKey);
  const result = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(base, abs);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        result[rel] = readFileSync(abs, 'utf-8');
      }
    }
  }
  walk(base);
  return result;
}

// ── apps/web-app ──────────────────────────────────────────────────────────────
// React + Vite + pnpm. Evolves from Button-only to full component usage.

const webAppStaticFiles = {
  'tsconfig.json':      readFixture('apps/web-app', 'tsconfig.json'),
  '.eslintrc.json':     readFixture('apps/web-app', '.eslintrc.json'),
  'vite.config.ts':     readFixture('apps/web-app', 'vite.config.ts'),
  'vitest.config.ts':   readFixture('apps/web-app', 'vitest.config.ts'),
};

const webAppHistory = {
  remote: 'https://github.com/test-org/web-app.git',
  commits: [
    {
      date: daysAgo(180),
      message: 'feat: initial project setup',
      files: {
        ...webAppStaticFiles,
        'package.json': JSON.stringify({
          name: 'web-app',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@vitejs/plugin-react': '^4.0.0',
            eslint: '^8.45.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
          },
          scripts: { dev: 'vite', build: 'tsc && vite build', lint: 'eslint src --ext ts,tsx' },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@acme/ui':
        specifier: ^1.0.0
        version: 1.0.0
      react:
        specifier: ^18.2.0
        version: 18.2.0
      react-dom:
        specifier: ^18.2.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@vitejs/plugin-react':
        specifier: ^4.0.0
        version: 4.0.0(vite@4.4.7)
      eslint:
        specifier: ^8.45.0
        version: 8.45.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
`,
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';

export function App() {
  const [loading, setLoading] = useState(false);

  return (
    <main className="app">
      <h1>Web App</h1>
      <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
        {loading ? 'Loading\u2026' : 'Submit'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
    </main>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(155),
      message: 'feat: add @acme/utils integration',
      files: {
        'package.json': JSON.stringify({
          name: 'web-app',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.0.0',
            '@acme/utils': '^0.4.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@vitejs/plugin-react': '^4.0.0',
            eslint: '^8.45.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
          },
          scripts: { dev: 'vite', build: 'tsc && vite build', lint: 'eslint src --ext ts,tsx' },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@acme/ui':
        specifier: ^1.0.0
        version: 1.0.0
      '@acme/utils':
        specifier: ^0.4.0
        version: 0.4.0
      react:
        specifier: ^18.2.0
        version: 18.2.0
      react-dom:
        specifier: ^18.2.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@vitejs/plugin-react':
        specifier: ^4.0.0
        version: 4.0.0(vite@4.4.7)
      eslint:
        specifier: ^8.45.0
        version: 8.45.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
`,
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { formatDate } from '@acme/utils';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  return (
    <main className="app">
      <h1>Web App</h1>
      <p>Today: {formatDate(today)}</p>
      <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
        {loading ? 'Loading\u2026' : 'Submit'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
    </main>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(130),
      message: 'feat: add Header component',
      files: {
        'src/components/Header.tsx': `\
import React from 'react';
import { Button } from '@acme/ui';

interface HeaderProps {
  lastUpdated: Date;
}

export function Header({ lastUpdated }: HeaderProps) {
  return (
    <header className="header">
      <nav>
        <Button variant="ghost" size="sm" onClick={() => {}}>Home</Button>
        <Button variant="ghost" size="sm">About</Button>
      </nav>
      <Button variant="primary" size="md" onClick={() => alert('sign in')}>
        Sign In
      </Button>
    </header>
  );
}
`,
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { formatDate } from '@acme/utils';
import { Header } from './components/Header';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  return (
    <main className="app">
      <Header lastUpdated={today} />
      <h1>Web App</h1>
      <p>Today: {formatDate(today)}</p>
      <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
        {loading ? 'Loading\u2026' : 'Submit'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
    </main>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(105),
      message: 'feat: add UserProfile component',
      files: {
        'src/components/UserProfile.tsx': `\
import React from 'react';
import { Button } from '@acme/ui';
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
}

export function UserProfile({ user, onEdit }: UserProfileProps) {
  const joined = formatDate(user.joinedAt);

  return (
    <article className="user-profile">
      <h2>{user.name}</h2>
      <dl>
        <dt>Email</dt><dd>{user.email}</dd>
        <dt>Joined</dt><dd>{joined}</dd>
      </dl>
      <Button variant="outline" size="sm" onClick={() => onEdit(user.id)}>Edit</Button>
    </article>
  );
}
`,
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { formatDate } from '@acme/utils';
import { Header } from './components/Header';
import { UserProfile } from './components/UserProfile';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  return (
    <main className="app">
      <Header lastUpdated={today} />
      <UserProfile />
      <h1>Web App</h1>
      <p>Today: {formatDate(today)}</p>
      <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
        {loading ? 'Loading\u2026' : 'Submit'}
      </Button>
      <Button variant="secondary" onClick={() => setLoading(false)}>
        Reset
      </Button>
      <Button variant="ghost" size="sm">Learn more</Button>
    </main>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(85),
      message: 'feat: enrich UserProfile with Badge and Tooltip',
      files: {
        'package.json': JSON.stringify({
          name: 'web-app',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.1.0',
            '@acme/utils': '^0.4.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@vitejs/plugin-react': '^4.0.0',
            eslint: '^8.45.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: {
            dev: 'vite', build: 'tsc && vite build', test: 'vitest run',
            lint: 'eslint src --ext ts,tsx',
          },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@acme/ui':
        specifier: ^1.1.0
        version: 1.1.0
      '@acme/utils':
        specifier: ^0.4.0
        version: 0.4.0
      react:
        specifier: ^18.2.0
        version: 18.2.0
      react-dom:
        specifier: ^18.2.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@vitejs/plugin-react':
        specifier: ^4.0.0
        version: 4.0.0(vite@4.4.7)
      eslint:
        specifier: ^8.45.0
        version: 8.45.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
      vitest:
        specifier: ^0.34.1
        version: 0.34.1(vite@4.4.7)
`,
        'src/components/UserProfile.tsx': `\
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
      </div>
      <dl>
        <dt>Email</dt><dd>{user.email}</dd>
        <dt>Joined</dt><dd>{joined}</dd>
      </dl>
      <Tooltip content="Edit this user's profile">
        <Button variant="outline" size="sm" onClick={() => onEdit(user.id)}>Edit</Button>
      </Tooltip>
    </article>
  );
}
`,
      },
    },
    {
      date: daysAgo(65),
      message: 'feat: add icon support via @acme/ui/icons',
      files: {
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';
import { Icon } from '@acme/ui/icons';
import { formatDate } from '@acme/utils';
import { Header } from './components/Header';
import { UserProfile } from './components/UserProfile';

export function App() {
  const [loading, setLoading] = useState(false);
  const today = new Date('2024-01-15');

  return (
    <main className="app">
      <Header lastUpdated={today} />
      <UserProfile />
      <h1>Web App</h1>
      <p>Today: {formatDate(today)}</p>
      <section className="actions">
        <Button variant="primary" onClick={() => setLoading(true)} disabled={loading}>
          {loading ? 'Loading\u2026' : 'Submit'}
        </Button>
        <Button variant="secondary" onClick={() => setLoading(false)}>Reset</Button>
        <Button variant="ghost" size="sm">Learn more</Button>
        <Icon name="arrow-right" size={16} />
      </section>
    </main>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(50),
      message: 'chore: update @acme/ui to 1.2.0 and add @testing-library/react',
      files: {
        'package.json': JSON.stringify({
          name: 'web-app',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.2.0',
            '@acme/utils': '^0.5.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@testing-library/react': '^14.0.0',
            '@vitejs/plugin-react': '^4.0.0',
            eslint: '^8.45.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: {
            dev: 'vite', build: 'tsc && vite build', test: 'vitest run',
            lint: 'eslint src --ext ts,tsx',
          },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@acme/ui':
        specifier: ^1.2.0
        version: 1.2.0
      '@acme/utils':
        specifier: ^0.5.0
        version: 0.5.0
      react:
        specifier: ^18.2.0
        version: 18.2.0
      react-dom:
        specifier: ^18.2.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@testing-library/react':
        specifier: ^14.0.0
        version: 14.0.0(react@18.2.0)
      '@vitejs/plugin-react':
        specifier: ^4.0.0
        version: 4.0.0(vite@4.4.7)
      eslint:
        specifier: ^8.45.0
        version: 8.45.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
      vitest:
        specifier: ^0.34.1
        version: 0.34.1(vite@4.4.7)
`,
      },
    },
    {
      date: daysAgo(35),
      message: 'feat: add Header date display and formatDate to utils',
      files: {
        'src/components/Header.tsx': readFixture('apps/web-app', 'src/components/Header.tsx'),
      },
    },
    {
      date: daysAgo(15),
      message: 'feat: add localHelper usage and finalise UserProfile',
      files: {
        'src/components/UserProfile.tsx': readFixture('apps/web-app', 'src/components/UserProfile.tsx'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup and polishing',
      files: readAllFixtures('apps/web-app'),
    },
  ],
};

// ── apps/dashboard ────────────────────────────────────────────────────────────
// React + Webpack + Jest. Evolves from Button-only to full dashboard with Modal.

const dashboardStaticFiles = {
  'tsconfig.json':      readFixture('apps/dashboard', 'tsconfig.json'),
  '.eslintrc.json':     readFixture('apps/dashboard', '.eslintrc.json'),
  'webpack.config.js':  readFixture('apps/dashboard', 'webpack.config.js'),
  'jest.config.js':     readFixture('apps/dashboard', 'jest.config.js'),
  'src/index.tsx':      readFixture('apps/dashboard', 'src/index.tsx'),
};

const dashboardHistory = {
  remote: 'https://github.com/test-org/dashboard.git',
  commits: [
    {
      date: daysAgo(170),
      message: 'feat: initial dashboard setup',
      files: {
        ...dashboardStaticFiles,
        'package.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@babel/core': '^7.22.0',
            '@babel/preset-env': '^7.22.0',
            '@babel/preset-react': '^7.22.0',
            '@babel/preset-typescript': '^7.22.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            eslint: '^8.45.0',
            jest: '^29.6.1',
            'jest-environment-jsdom': '^29.6.1',
            typescript: '^5.1.6',
            webpack: '^5.88.2',
            'webpack-cli': '^5.1.4',
            'webpack-dev-server': '^4.15.1',
          },
          scripts: {
            start: 'webpack serve --mode development',
            build: 'webpack --mode production',
            test: 'jest',
            lint: 'eslint src --ext ts,tsx',
          },
        }, null, 2),
        'package-lock.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'dashboard',
              dependencies: { '@acme/ui': '^1.0.0', react: '^18.2.0', 'react-dom': '^18.2.0' },
            },
            'node_modules/@acme/ui': { version: '1.0.0' },
            'node_modules/react': { version: '18.2.0' },
            'node_modules/react-dom': { version: '18.2.0' },
          },
        }, null, 2),
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button } from '@acme/ui';

export function App() {
  const [view, setView] = useState('overview');

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Analytics Dashboard</h1>
        <nav>
          <Button variant="ghost" size="sm" onClick={() => setView('overview')}>Overview</Button>
          <Button variant="ghost" size="sm" onClick={() => setView('details')}>Details</Button>
        </nav>
      </header>
      <main>
        <p>Current view: {view}</p>
      </main>
    </div>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(145),
      message: 'feat: add @acme/utils and StatsPanel component',
      files: {
        'package.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.0.0',
            '@acme/utils': '^0.4.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@babel/core': '^7.22.0',
            '@babel/preset-env': '^7.22.0',
            '@babel/preset-react': '^7.22.0',
            '@babel/preset-typescript': '^7.22.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            eslint: '^8.45.0',
            jest: '^29.6.1',
            'jest-environment-jsdom': '^29.6.1',
            typescript: '^5.1.6',
            webpack: '^5.88.2',
            'webpack-cli': '^5.1.4',
            'webpack-dev-server': '^4.15.1',
          },
          scripts: {
            start: 'webpack serve --mode development',
            build: 'webpack --mode production',
            test: 'jest',
            lint: 'eslint src --ext ts,tsx',
          },
        }, null, 2),
        'package-lock.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'dashboard',
              dependencies: {
                '@acme/ui': '^1.0.0', '@acme/utils': '^0.4.0',
                react: '^18.2.0', 'react-dom': '^18.2.0',
              },
            },
            'node_modules/@acme/ui': { version: '1.0.0' },
            'node_modules/@acme/utils': { version: '0.4.0' },
            'node_modules/react': { version: '18.2.0' },
            'node_modules/react-dom': { version: '18.2.0' },
          },
        }, null, 2),
        'src/components/StatsPanel.tsx': `\
import React from 'react';
import { Badge } from '@acme/ui';
import { formatCurrency } from '@acme/utils';

const STATS = [
  { label: 'Total Revenue', value: 1_284_500, status: 'up' as const },
  { label: 'Monthly Active', value: 48_320, status: 'down' as const },
];

export function StatsPanel() {
  return (
    <section className="stats-panel">
      <h2>Key Metrics</h2>
      {STATS.map(stat => (
        <div key={stat.label} className="stat-card">
          <span>{stat.label}</span>
          <span>{formatCurrency(stat.value)}</span>
          <Badge variant={stat.status === 'up' ? 'success' : 'danger'}>{stat.status}</Badge>
        </div>
      ))}
    </section>
  );
}
`,
      },
    },
    {
      date: daysAgo(120),
      message: 'feat: add Modal confirmation dialog',
      files: {
        'src/App.tsx': `\
import React, { useState } from 'react';
import { Button, Modal } from '@acme/ui';
import { StatsPanel } from './components/StatsPanel';

export function App() {
  const [view, setView] = useState('overview');
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Analytics Dashboard</h1>
        <nav>
          <Button variant="ghost" size="sm" onClick={() => setView('overview')}>Overview</Button>
          <Button variant="ghost" size="sm" onClick={() => setView('details')}>Details</Button>
        </nav>
      </header>
      <main>
        {view === 'overview' && <StatsPanel />}
      </main>
      <Modal open={confirmOpen} title="Confirm" onClose={() => setConfirmOpen(false)}>
        <Button variant="danger" onClick={() => setConfirmOpen(false)}>Confirm</Button>
        <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
      </Modal>
    </div>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(90),
      message: 'feat: add DataTable with search and delete',
      files: {
        'src/components/DataTable.tsx': `\
import React, { useState } from 'react';
import { Button, Badge } from '@acme/ui';
import { formatCurrency } from '@acme/utils';

const MOCK_ROWS = [
  { id: 'acc-001', name: 'Acme Corp', amount: 42_000, status: 'active' as const },
  { id: 'acc-002', name: 'Globex Ltd', amount: 18_500, status: 'pending' as const },
];

interface DataTableProps { onDelete: (id: string) => void; }

export function DataTable({ onDelete }: DataTableProps) {
  const [rows] = useState(MOCK_ROWS);
  return (
    <section>
      <table>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{formatCurrency(row.amount)}</td>
              <td><Badge variant={row.status === 'active' ? 'success' : 'warning'}>{row.status}</Badge></td>
              <td>
                <Button variant="ghost" size="sm">Edit</Button>
                <Button variant="danger" size="sm" onClick={() => onDelete(row.id)}>Delete</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
`,
        'src/App.tsx': `\
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Analytics Dashboard</h1>
        <nav>
          <Button variant="ghost" size="sm" onClick={() => setView('overview')}>Overview</Button>
          <Button variant="ghost" size="sm" onClick={() => setView('details')}>Details</Button>
        </nav>
      </header>
      <main>
        {view === 'overview' ? <StatsPanel /> : <DataTable onDelete={handleDelete} />}
      </main>
      <Modal open={confirmOpen} title="Confirm Delete" onClose={() => setConfirmOpen(false)}>
        <p>Delete item {selectedId}?</p>
        <Button variant="danger" onClick={() => setConfirmOpen(false)}>Delete</Button>
        <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
      </Modal>
    </div>
  );
}

export default App;
`,
      },
    },
    {
      date: daysAgo(60),
      message: 'chore: upgrade @acme/ui to 1.2.0 and @acme/utils to 0.5.0',
      files: {
        'package.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.2.0',
            '@acme/utils': '^0.5.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@babel/core': '^7.22.0',
            '@babel/preset-env': '^7.22.0',
            '@babel/preset-react': '^7.22.0',
            '@babel/preset-typescript': '^7.22.0',
            '@testing-library/react': '^14.0.0',
            '@types/jest': '^29.5.3',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            'babel-jest': '^29.6.1',
            eslint: '^8.45.0',
            jest: '^29.6.1',
            'jest-environment-jsdom': '^29.6.1',
            'ts-loader': '^9.4.4',
            typescript: '^5.1.6',
            webpack: '^5.88.2',
            'webpack-cli': '^5.1.4',
            'webpack-dev-server': '^4.15.1',
          },
          scripts: {
            start: 'webpack serve --mode development',
            build: 'webpack --mode production',
            test: 'jest',
            lint: 'eslint src --ext ts,tsx',
          },
        }, null, 2),
        'package-lock.json': JSON.stringify({
          name: 'dashboard',
          version: '0.1.0',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'dashboard',
              dependencies: {
                '@acme/ui': '^1.2.0', '@acme/utils': '^0.5.0',
                react: '^18.2.0', 'react-dom': '^18.2.0',
              },
            },
            'node_modules/@acme/ui': { version: '1.2.0' },
            'node_modules/@acme/utils': { version: '0.5.0' },
            'node_modules/react': { version: '18.2.0' },
            'node_modules/react-dom': { version: '18.2.0' },
          },
        }, null, 2),
      },
    },
    {
      date: daysAgo(30),
      message: 'feat: enrich StatsPanel and DataTable with debounce search',
      files: {
        'src/components/StatsPanel.tsx': readFixture('apps/dashboard', 'src/components/StatsPanel.tsx'),
        'src/components/DataTable.tsx': readFixture('apps/dashboard', 'src/components/DataTable.tsx'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup',
      files: readAllFixtures('apps/dashboard'),
    },
  ],
};

// ── apps/docs ─────────────────────────────────────────────────────────────────
// Next.js + Yarn Berry. Evolves from no-UI to Tooltip-heavy docs site.

const docsStaticFiles = {
  'tsconfig.json':    readFixture('apps/docs', 'tsconfig.json'),
  '.eslintrc.json':   readFixture('apps/docs', '.eslintrc.json'),
  'next.config.js':   readFixture('apps/docs', 'next.config.js'),
  '.yarnrc.yml':      readFixture('apps/docs', '.yarnrc.yml'),
  '.prettierrc':      readFixture('apps/docs', '.prettierrc'),
};

const docsHistory = {
  remote: 'https://github.com/test-org/docs.git',
  commits: [
    {
      date: daysAgo(165),
      message: 'feat: initial Next.js docs site',
      files: {
        ...docsStaticFiles,
        'package.json': JSON.stringify({
          name: 'docs',
          version: '0.1.0',
          private: true,
          dependencies: {
            next: '^14.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@types/node': '^20.5.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            eslint: '^8.45.0',
            'eslint-config-next': '^14.0.0',
            prettier: '^3.0.2',
            typescript: '^5.1.6',
          },
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
          packageManager: 'yarn@4.1.0',
        }, null, 2),
        'yarn.lock': `\
__metadata:
  version: 6
  cacheKey: 8

"next@npm:^14.0.0":
  version: 14.0.4
  resolution: "next@npm:14.0.4"
  checksum: stub
  languageName: node
  linkType: hard

"react@npm:^18.2.0":
  version: 18.2.0
  resolution: "react@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard

"react-dom@npm:^18.2.0":
  version: 18.2.0
  resolution: "react-dom@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard
`,
        'app/page.tsx': `\
import React from 'react';

export default function HomePage() {
  return (
    <main className="docs-home">
      <h1>Acme Design System Docs</h1>
      <p>Everything you need to build consistent UIs at Acme.</p>
    </main>
  );
}
`,
      },
    },
    {
      date: daysAgo(130),
      message: 'feat: add @acme/ui and Button usage',
      files: {
        'package.json': JSON.stringify({
          name: 'docs',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.1.0',
            next: '^14.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@types/node': '^20.5.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            eslint: '^8.45.0',
            'eslint-config-next': '^14.0.0',
            prettier: '^3.0.2',
            typescript: '^5.1.6',
          },
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
          packageManager: 'yarn@4.1.0',
        }, null, 2),
        'yarn.lock': `\
__metadata:
  version: 6
  cacheKey: 8

"@acme/ui@npm:^1.1.0":
  version: 1.1.0
  resolution: "@acme/ui@npm:1.1.0"
  checksum: stub
  languageName: node
  linkType: hard

"next@npm:^14.0.0":
  version: 14.0.4
  resolution: "next@npm:14.0.4"
  checksum: stub
  languageName: node
  linkType: hard

"react@npm:^18.2.0":
  version: 18.2.0
  resolution: "react@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard

"react-dom@npm:^18.2.0":
  version: 18.2.0
  resolution: "react-dom@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard
`,
        'app/page.tsx': `\
import React from 'react';
import { Button } from '@acme/ui';

export default function HomePage() {
  return (
    <main className="docs-home">
      <h1>Acme Design System Docs</h1>
      <p>Everything you need to build consistent UIs at Acme.</p>
      <Button variant="primary">Get Started</Button>
    </main>
  );
}
`,
      },
    },
    {
      date: daysAgo(100),
      message: 'feat: add DocSearch component with Input',
      files: {
        'components/DocSearch.tsx': `\
import React, { useState } from 'react';
import { Input } from '@acme/ui';

interface DocSearchProps { placeholder?: string; }

export function DocSearch({ placeholder = 'Search\u2026' }: DocSearchProps) {
  const [value, setValue] = useState('');
  return (
    <Input
      type="search"
      value={value}
      onChange={e => setValue(e.target.value)}
      placeholder={placeholder}
      size="lg"
      fullWidth
    />
  );
}
`,
        'app/page.tsx': `\
import React from 'react';
import { Button } from '@acme/ui';
import { DocSearch } from '../components/DocSearch';

export default function HomePage() {
  return (
    <main className="docs-home">
      <h1>Acme Design System Docs</h1>
      <DocSearch placeholder="Search docs\u2026" />
      <Button variant="primary">Get Started</Button>
    </main>
  );
}
`,
      },
    },
    {
      date: daysAgo(70),
      message: 'feat: upgrade to Tooltip-based navigation and add @acme/utils',
      files: {
        'package.json': JSON.stringify({
          name: 'docs',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/ui': '^1.2.0',
            '@acme/utils': '^0.5.0',
            next: '^14.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
          },
          devDependencies: {
            '@types/node': '^20.5.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            eslint: '^8.45.0',
            'eslint-config-next': '^14.0.0',
            prettier: '^3.0.2',
            typescript: '^5.1.6',
          },
          scripts: {
            dev: 'next dev', build: 'next build', start: 'next start',
            lint: 'next lint', format: 'prettier --write .',
          },
          packageManager: 'yarn@4.1.0',
        }, null, 2),
        'yarn.lock': `\
__metadata:
  version: 6
  cacheKey: 8

"@acme/ui@npm:^1.2.0":
  version: 1.2.0
  resolution: "@acme/ui@npm:1.2.0"
  dependencies:
    "@acme/utils": "^0.5.0"
    react: "^18.2.0"
  checksum: stub
  languageName: node
  linkType: hard

"@acme/utils@npm:^0.5.0":
  version: 0.5.0
  resolution: "@acme/utils@npm:0.5.0"
  checksum: stub
  languageName: node
  linkType: hard

"next@npm:^14.0.0":
  version: 14.0.4
  resolution: "next@npm:14.0.4"
  checksum: stub
  languageName: node
  linkType: hard

"react@npm:^18.2.0":
  version: 18.2.0
  resolution: "react@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard

"react-dom@npm:^18.2.0":
  version: 18.2.0
  resolution: "react-dom@npm:18.2.0"
  checksum: stub
  languageName: node
  linkType: hard
`,
        'components/DocSearch.tsx': readFixture('apps/docs', 'components/DocSearch.tsx'),
        'app/page.tsx': readFixture('apps/docs', 'app/page.tsx'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup',
      files: readAllFixtures('apps/docs'),
    },
  ],
};

// ── apps/mobile ───────────────────────────────────────────────────────────────
// React Native + Yarn v1 + Jest. Evolves from formatDate-only to full utils usage.

const mobileStaticFiles = {
  'babel.config.js':  readFixture('apps/mobile', 'babel.config.js'),
  '.eslintrc.js':     readFixture('apps/mobile', '.eslintrc.js'),
  'jest.config.js':   readFixture('apps/mobile', 'jest.config.js'),
};

const mobileHistory = {
  remote: 'https://github.com/test-org/mobile.git',
  commits: [
    {
      date: daysAgo(160),
      message: 'feat: initial React Native app',
      files: {
        ...mobileStaticFiles,
        'package.json': JSON.stringify({
          name: 'mobile',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/utils': '^0.3.0',
            react: '18.2.0',
            'react-native': '0.72.4',
          },
          devDependencies: {
            '@babel/core': '^7.20.0',
            '@babel/preset-env': '^7.20.0',
            '@react-native/babel-preset': '^0.72.0',
            '@react-native/eslint-config': '^0.72.0',
            '@react-native/metro-config': '^0.72.0',
            'babel-jest': '^29.2.1',
            eslint: '^8.19.0',
            jest: '^29.2.1',
            'metro-react-native-babel-preset': '^0.76.7',
            'react-test-renderer': '18.2.0',
          },
          scripts: {
            android: 'react-native run-android',
            ios: 'react-native run-ios',
            start: 'react-native start',
            test: 'jest',
            lint: 'eslint .',
          },
          jest: { preset: 'react-native' },
        }, null, 2),
        'yarn.lock': `\
# yarn lockfile v1


"@acme/utils@^0.3.0":
  version "0.3.0"
  resolved "https://registry.npmjs.org/@acme/utils/-/utils-0.3.0.tgz"
  integrity sha512-stub

"react@18.2.0":
  version "18.2.0"
  resolved "https://registry.npmjs.org/react/-/react-18.2.0.tgz"
  integrity sha512-stub
`,
        'src/App.jsx': `\
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { formatDate } from '@acme/utils';

export default function App() {
  const today = new Date('2024-03-01');

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Acme Mobile</Text>
      <Text style={styles.date}>Today: {formatDate(today)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  heading: { fontSize: 28, fontWeight: '700', marginBottom: 16 },
  date: { fontSize: 16, color: '#555' },
});
`,
      },
    },
    {
      date: daysAgo(125),
      message: 'feat: add useLocalStorage for last visit tracking',
      files: {
        'package.json': JSON.stringify({
          name: 'mobile',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/utils': '^0.4.0',
            react: '18.2.0',
            'react-native': '0.72.4',
          },
          devDependencies: {
            '@babel/core': '^7.20.0',
            '@babel/preset-env': '^7.20.0',
            '@react-native/babel-preset': '^0.72.0',
            '@react-native/eslint-config': '^0.72.0',
            '@react-native/metro-config': '^0.72.0',
            'babel-jest': '^29.2.1',
            eslint: '^8.19.0',
            jest: '^29.2.1',
            'metro-react-native-babel-preset': '^0.76.7',
            'react-test-renderer': '18.2.0',
          },
          scripts: {
            android: 'react-native run-android', ios: 'react-native run-ios',
            start: 'react-native start', test: 'jest', lint: 'eslint .',
          },
          jest: { preset: 'react-native' },
        }, null, 2),
        'yarn.lock': `\
# yarn lockfile v1


"@acme/utils@^0.4.0":
  version "0.4.0"
  resolved "https://registry.npmjs.org/@acme/utils/-/utils-0.4.0.tgz"
  integrity sha512-stub

"react@18.2.0":
  version "18.2.0"
  resolved "https://registry.npmjs.org/react/-/react-18.2.0.tgz"
  integrity sha512-stub
`,
        'src/App.jsx': `\
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { formatDate, useLocalStorage } from '@acme/utils';

export default function App() {
  const [lastVisit, setLastVisit] = useLocalStorage('last_visit', null);
  const today = new Date('2024-03-01');

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Acme Mobile</Text>
      <Text style={styles.date}>Today: {formatDate(today)}</Text>
      {lastVisit && <Text>Last visit: {formatDate(new Date(lastVisit))}</Text>}
      <TouchableOpacity onPress={() => setLastVisit(new Date().toISOString())}>
        <Text>Check In</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  heading: { fontSize: 28, fontWeight: '700', marginBottom: 16 },
  date: { fontSize: 16, color: '#555', marginBottom: 8 },
});
`,
      },
    },
    {
      date: daysAgo(90),
      message: 'feat: add AccountScreen with full utils usage',
      files: {
        'src/screens/AccountScreen.jsx': `\
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { formatCurrency, formatDate, useLocalStorage } from '@acme/utils';

const TRANSACTIONS = [
  { id: 'tx-001', label: 'Subscription renewal', amount: 9900, date: '2024-02-28' },
];

export default function AccountScreen() {
  const [currency] = useLocalStorage('preferred_currency', 'USD');
  return (
    <ScrollView>
      {TRANSACTIONS.map(tx => (
        <View key={tx.id}>
          <Text>{tx.label}</Text>
          <Text>{formatDate(new Date(tx.date))}</Text>
          <Text>{formatCurrency(tx.amount, currency)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1 } });
`,
      },
    },
    {
      date: daysAgo(55),
      message: 'chore: upgrade @acme/utils to 0.5.0',
      files: {
        'package.json': JSON.stringify({
          name: 'mobile',
          version: '0.1.0',
          private: true,
          dependencies: {
            '@acme/utils': '^0.5.0',
            react: '18.2.0',
            'react-native': '0.72.4',
          },
          devDependencies: {
            '@babel/core': '^7.20.0',
            '@babel/preset-env': '^7.20.0',
            '@react-native/babel-preset': '^0.72.0',
            '@react-native/eslint-config': '^0.72.0',
            '@react-native/metro-config': '^0.72.0',
            'babel-jest': '^29.2.1',
            eslint: '^8.19.0',
            jest: '^29.2.1',
            'metro-react-native-babel-preset': '^0.76.7',
            'react-test-renderer': '18.2.0',
          },
          scripts: {
            android: 'react-native run-android', ios: 'react-native run-ios',
            start: 'react-native start', test: 'jest', lint: 'eslint .',
          },
          jest: { preset: 'react-native' },
        }, null, 2),
        'yarn.lock': readFixture('apps/mobile', 'yarn.lock'),
      },
    },
    {
      date: daysAgo(20),
      message: 'feat: expand AccountScreen with full transaction list',
      files: {
        'src/App.jsx': readFixture('apps/mobile', 'src/App.jsx'),
        'src/screens/AccountScreen.jsx': readFixture('apps/mobile', 'src/screens/AccountScreen.jsx'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup',
      files: readAllFixtures('apps/mobile'),
    },
  ],
};

// ── packages/ui ───────────────────────────────────────────────────────────────
// Component library. Grows from Button-only to full component set.

const uiStaticFiles = {
  'tsconfig.json':            readFixture('packages/ui', 'tsconfig.json'),
  'vitest.config.ts':         readFixture('packages/ui', 'vitest.config.ts'),
  '.storybook/main.ts':       readFixture('packages/ui', '.storybook/main.ts'),
  'src/test-setup.ts':        readFixture('packages/ui', 'src/test-setup.ts'),
  'src/Button.tsx':           readFixture('packages/ui', 'src/Button.tsx'),
};

const uiHistory = {
  remote: 'https://github.com/test-org/acme-ui.git',
  commits: [
    {
      date: daysAgo(175),
      message: 'feat: initial @acme/ui package with Button',
      files: {
        ...uiStaticFiles,
        'package.json': JSON.stringify({
          name: '@acme/ui',
          version: '1.0.0',
          description: 'Acme design system component library',
          main: 'dist/index.js',
          module: 'dist/index.mjs',
          types: 'dist/index.d.ts',
          exports: {
            '.': {
              import: './dist/index.mjs',
              require: './dist/index.js',
              types: './dist/index.d.ts',
            },
          },
          files: ['dist'],
          sideEffects: false,
          peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
          devDependencies: {
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            '@vitejs/plugin-react': '^4.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: { build: 'vite build', test: 'vitest run' },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@types/react':
        specifier: ^18.2.0
        version: 18.2.21
      react:
        specifier: ^18.2.0
        version: 18.2.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
      vitest:
        specifier: ^0.34.1
        version: 0.34.1(vite@4.4.7)
`,
        'src/index.ts': `\
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';
`,
      },
    },
    {
      date: daysAgo(140),
      message: 'feat: add Input and Modal components',
      files: {
        'package.json': JSON.stringify({
          name: '@acme/ui',
          version: '1.1.0',
          description: 'Acme design system component library',
          main: 'dist/index.js',
          module: 'dist/index.mjs',
          types: 'dist/index.d.ts',
          exports: {
            '.': {
              import: './dist/index.mjs',
              require: './dist/index.js',
              types: './dist/index.d.ts',
            },
          },
          files: ['dist'],
          sideEffects: false,
          dependencies: { '@acme/utils': '^0.4.0' },
          peerDependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
          devDependencies: {
            '@storybook/react': '^7.4.0',
            '@storybook/react-vite': '^7.4.0',
            '@storybook/addon-essentials': '^7.4.0',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            '@vitejs/plugin-react': '^4.0.0',
            react: '^18.2.0',
            'react-dom': '^18.2.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: {
            build: 'vite build', test: 'vitest run',
            storybook: 'storybook dev -p 6006', 'build-storybook': 'storybook build',
          },
        }, null, 2),
        'src/Input.tsx':  readFixture('packages/ui', 'src/Input.tsx'),
        'src/Modal.tsx':  readFixture('packages/ui', 'src/Modal.tsx'),
        'src/index.ts': `\
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Input } from './Input';
export type { InputProps, InputSize } from './Input';

export { Modal } from './Modal';
export type { ModalProps } from './Modal';
`,
      },
    },
    {
      date: daysAgo(100),
      message: 'feat: add Badge and Tooltip, bump to 1.2.0',
      files: {
        'package.json': readFixture('packages/ui', 'package.json'),
        'pnpm-lock.yaml': readFixture('packages/ui', 'pnpm-lock.yaml'),
        'src/Badge.tsx':   readFixture('packages/ui', 'src/Badge.tsx'),
        'src/Tooltip.tsx': readFixture('packages/ui', 'src/Tooltip.tsx'),
        'src/index.ts':    readFixture('packages/ui', 'src/index.ts'),
      },
    },
    {
      date: daysAgo(40),
      message: 'chore: add Storybook configuration',
      files: {
        '.storybook/main.ts': readFixture('packages/ui', '.storybook/main.ts'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup',
      files: readAllFixtures('packages/ui'),
    },
  ],
};

// ── packages/utils ────────────────────────────────────────────────────────────
// Utility library. Grows from formatDate-only to full utils set.

const utilsStaticFiles = {
  'tsconfig.json':  readFixture('packages/utils', 'tsconfig.json'),
  'vitest.config.ts': readFixture('packages/utils', 'vitest.config.ts'),
};

const utilsHistory = {
  remote: 'https://github.com/test-org/acme-utils.git',
  commits: [
    {
      date: daysAgo(175),
      message: 'feat: initial @acme/utils with formatDate',
      files: {
        ...utilsStaticFiles,
        'package.json': JSON.stringify({
          name: '@acme/utils',
          version: '0.3.0',
          description: 'Acme shared utility functions',
          main: 'dist/index.js',
          module: 'dist/index.mjs',
          types: 'dist/index.d.ts',
          exports: {
            '.': {
              import: './dist/index.mjs',
              require: './dist/index.js',
              types: './dist/index.d.ts',
            },
          },
          files: ['dist'],
          sideEffects: false,
          devDependencies: {
            '@types/react': '^18.2.0',
            '@vitejs/plugin-react': '^4.0.0',
            react: '^18.2.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: { build: 'vite build', test: 'vitest run', typecheck: 'tsc --noEmit' },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@types/react':
        specifier: ^18.2.0
        version: 18.2.21
      react:
        specifier: ^18.2.0
        version: 18.2.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
      vitest:
        specifier: ^0.34.1
        version: 0.34.1(vite@4.4.7)
`,
        'src/index.ts': `\
import { useState, useEffect } from 'react';

export function formatDate(
  date: Date,
  style: 'long' | 'short' | 'numeric' = 'long',
  locale = 'en-US',
): string {
  const opts: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : style === 'short'
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}
`,
      },
    },
    {
      date: daysAgo(140),
      message: 'feat: add formatCurrency and debounce',
      files: {
        'package.json': JSON.stringify({
          name: '@acme/utils',
          version: '0.4.0',
          description: 'Acme shared utility functions',
          main: 'dist/index.js',
          module: 'dist/index.mjs',
          types: 'dist/index.d.ts',
          exports: {
            '.': {
              import: './dist/index.mjs',
              require: './dist/index.js',
              types: './dist/index.d.ts',
            },
          },
          files: ['dist'],
          sideEffects: false,
          devDependencies: {
            '@types/react': '^18.2.0',
            '@vitejs/plugin-react': '^4.0.0',
            react: '^18.2.0',
            typescript: '^5.1.6',
            vite: '^4.4.7',
            vitest: '^0.34.1',
          },
          scripts: { build: 'vite build', test: 'vitest run', typecheck: 'tsc --noEmit' },
        }, null, 2),
        'pnpm-lock.yaml': `\
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      '@types/react':
        specifier: ^18.2.0
        version: 18.2.21
      react:
        specifier: ^18.2.0
        version: 18.2.0
      typescript:
        specifier: ^5.1.6
        version: 5.1.6
      vite:
        specifier: ^4.4.7
        version: 4.4.7(@types/node@20.4.5)
      vitest:
        specifier: ^0.34.1
        version: 0.34.1(vite@4.4.7)
`,
        'src/index.ts': `\
import { useState, useEffect } from 'react';

export function formatDate(
  date: Date,
  style: 'long' | 'short' | 'numeric' = 'long',
  locale = 'en-US',
): string {
  const opts: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : style === 'short'
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

export function formatCurrency(
  amountInCents: number,
  currency = 'USD',
  locale = 'en-US',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountInCents / 100);
}

export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  fn: T,
  delay: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = function (this: unknown, ...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, delay);
  } as T & { cancel: () => void };
  debounced.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return debounced;
}
`,
      },
    },
    {
      date: daysAgo(100),
      message: 'feat: add useLocalStorage hook and bump to 0.5.0',
      files: {
        'package.json': readFixture('packages/utils', 'package.json'),
        'pnpm-lock.yaml': readFixture('packages/utils', 'pnpm-lock.yaml'),
        'src/index.ts': readFixture('packages/utils', 'src/index.ts'),
      },
    },
    {
      date: daysAgo(30),
      message: 'chore: add peerDependencies metadata',
      files: {
        'package.json': readFixture('packages/utils', 'package.json'),
      },
    },
    {
      date: daysAgo(5),
      message: 'chore: final cleanup',
      files: readAllFixtures('packages/utils'),
    },
  ],
};

// ── Exports ───────────────────────────────────────────────────────────────────

export const ORG_HISTORY = {
  'apps/web-app':   webAppHistory,
  'apps/dashboard': dashboardHistory,
  'apps/docs':      docsHistory,
  'apps/mobile':    mobileHistory,
  'packages/ui':    uiHistory,
  'packages/utils': utilsHistory,
};

/**
 * The total number of commits in the most detailed project (web-app).
 * Use as the `--history` flag value to ensure all commits are scanned.
 */
export const MAX_HISTORY_DEPTH = webAppHistory.commits.length;
