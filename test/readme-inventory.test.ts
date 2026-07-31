import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * The README's "Available tools" inventory is the only operator-facing catalogue
 * of what this server exposes. It had drifted 56 tools behind `endpoints.json`
 * before this suite existed, with two phantom entries advertising tools that
 * were never registered — which is worse than a stale count, because an operator
 * plans an offboarding around a tool that does not answer.
 *
 * Drift here is now a build failure, mirroring how endpoints-validation already
 * pins `endpoints.json` against the generated client. Adding a tool means adding
 * its row; the failure message says exactly which rows are missing.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

interface Endpoint {
  toolName: string;
  pathPattern: string;
  method: string;
  riskLevel?: string;
}

const endpoints: Endpoint[] = JSON.parse(
  readFileSync(path.join(root, 'src', 'endpoints.json'), 'utf8')
);
const readme = readFileSync(path.join(root, 'README.md'), 'utf8').split('\n');

interface Section {
  line: number;
  title: string;
  declared: number | null;
  tools: string[];
}

/**
 * Parses the `## Available tools (N)` block into its `### Title (N)` sections and
 * the tool names in their tables.
 *
 * Only lines that open a table row (`| \`tool-name\``) count. Prose bullets that
 * happen to start with a backticked tool name — the "Notes:" lists under several
 * Intune sections do — are deliberately excluded; counting them inflates the
 * section total and produced two false "duplicate" reports while this suite was
 * being written.
 */
function parseInventory(): { sections: Section[]; listed: Map<string, string[]> } {
  const start = readme.findIndex((l) => l.startsWith('## Available tools'));
  expect(start, 'README has an "## Available tools" section').toBeGreaterThan(-1);

  let end = readme.length;
  for (let i = start + 1; i < readme.length; i++) {
    if (readme[i].startsWith('## ')) {
      end = i;
      break;
    }
  }

  const sections: Section[] = [];
  let current: Section | undefined;

  for (let i = start + 1; i < end; i++) {
    const line = readme[i];
    const heading = line.match(/^### (.+?)(?: \((\d+)\))?(?: --.*)?$/);
    if (line.startsWith('### ') && heading) {
      current = {
        line: i + 1,
        title: heading[1],
        declared: heading[2] === undefined ? null : Number(heading[2]),
        tools: [],
      };
      sections.push(current);
      continue;
    }
    const row = line.match(/^\|\s*`([a-z0-9-]+)`/);
    if (row && current) current.tools.push(row[1]);
  }

  const listed = new Map<string, string[]>();
  for (const section of sections) {
    for (const tool of section.tools) {
      const homes = listed.get(tool) ?? [];
      homes.push(section.title);
      listed.set(tool, homes);
    }
  }

  return { sections, listed };
}

const { sections, listed } = parseInventory();

describe('README tool inventory', () => {
  it('lists every tool in endpoints.json', () => {
    const missing = endpoints.filter((e) => !listed.has(e.toolName));

    if (missing.length > 0) {
      const details = missing
        .map(
          (e) =>
            `  ${e.toolName} (${e.method.toUpperCase()} ${e.pathPattern}${
              e.riskLevel ? `, ${e.riskLevel}` : ''
            })`
        )
        .join('\n');
      expect.fail(
        `${missing.length} tool(s) are registered but absent from the README inventory. ` +
          `Add a table row under the matching "### Section (N)" heading and bump its count.\n${details}`
      );
    }
  });

  it('advertises no tool that is not registered', () => {
    const registered = new Set(endpoints.map((e) => e.toolName));
    const phantom = [...listed.keys()].filter((tool) => !registered.has(tool));

    if (phantom.length > 0) {
      const details = phantom
        .map((tool) => `  ${tool} (listed under ${listed.get(tool)!.join(', ')})`)
        .join('\n');
      expect.fail(
        `${phantom.length} tool(s) appear in the README but are not in endpoints.json. ` +
          `An operator would plan around a tool that does not answer — remove the row, or ` +
          `explain the absence in prose rather than in the table.\n${details}`
      );
    }
  });

  it('gives every tool exactly one home section', () => {
    const duplicated = [...listed.entries()].filter(([, homes]) => homes.length > 1);

    if (duplicated.length > 0) {
      const details = duplicated
        .map(([tool, homes]) => `  ${tool} -> ${homes.join(' | ')}`)
        .join('\n');
      expect.fail(
        `${duplicated.length} tool(s) are listed in more than one section, which double-counts ` +
          `them in the totals.\n${details}`
      );
    }
  });

  it('matches each section heading count to its table rows', () => {
    const wrong = sections.filter((s) => s.declared !== null && s.declared !== s.tools.length);
    const uncounted = sections.filter((s) => s.declared === null);

    const problems = [
      ...wrong.map(
        (s) => `  L${s.line} ${s.title}: heading says ${s.declared}, table has ${s.tools.length}`
      ),
      ...uncounted.map((s) => `  L${s.line} ${s.title}: heading carries no (N) count`),
    ];

    if (problems.length > 0) {
      expect.fail(`Section counts are out of step with their tables.\n${problems.join('\n')}`);
    }
  });

  it('keeps the two headline counters equal to the real total', () => {
    const total = endpoints.length;
    const featureLine = readme.find((l) => /^- \*\*\d+ tools\*\* covering/.test(l));
    const heading = readme.find((l) => l.startsWith('## Available tools ('));

    expect(featureLine, 'Features bullet stating the tool count').toBeDefined();
    expect(heading, '"## Available tools (N)" heading').toBeDefined();

    const declaredInFeatures = Number(featureLine!.match(/\*\*(\d+) tools\*\*/)![1]);
    const declaredInHeading = Number(heading!.match(/\((\d+)\)/)![1]);

    expect(declaredInFeatures, `Features bullet should say ${total}`).toBe(total);
    expect(declaredInHeading, `"Available tools" heading should say ${total}`).toBe(total);
  });

  it('accounts for every tool exactly once across the section headings', () => {
    const summed = sections.reduce((acc, s) => acc + (s.declared ?? 0), 0);
    expect(summed, 'sum of section heading counts equals the tool total').toBe(endpoints.length);
  });
});
