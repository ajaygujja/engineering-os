import { Decision, DecisionOption } from '@engineering-os/shared';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeYamlLoad, safeYamlDump, sanitizeSlug } from '../security';

export class DecisionStore {
  private decisionsDir: string;

  constructor(private basePath: string) {
    this.decisionsDir = basePath;
  }

  /**
   * Ensure the decisions directory exists.
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.decisionsDir, { recursive: true });
  }

  /**
   * Save a new decision as a YAML file.
   */
  async save(decision: Decision): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.decisionsDir, `${decision.id}.yaml`);
    const content = safeYamlDump(decision);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Get a decision by ID.
   */
  async get(id: string): Promise<Decision | null> {
    sanitizeSlug(id, 'decisionId');
    const filePath = path.join(this.decisionsDir, `${id}.yaml`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return safeYamlLoad<Decision>(content);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * List all decisions, optionally filtered by status or tag.
   */
  async list(filter?: { status?: string; tag?: string }): Promise<Decision[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.decisionsDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml'));

    const decisions: Decision[] = [];
    for (const file of yamlFiles) {
      const content = await fs.readFile(path.join(this.decisionsDir, file), 'utf-8');
      const decision = safeYamlLoad<Decision>(content);
      if (decision) {
        decisions.push(decision);
      }
    }

    let result = decisions;

    if (filter?.status) {
      result = result.filter((d) => d.status === filter.status);
    }

    if (filter?.tag) {
      result = result.filter(
        (d) => d.tags && d.tags.includes(filter.tag!)
      );
    }

    return result;
  }

  /**
   * Search decisions by keyword.
   *
   * The query is tokenized into words and matched against the decision's
   * title, context, rationale, decision text, consequences, and tags. A
   * decision matches if **any** token appears, and results are ranked by the
   * number of distinct matching tokens (most relevant first). This token-based
   * approach means natural-language queries like "why BLoC" or "BLoC state
   * management" match, not just exact substrings.
   *
   * @param query Free-text query; an empty/whitespace query returns all decisions.
   * @returns Matching decisions, most relevant first.
   */
  async search(query: string): Promise<Decision[]> {
    const allDecisions = await this.list();
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.length === 0) return allDecisions;

    return allDecisions
      .map((d) => {
        const haystack = [
          d.title,
          d.context,
          d.rationale,
          d.decision,
          ...(d.consequences || []),
          ...(d.tags || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const score = tokens.reduce((n, token) => (haystack.includes(token) ? n + 1 : n), 0);
        return { decision: d, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.decision);
  }

  /**
   * Update decision status (e.g., deprecate).
   */
  async updateStatus(
    id: string,
    status: Decision['status'],
    supersededBy?: string
  ): Promise<void> {
    sanitizeSlug(id, 'decisionId');
    const decision = await this.get(id);
    if (!decision) {
      throw new Error(`Decision ${id} not found`);
    }

    decision.status = status;
    if (supersededBy) {
      decision.supersededBy = supersededBy;
    }

    await this.save(decision);
  }

  /**
   * Generate next decision ID (DEC-001, DEC-002, etc.)
   */
  private async nextId(): Promise<string> {
    await this.ensureDir();
    const files = await fs.readdir(this.decisionsDir);
    const decFiles = files.filter(
      (f) => f.startsWith('DEC-') && f.endsWith('.yaml')
    );

    if (decFiles.length === 0) {
      return 'DEC-001';
    }

    const numbers = decFiles.map((f) => {
      const match = f.match(/DEC-(\d+)\.yaml/);
      return match ? parseInt(match[1], 10) : 0;
    });

    const maxNum = Math.max(...numbers);
    const nextNum = maxNum + 1;
    return `DEC-${nextNum.toString().padStart(3, '0')}`;
  }

  /**
   * Create a new decision with auto-generated ID.
   */
  async create(
    decision: Omit<Decision, 'id'>
  ): Promise<Decision> {
    const id = await this.nextId();
    const fullDecision: Decision = { id, ...decision } as Decision;
    await this.save(fullDecision);
    return fullDecision;
  }
}
