/**
 * @module decisions/adr-importer
 *
 * Imports **Architecture Decision Records (ADRs)** that teams have written in
 * Markdown into Engineering OS's {@link DecisionStore}, making them queryable
 * through the `eos_recall_decision` tool.
 *
 * An ADR is a short document capturing one significant technical decision: what
 * was decided, the context that forced the choice, and the consequences of
 * making it. Teams keep ADRs so the *reasoning* behind a choice survives long
 * after the people who made it have moved on. Without this importer, that
 * reasoning lives only in prose docs the assistant cannot read, so it ends up
 * re-debating settled questions (e.g. "should we use Provider instead of
 * BLoC?"). Importing ADRs lets the assistant answer "why BLoC?" from the team's
 * own documentation.
 *
 * Two widely-used ADR layouts are supported:
 *
 * 1. **Inline decisions** — one or more `###` sections in a larger document,
 *    each containing a `**Decision**:` marker plus optional `**Why**` and
 *    `**Trade-offs**` blocks. Common in hand-written architecture guides.
 *
 * 2. **Nygard ADR files** — one decision per file using the canonical
 *    `## Status` / `## Context` / `## Decision` / `## Consequences` headings,
 *    as popularized by Michael Nygard.
 *
 * The parsing layer ({@link parseMarkdown} and its helpers) is pure and
 * filesystem-free; only {@link AdrImporter.importInto} performs I/O.
 */

import { Decision } from '@engineering-os/shared';
import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';
import { DecisionStore } from './decision-store';

/**
 * A decision extracted from a Markdown document, prior to persistence.
 *
 * Mirrors the persisted {@link Decision} shape minus the fields the importer
 * fills in at save time (`date` comes from the source file's mtime, `options`
 * is always empty because ADR prose does not enumerate rejected alternatives).
 */
export interface ParsedAdr {
  /** Stable, slug-safe identifier derived from the title (e.g. `ADR-bloc-for-state-management`). */
  id: string;
  /** Human-readable decision title, with any leading list numbering removed. */
  title: string;
  /** Lifecycle status, inferred from a `Status` field when present. */
  status: Decision['status'];
  /** Background/forces that motivated the decision; may be empty. */
  context: string;
  /** The decision itself, as a single normalized sentence/paragraph. */
  decision: string;
  /** The reasoning ("why"), with bullet lists flattened to `a; b; c`. */
  rationale: string;
  /** Trade-offs / consequences, one entry per bullet. */
  consequences: string[];
  /** Lowercase keyword tags derived from the title, for search/filtering. */
  tags: string[];
  /** Repo-relative path of the document the decision was parsed from. */
  sourceFile: string;
}

/** A Markdown heading and the body text beneath it, produced by {@link splitSections}. */
interface Section {
  /** Heading depth (1 = `#`, 2 = `##`, …). */
  level: number;
  /** Heading text, trimmed. */
  title: string;
  /** Raw lines between this heading and the next, newline-joined. */
  body: string;
}

/** Low-signal words excluded when deriving tags from a title. */
const TITLE_STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'use', 'using', 'via', 'our', 'a', 'an', 'to', 'of', 'in', 'on',
]);

/**
 * Discovers Markdown ADRs in a repository and persists them to a
 * {@link DecisionStore}.
 */
export class AdrImporter {
  /**
   * @param rootPath Absolute path to the repository root to scan.
   */
  constructor(private rootPath: string) {}

  /**
   * Scan the repository for ADR documents, parse them, and save each decision.
   *
   * The operation is idempotent: ids are derived deterministically from titles,
   * so re-running overwrites the existing record rather than creating duplicates.
   * Unreadable files are skipped silently; the first occurrence of any id wins.
   *
   * @param store Destination store for the parsed decisions.
   * @returns The decisions that were imported, in discovery order.
   */
  async importInto(store: DecisionStore): Promise<ParsedAdr[]> {
    const files = await this.discover();
    const seen = new Set<string>();
    const imported: ParsedAdr[] = [];

    for (const file of files) {
      let content: string;
      let mtime: string;
      try {
        content = await fs.readFile(file, 'utf-8');
        mtime = (await fs.stat(file)).mtime.toISOString();
      } catch {
        continue; // unreadable/removed between glob and read — skip
      }

      const relFile = path.relative(this.rootPath, file);
      for (const parsed of parseMarkdown(content, relFile)) {
        if (seen.has(parsed.id)) continue;
        seen.add(parsed.id);

        const decision: Decision = {
          id: parsed.id,
          title: parsed.title,
          status: parsed.status,
          context: parsed.context,
          options: [], // ADR prose doesn't enumerate rejected options
          decision: parsed.decision,
          rationale: parsed.rationale,
          consequences: parsed.consequences,
          date: mtime,
          tags: parsed.tags,
        };
        await store.save(decision);
        imported.push(parsed);
      }
    }

    return imported;
  }

  /**
   * Locate candidate Markdown files in conventional documentation locations.
   *
   * Casts a wide net (doc folders, ADR/decision folders, and root-level
   * Markdown); {@link parseMarkdown} is responsible for rejecting documents
   * that contain no decision markers, so false positives here are harmless.
   *
   * @returns Absolute paths of candidate `.md` files.
   */
  private async discover(): Promise<string[]> {
    const patterns = [
      'docs/**/*.md',
      'doc/**/*.md',
      'adr/**/*.md',
      'adrs/**/*.md',
      'decisions/**/*.md',
      '*.md',
    ];
    return fg(patterns, {
      cwd: this.rootPath,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/.eos/**', '**/dist/**', '**/build/**'],
      dot: false,
      caseSensitiveMatch: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing (pure — no filesystem access)
// ---------------------------------------------------------------------------

/**
 * Parse every decision contained in a single Markdown document.
 *
 * Inline `**Decision**` sections take precedence; only when none are found does
 * the document get interpreted as a single Nygard-style ADR file. A document
 * with neither yields an empty array.
 *
 * @param content Raw Markdown text.
 * @param sourceFile Repo-relative path, recorded on each result for provenance.
 * @returns Parsed decisions (possibly empty).
 */
export function parseMarkdown(content: string, sourceFile: string): ParsedAdr[] {
  const sections = splitSections(content);

  const inline = sections
    .filter((s) => /\*\*\s*decision\s*\*\*/i.test(s.body))
    .map((s) => buildInlineAdr(s, sourceFile))
    .filter((a): a is ParsedAdr => a !== null);
  if (inline.length > 0) return inline;

  const adrFile = buildAdrFile(sections, sourceFile);
  return adrFile ? [adrFile] : [];
}

/**
 * Build a decision from a heading section that carries an inline
 * `**Decision**` marker.
 *
 * @returns The parsed decision, or `null` if the section lacks a usable
 *   decision statement or title.
 */
function buildInlineAdr(section: Section, sourceFile: string): ParsedAdr | null {
  const decision = extractField(section.body, ['Decision']);
  if (!decision) return null;

  const title = cleanTitle(section.title);
  if (!title) return null;

  return {
    id: slugId(title),
    title,
    status: parseStatus(extractField(section.body, ['Status'])),
    context: leadingText(section.body),
    decision: firstParagraph(decision),
    rationale: cleanBlock(extractField(section.body, ['Why', 'Rationale', 'Reasoning'])),
    consequences: extractBullets(section.body, [
      'Trade-offs', 'Tradeoffs', 'Trade offs', 'Consequences', 'Cons', 'Drawbacks',
    ]),
    tags: tagsFromTitle(title),
    sourceFile,
  };
}

/**
 * Interpret an entire document as one Nygard-style ADR, keyed off a top-level
 * `## Decision` heading.
 *
 * The title is taken from the document's `#` heading, falling back to the file
 * name. `## Context` / `## Consequences` / `## Status` sections populate the
 * corresponding fields when present.
 *
 * @returns The parsed decision, or `null` if there is no `Decision` heading.
 */
function buildAdrFile(sections: Section[], sourceFile: string): ParsedAdr | null {
  const decisionSection = sections.find((s) => /^decision$/i.test(s.title.trim()));
  if (!decisionSection) return null;

  const find = (re: RegExp) => sections.find((s) => re.test(s.title.trim()));
  const h1 = sections.find((s) => s.level === 1);
  const title = cleanTitle(h1?.title ?? path.basename(sourceFile, path.extname(sourceFile)));
  if (!title) return null;

  const contextSection = find(/^context$/i);
  const consequencesSection = find(/^consequences$/i);
  const statusSection = find(/^status$/i);

  return {
    id: slugId(title),
    title,
    status: parseStatus(statusSection?.body),
    context: (contextSection?.body ?? '').trim(),
    decision: firstParagraph(decisionSection.body.trim()),
    rationale: (decisionSection.body ?? '').trim(),
    consequences: consequencesSection ? toBullets(consequencesSection.body) : [],
    tags: tagsFromTitle(title),
    sourceFile,
  };
}

/**
 * Split Markdown into heading-delimited sections.
 *
 * Fenced code blocks are tracked so that lines like ` ## Decision ` inside a
 * code sample are not mistaken for real headings.
 *
 * @returns Sections in document order. Content before the first heading is
 *   discarded.
 */
function splitSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (heading) {
      if (current) sections.push(current);
      current = { level: heading[1].length, title: heading[2].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Extract the text following the first matching `**Label**:` (or `**Label**`)
 * marker, stopping at the next bold label, heading, or end of the block.
 *
 * @param body Section body to search.
 * @param labels Candidate labels, tried in order; the first match wins.
 * @returns The trimmed field text, or `null` if no label matched.
 */
function extractField(body: string, labels: string[]): string | null {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `\\*\\*\\s*${esc}\\s*\\*\\*\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[\\w]|\\n#{1,6}\\s|$)`,
      'i'
    );
    const m = body.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/**
 * Extract the bullet items beneath a `**Label**` marker.
 *
 * @returns One cleaned string per bullet, or `[]` if the label/list is absent.
 */
function extractBullets(body: string, labels: string[]): string[] {
  const block = extractField(body, labels);
  return block ? toBullets(block) : [];
}

/**
 * Convert a block of text into its bullet items (`-`, `*`, `+`, or `1.` style),
 * stripped of Markdown formatting. Non-bullet lines are ignored.
 */
function toBullets(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => stripFormatting(m[1]).trim())
    .filter(Boolean);
}

/**
 * Return the prose preceding the first bold marker in a section body, used as
 * the decision's context when no explicit context field exists.
 */
function leadingText(body: string): string {
  const idx = body.search(/\*\*/);
  const lead = (idx === -1 ? body : body.slice(0, idx)).trim();
  return stripFormatting(lead);
}

/**
 * Normalize a block to a single clean line: bullet lists are flattened to
 * `a; b; c`; plain prose is collapsed and de-formatted.
 */
function cleanBlock(block: string | null): string {
  if (!block) return '';
  const bullets = toBullets(block);
  if (bullets.length > 0) return bullets.join('; ');
  return stripFormatting(block.replace(/\n+/g, ' ')).trim();
}

/** Collapse the first paragraph of `text` into a single de-formatted line. */
function firstParagraph(text: string): string {
  const para = text.split(/\n\s*\n/)[0] ?? text;
  return stripFormatting(para.replace(/\n+/g, ' ')).trim();
}

/**
 * Remove inline Markdown decoration (code spans, bold/italic, status emoji)
 * while preserving identifier characters such as the underscores in
 * `snake_case`.
 */
function stripFormatting(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*/g, '')
    .replace(/✅|❌|⚠️/g, '')
    .trim();
}

/** Remove leading list numbering (e.g. `1. ` or `2) `) from a heading title. */
function cleanTitle(title: string): string {
  return stripFormatting(title.replace(/^\s*\d+[.)]\s*/, '')).trim();
}

/**
 * Map free-text status wording to a {@link Decision} status.
 * Defaults to `accepted`, since a documented decision is presumed to be in use.
 */
function parseStatus(text: string | null | undefined): Decision['status'] {
  const t = (text ?? '').toLowerCase();
  if (/deprecat/.test(t)) return 'deprecated';
  if (/supersed/.test(t)) return 'superseded';
  if (/propos/.test(t)) return 'proposed';
  return 'accepted';
}

/** Derive up to five lowercase keyword tags from a decision title. */
function tagsFromTitle(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !TITLE_STOPWORDS.has(w))
    .slice(0, 5);
}

/**
 * Build a deterministic, slug-safe id from a title.
 *
 * The result matches {@link DecisionStore}'s slug rules
 * (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) and is stable across runs, which is what makes
 * re-import idempotent.
 */
function slugId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `ADR-${slug || 'untitled'}`;
}
