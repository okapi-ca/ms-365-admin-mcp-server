import { describe, it, expect } from 'vitest';
import {
  RISK_LEVELS,
  computeWriteRiskTiers,
  effectiveRiskLevel,
  isToolAllowed,
  isValidRiskLevel,
  parseMaxRiskLevel,
  rank,
} from '../src/risk-level.js';

describe('risk-level — rank ordering', () => {
  it('orders levels low < medium < high < critical', () => {
    expect(rank('low')).toBeLessThan(rank('medium'));
    expect(rank('medium')).toBeLessThan(rank('high'));
    expect(rank('high')).toBeLessThan(rank('critical'));
  });

  it('exposes the canonical level list in ascending order', () => {
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

describe('risk-level — parse and validate', () => {
  it('accepts a valid level in any case', () => {
    expect(parseMaxRiskLevel('MEDIUM')).toBe('medium');
    expect(parseMaxRiskLevel('Critical')).toBe('critical');
    expect(parseMaxRiskLevel('low')).toBe('low');
  });

  it('throws on an invalid level', () => {
    expect(() => parseMaxRiskLevel('very-high')).toThrow(/Invalid --max-risk-level/);
    expect(() => parseMaxRiskLevel('')).toThrow(/Invalid --max-risk-level/);
  });

  it('isValidRiskLevel narrows only known strings', () => {
    expect(isValidRiskLevel('low')).toBe(true);
    expect(isValidRiskLevel('critical')).toBe(true);
    expect(isValidRiskLevel('severe')).toBe(false);
    expect(isValidRiskLevel(42)).toBe(false);
    expect(isValidRiskLevel(undefined)).toBe(false);
  });
});

describe('risk-level — effectiveRiskLevel defaults', () => {
  it('uses the configured level when present', () => {
    expect(effectiveRiskLevel('high', 'GET')).toBe('high');
    expect(effectiveRiskLevel('critical', 'POST')).toBe('critical');
  });

  it('defaults unannotated GETs to low', () => {
    expect(effectiveRiskLevel(undefined, 'GET')).toBe('low');
    expect(effectiveRiskLevel(undefined, 'get')).toBe('low');
  });

  it('defaults unannotated writes to critical (fail-safe)', () => {
    expect(effectiveRiskLevel(undefined, 'POST')).toBe('critical');
    expect(effectiveRiskLevel(undefined, 'PATCH')).toBe('critical');
    expect(effectiveRiskLevel(undefined, 'DELETE')).toBe('critical');
    expect(effectiveRiskLevel(undefined, 'PUT')).toBe('critical');
  });
});

describe('risk-level — isToolAllowed gate', () => {
  it('permits a tool exactly at the cap', () => {
    expect(isToolAllowed('medium', 'POST', 'medium')).toBe(true);
    expect(isToolAllowed('critical', 'DELETE', 'critical')).toBe(true);
  });

  it('permits a tool below the cap', () => {
    expect(isToolAllowed('low', 'POST', 'high')).toBe(true);
    expect(isToolAllowed('medium', 'GET', 'high')).toBe(true);
  });

  it('rejects a tool above the cap', () => {
    expect(isToolAllowed('high', 'POST', 'medium')).toBe(false);
    expect(isToolAllowed('critical', 'DELETE', 'high')).toBe(false);
  });

  it('rejects sensitive-read GETs above the cap', () => {
    // list-bitlocker-recovery-keys is a GET annotated `high` — an operator
    // who declared `--max-risk-level medium` should not see it.
    expect(isToolAllowed('high', 'GET', 'medium')).toBe(false);
  });

  it('permits unannotated GETs (default low) under any cap', () => {
    expect(isToolAllowed(undefined, 'GET', 'low')).toBe(true);
    expect(isToolAllowed(undefined, 'GET', 'medium')).toBe(true);
    expect(isToolAllowed(undefined, 'GET', 'critical')).toBe(true);
  });

  it('rejects unannotated writes (default critical) under any non-critical cap', () => {
    expect(isToolAllowed(undefined, 'POST', 'low')).toBe(false);
    expect(isToolAllowed(undefined, 'POST', 'medium')).toBe(false);
    expect(isToolAllowed(undefined, 'POST', 'high')).toBe(false);
    expect(isToolAllowed(undefined, 'POST', 'critical')).toBe(true);
  });
});

describe('risk-level — computeWriteRiskTiers', () => {
  it('returns undefined when roles is undefined (stdio / legacy)', () => {
    // undefined preserves the existing --allow-writes / --max-risk-level
    // behavior — no per-caller filter is applied. stdio has no caller identity.
    expect(computeWriteRiskTiers(undefined)).toBeUndefined();
  });

  it('returns an empty Set when authenticated but no Tools.Write.* role is granted', () => {
    // Authenticated caller without any write role → read-only session.
    // Distinct from `undefined`: the filter IS active, it just admits no tier.
    const tiers = computeWriteRiskTiers([]);
    expect(tiers).toBeInstanceOf(Set);
    expect(tiers!.size).toBe(0);
  });

  it('LowMedium grants low + medium together', () => {
    const tiers = computeWriteRiskTiers(['Tools.Write.LowMedium']);
    expect([...tiers!].sort()).toEqual(['low', 'medium']);
  });

  it('High grants only high', () => {
    const tiers = computeWriteRiskTiers(['Tools.Write.High']);
    expect([...tiers!]).toEqual(['high']);
  });

  it('Critical grants only critical', () => {
    const tiers = computeWriteRiskTiers(['Tools.Write.Critical']);
    expect([...tiers!]).toEqual(['critical']);
  });

  it('the three roles are additive — combinations grant the union', () => {
    // Non-contiguous combos are valid: e.g. SOC that can triage (LowMedium)
    // and execute incident-response actions (Critical) but not provisioning (High).
    const tiers = computeWriteRiskTiers(['Tools.Write.LowMedium', 'Tools.Write.Critical']);
    expect([...tiers!].sort()).toEqual(['critical', 'low', 'medium']);
  });

  it('all three roles together grant every tier', () => {
    const tiers = computeWriteRiskTiers([
      'Tools.Write.LowMedium',
      'Tools.Write.High',
      'Tools.Write.Critical',
    ]);
    expect([...tiers!].sort()).toEqual(['critical', 'high', 'low', 'medium']);
  });

  it('ignores unknown roles silently', () => {
    // Unknown roles must not error or grant tiers — forward-compatibility
    // with future roles on the same app registration (e.g. Tools.Read.Sensitive).
    const tiers = computeWriteRiskTiers(['Tools.Write.High', 'Tools.Some.Other.Role', 'Reader']);
    expect([...tiers!]).toEqual(['high']);
  });

  it('is case-sensitive on role names (matches Entra App Role `value`)', () => {
    // App Role `value` is preserved verbatim in the JWT `roles` claim.
    // Lowercase variants would be a misconfiguration and must NOT grant anything.
    const tiers = computeWriteRiskTiers(['tools.write.high', 'TOOLS.WRITE.HIGH']);
    expect(tiers!.size).toBe(0);
  });
});
