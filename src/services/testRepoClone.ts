/**
 * Returns MAX_SELF_CORRECTION_ATTEMPTS from env (default: 10).
 * Self-correction now runs tsc validation only — Playwright test execution
 * is handled by CI after the QA engineer merges the draft PR.
 */
export function maxSelfCorrectionAttempts(): number {
  const raw = process.env.MAX_SELF_CORRECTION_ATTEMPTS;
  if (!raw) return 10;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}
