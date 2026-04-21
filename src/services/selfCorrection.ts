import { GitHubIssue } from '../types';
import { log } from '../utils/logger';

/**
 * Token usage summary returned by agent runs.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Result returned by runWithSelfCorrection.
 * warned is true if all self-correction attempts were exhausted without passing tests.
 */
export interface SelfCorrectionResult {
  specContent: string;
  pomContent: string;
  pomPath: string;
  affectedPaths: string;
  tokenUsage: TokenUsage;
  warned: boolean;
  warningMessage?: string;
}

/**
 * Runs the QA agent to generate a spec + POM, then applies a self-correction loop
 * until the generated Playwright tests pass (or all attempts are exhausted).
 *
 * @param issue        The GitHub issue object
 * @param feature      Detected feature name (e.g. "appointments")
 * @param branch       QA branch name in klikagent-tests
 * @param personas     Role names to authenticate with during crawl
 * @param startingUrls URL paths to crawl (e.g. ["/appointments"])
 * @param prDiff       Raw unified diff from the dev PR (may be empty string)
 * @param specPath     Repo-relative path for the spec file
 */
export async function runWithSelfCorrection(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  personas: string[],
  startingUrls: string[],
  prDiff: string,
  specPath: string,
): Promise<SelfCorrectionResult> {
  log('INFO', `[selfCorrection] Starting for issue #${issue.number} — feature: ${feature}, branch: ${branch}`);
  log('INFO', `[selfCorrection] Personas: [${personas.join(', ')}], Starting URLs: [${startingUrls.join(', ')}]`);
  log('INFO', `[selfCorrection] PR diff length: ${prDiff.length}, spec path: ${specPath}`);

  // TODO (Phase 3): Wire real qaAgent + self-correction loop here.
  // The full implementation (runQaAgent → TypeScript validation → Playwright run loop)
  // lives in feat/self-correction-loop and will be merged in a subsequent task.
  throw new Error('[selfCorrection] runWithSelfCorrection is not yet implemented — awaiting qaAgent merge');
}
