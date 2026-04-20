/**
 * SEC-G01: ranked risk-level model for tool registration.
 *
 * Tools ship with an explicit `riskLevel` annotation (set for 100 % of
 * write endpoints and for the ~20 sensitive-read GETs covered by SEC-G03).
 * The registration pipeline caps the level it will expose based on the
 * `--max-risk-level` CLI flag. Pure module so the gate logic can be
 * unit-tested without the full MCP/Graph stack.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'] as const;

export function rank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export function isValidRiskLevel(x: unknown): x is RiskLevel {
  return typeof x === 'string' && (RISK_LEVELS as readonly string[]).includes(x);
}

export function parseMaxRiskLevel(raw: string): RiskLevel {
  const lower = raw.toLowerCase();
  if (!isValidRiskLevel(lower)) {
    throw new Error(`Invalid --max-risk-level: ${raw}. Must be one of: ${RISK_LEVELS.join(', ')}`);
  }
  return lower;
}

/**
 * Effective risk level for a tool:
 *   - If `configuredRiskLevel` is set, use it.
 *   - Else GET endpoints default to `low` (safe reads).
 *   - Else (a write without an explicit level) default to `critical` — fail-safe
 *     so a future endpoint missing an annotation is not silently leaked under
 *     a medium cap.
 */
export function effectiveRiskLevel(
  configuredRiskLevel: RiskLevel | undefined,
  method: string
): RiskLevel {
  if (configuredRiskLevel) return configuredRiskLevel;
  return method.toUpperCase() === 'GET' ? 'low' : 'critical';
}

export function isToolAllowed(
  configuredRiskLevel: RiskLevel | undefined,
  method: string,
  maxRiskLevel: RiskLevel
): boolean {
  return rank(effectiveRiskLevel(configuredRiskLevel, method)) <= rank(maxRiskLevel);
}
