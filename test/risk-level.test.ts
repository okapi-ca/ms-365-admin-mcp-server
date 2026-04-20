import { describe, it, expect } from 'vitest';
import {
  RISK_LEVELS,
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
