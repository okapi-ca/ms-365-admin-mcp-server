import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * `readme-inventory` pins the README's catalogue to `endpoints.json`, but every
 * other document was free to quote a total and go stale unnoticed. APP_REGISTRATION
 * claimed "all 515 tools" while the catalogue stood at 641 — 126 tools behind, in
 * the one document an operator follows when granting Graph consent, so the wrong
 * figure landed exactly where scope decisions get made.
 *
 * The hard part is that most counts in these docs are legitimate: subset counts
 * ("21 outils" app-only, "11+ tools" in a playbook) and deliberate approximations
 * ("600+ tools"). Failing on all of them would be noise, and a noisy guard gets
 * deleted. So this suite only judges claims that look like a *total*:
 *
 *   - three digits or more, immediately before "tools" / "outils"
 *   - subset counts in these docs are all two digits, so the threshold separates
 *     them cleanly without an allowlist to maintain
 *
 * A total-shaped claim passes if it is exact, or if it is hedged ("600+",
 * "over 600", "Plus de 600") and not above the real count — a hedge that stays
 * true as the catalogue grows is the pattern we want to encourage over a literal
 * that rots. Dated security reviews are exempt: 515 was correct on their date,
 * and rewriting a point-in-time finding would falsify it.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const endpoints: { toolName: string }[] = JSON.parse(
  readFileSync(path.join(root, 'src', 'endpoints.json'), 'utf8')
);
const actual = endpoints.length;

/** Dated snapshots record what was true when written. */
const isDatedSnapshot = (rel: string) => /SECURITY_REVIEW_\d{4}-\d{2}-\d{2}\.md$/.test(rel);

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) markdownFiles(abs, acc);
    else if (entry.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

const docs = [
  ...markdownFiles(path.join(root, 'docs')),
  path.join(root, 'README.md'),
  path.join(root, 'CLAUDE.md'),
].filter((abs) => {
  try {
    return statSync(abs).isFile();
  } catch {
    return false; // CLAUDE.md is absent from some checkouts
  }
});

/** A total-shaped claim: 3+ digits, optional `+`, immediately before tools/outils. */
const TOTAL_CLAIM = /(\b(?:over|more than|Plus de|plus de)\s+)?(\d{3,})(\+?)\s+(tools|outils)\b/g;

interface Claim {
  file: string;
  line: number;
  text: string;
  count: number;
  hedged: boolean;
}

function claimsIn(abs: string): Claim[] {
  const rel = path.relative(root, abs);
  const out: Claim[] = [];
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const m of text.matchAll(TOTAL_CLAIM)) {
        out.push({
          file: rel,
          line: i + 1,
          text: text.trim().slice(0, 120),
          count: Number(m[2]),
          hedged: Boolean(m[1]) || m[3] === '+',
        });
      }
    });
  return out;
}

describe('documentation tool counts', () => {
  const claims = docs.filter((d) => !isDatedSnapshot(path.relative(root, d))).flatMap(claimsIn);

  it('quotes no exact total that disagrees with endpoints.json', () => {
    const wrong = claims.filter((c) => !c.hedged && c.count !== actual);
    expect(
      wrong.map((c) => `${c.file}:${c.line} claims ${c.count}, actual ${actual} — ${c.text}`),
      `A document states an exact tool total that no longer matches src/endpoints.json ` +
        `(${actual} entries). Either update it, or drop the number and point at ` +
        `\`--list-permissions\` so it cannot rot again.`
    ).toEqual([]);
  });

  it('never hedges above the real total', () => {
    const overshoot = claims.filter((c) => c.hedged && c.count > actual);
    expect(
      overshoot.map((c) => `${c.file}:${c.line} hedges ${c.count}+, actual ${actual} — ${c.text}`),
      `A hedged count ("600+ tools") promises more tools than exist. Lower the ` +
        `floor to a round number at or below ${actual}.`
    ).toEqual([]);
  });

  it('exempts dated security reviews from the check', () => {
    // Guards the exemption itself: if the naming convention changes, the reviews
    // start failing and this test says why before the failure looks like drift.
    const dated = docs.map((d) => path.relative(root, d)).filter(isDatedSnapshot);
    expect(dated.length).toBeGreaterThan(0);
  });
});
