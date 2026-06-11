import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseMarkdown, AdrImporter } from './adr-importer';
import { DecisionStore } from './decision-store';

describe('parseMarkdown — inline **Decision** style', () => {
  const doc = `# Architecture

## Design Principles

### 1. Feature-First Structure

**Decision**: Organize code by features, not layers.

**Why**:

- Easy to locate code related to a feature
- Scales better as the app grows

**Trade-offs**:

- Some code duplication across features

### 2. BLoC for State Management

**Decision**: Use \`flutter_bloc\` for state management.

**Why**:

- Predictable state changes
- Testable business logic

**Trade-offs**:

- More boilerplate than simpler solutions
`;

  it('extracts one decision per marked section', () => {
    const adrs = parseMarkdown(doc, 'docs/architecture.md');
    expect(adrs).toHaveLength(2);
  });

  it('maps title, decision, rationale, and consequences', () => {
    const bloc = parseMarkdown(doc, 'docs/architecture.md').find((a) =>
      a.title === 'BLoC for State Management'
    )!;
    expect(bloc).toBeDefined();
    expect(bloc.decision).toBe('Use flutter_bloc for state management.');
    expect(bloc.rationale).toContain('Predictable state changes');
    expect(bloc.consequences).toContain('More boilerplate than simpler solutions');
    expect(bloc.status).toBe('accepted');
    expect(bloc.id).toBe('ADR-bloc-for-state-management');
  });

  it('strips leading numbering from titles', () => {
    const titles = parseMarkdown(doc, 'x.md').map((a) => a.title);
    expect(titles).toContain('Feature-First Structure');
    expect(titles).not.toContain('1. Feature-First Structure');
  });

  it('derives slug-safe stable ids', () => {
    const ids = parseMarkdown(doc, 'x.md').map((a) => a.id);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  });
});

describe('parseMarkdown — Nygard ADR file style', () => {
  const doc = `# Use PostgreSQL for primary storage

## Status

Accepted

## Context

We need a relational store with strong consistency.

## Decision

We will use PostgreSQL as the primary datastore.

## Consequences

- Operational familiarity
- Requires connection pooling
`;

  it('parses a single decision from the file', () => {
    const adrs = parseMarkdown(doc, 'docs/adr/0001-postgres.md');
    expect(adrs).toHaveLength(1);
    const a = adrs[0];
    expect(a.title).toBe('Use PostgreSQL for primary storage');
    expect(a.decision).toBe('We will use PostgreSQL as the primary datastore.');
    expect(a.context).toContain('relational store');
    expect(a.consequences).toContain('Requires connection pooling');
    expect(a.status).toBe('accepted');
  });

  it('maps non-accepted status keywords', () => {
    const deprecated = parseMarkdown(doc.replace('Accepted', 'Deprecated'), 'x.md')[0];
    expect(deprecated.status).toBe('deprecated');
  });
});

describe('parseMarkdown — non-decision docs', () => {
  it('returns nothing for plain prose with no decision markers', () => {
    expect(parseMarkdown('# README\n\nSome setup notes.\n', 'README.md')).toHaveLength(0);
  });

  it('ignores fenced code that looks like a heading', () => {
    const doc = '# Title\n\n```\n## Decision\nnot real\n```\n';
    expect(parseMarkdown(doc, 'x.md')).toHaveLength(0);
  });
});

describe('AdrImporter.importInto', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-adr-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }

  it('discovers docs, saves decisions, and is idempotent on re-run', async () => {
    write('docs/architecture.md', `### 1. BLoC for State Management

**Decision**: Use flutter_bloc.

**Why**:
- Testable
`);
    const store = new DecisionStore(path.join(tmpDir, '.eos', 'knowledge', 'decisions'));
    const importer = new AdrImporter(tmpDir);

    const first = await importer.importInto(store);
    expect(first).toHaveLength(1);
    expect((await store.list())).toHaveLength(1);

    // Re-run: same id overwrites, no duplicate file.
    const second = await importer.importInto(store);
    expect(second).toHaveLength(1);
    expect((await store.list())).toHaveLength(1);

    const recalled = await store.search('bloc');
    expect(recalled[0].decision).toContain('flutter_bloc');
  });

  it('recalls an imported decision via a natural-language phrase query', async () => {
    write('docs/architecture.md', `### BLoC for State Management

**Decision**: Use flutter_bloc for state management.

**Why**:
- Predictable and testable
`);
    const store = new DecisionStore(path.join(tmpDir, '.eos', 'knowledge', 'decisions'));
    await new AdrImporter(tmpDir).importInto(store);

    // Phrase queries (the way an assistant naturally asks) must match, not just
    // exact substrings of the title.
    for (const q of ['why BLoC', 'BLoC state management', 'state management approach']) {
      const hits = await store.search(q);
      expect(hits.length, `query: ${q}`).toBeGreaterThan(0);
      expect(hits[0].title).toBe('BLoC for State Management');
    }
  });

  it('imports nothing for a repo with no decision docs', async () => {
    write('README.md', '# Project\n\nHello.\n');
    const store = new DecisionStore(path.join(tmpDir, '.eos', 'knowledge', 'decisions'));
    const imported = await new AdrImporter(tmpDir).importInto(store);
    expect(imported).toHaveLength(0);
  });
});
