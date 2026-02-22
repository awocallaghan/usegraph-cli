import React from 'react';
import { Tooltip } from '@acme/ui';
import { DocSearch } from '../components/DocSearch';

interface DocSection {
  title: string;
  href: string;
  description: string;
  tag?: string;
}

const SECTIONS: DocSection[] = [
  {
    title: 'Getting Started',
    href: '/docs/getting-started',
    description: 'Install the design system and render your first component.',
    tag: 'Beginner',
  },
  {
    title: 'Components',
    href: '/docs/components',
    description: 'Full reference for every component in @acme/ui.',
    tag: 'Reference',
  },
  {
    title: 'Utilities',
    href: '/docs/utils',
    description: 'Helper functions exported from @acme/utils.',
    tag: 'Reference',
  },
  {
    title: 'Theming',
    href: '/docs/theming',
    description: 'Customise colours, spacing, and typography.',
    tag: 'Advanced',
  },
  {
    title: 'Migration Guide',
    href: '/docs/migration',
    description: 'Upgrade from v1 to v2 without breaking changes.',
  },
];

export default function HomePage() {
  return (
    <main className="docs-home">
      <section className="hero">
        <h1>Acme Design System Docs</h1>
        <p>Everything you need to build consistent UIs at Acme.</p>
        <DocSearch placeholder="Search docs…" />
      </section>

      <section className="doc-sections">
        {SECTIONS.map(section => (
          <Tooltip
            key={section.href}
            content={section.description}
            placement="top"
          >
            <a href={section.href} className="doc-card">
              <h2>{section.title}</h2>
              {section.tag && (
                <span className="doc-tag">{section.tag}</span>
              )}
            </a>
          </Tooltip>
        ))}
      </section>

      <section className="quick-links">
        <h2>Quick Links</h2>
        <ul>
          <li>
            <Tooltip content="View on GitHub" placement="right">
              <a href="https://github.com/acme/design-system">GitHub</a>
            </Tooltip>
          </li>
          <li>
            <Tooltip content="Browse component demos" placement="right">
              <a href="https://storybook.acme.dev">Storybook</a>
            </Tooltip>
          </li>
          <li>
            <Tooltip content="Report a bug or request a feature" placement="right">
              <a href="https://github.com/acme/design-system/issues">Issues</a>
            </Tooltip>
          </li>
        </ul>
      </section>
    </main>
  );
}
