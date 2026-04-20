import { GitHubIssue, PageSnapshot } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { enrichmentTools, enrichmentHandlers } from './tools';
import { serializeSnapshots } from './snapshotUtils';

const SYSTEM_PROMPT = `You are a senior QA engineer enriching a Playwright TypeScript test skeleton into a fully runnable spec.

You have page snapshots from the live QA environment — ARIA tree, interactable element locators, and data-testid attributes.
Your job is to replace all TODO placeholders with real selectors and add meaningful assertions.

Rules:
- Use ONLY locators from the page snapshot — never invent selectors
- Prefer getByTestId > getByLabel > getByRole > getByPlaceholder
- Every test must have at least one assertion (expect)
- Update or create the Page Object Model (POM) for this feature
- POM file goes in: pages/{feature}/{Feature}Page.ts
- Spec imports from the POM using relative paths
- Use relative imports — never @pages, @helpers, @data aliases
- CRITICAL: Call list_available_poms before writing any imports. Only import POM classes that appear in that list OR that you are creating as pomContent. NEVER import a POM that does not exist in the list — this will break CI.
- Call validate_typescript before done() to confirm the code is valid
- The affectedPaths field should list test folders impacted by the PR diff provided

When done, call done() with enrichedSpec, pomContent, and affectedPaths.`;

function buildUserMessage(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[],
  prDiff: string
): string {
  return `
## Ticket
Issue #${issue.number}: ${issue.title}
Feature: ${feature}
Branch: ${branch}

## Acceptance Criteria
${issue.body}

## Page Snapshots (live QA environment)
${serializeSnapshots(snapshots)}

## PR Diff (main dev repo — use this to determine affectedPaths)
${prDiff || '(no diff available)'}

## Your task
1. Use get_skeleton_spec (branch: "${branch}", ticketId: "${issue.number}", feature: "${feature}") to read the skeleton
2. Use get_existing_pom to read any existing POM for this feature
3. Use list_available_poms to see ALL page objects that currently exist — you may only import from this list or from the POM you are creating
4. Use get_context_docs and get_fixtures for project conventions
5. Enrich the skeleton with real selectors from the page snapshots above
6. Write or update the POM at pages/${feature}/${feature.charAt(0).toUpperCase() + feature.slice(1)}Page.ts
7. Determine affectedPaths from the PR diff
8. Call validate_typescript with your spec to confirm it compiles
9. Call done() with enrichedSpec, pomContent, and affectedPaths
`.trim();
}

export async function runEnrichmentAgent(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[],
  prDiff: string
): Promise<{ enrichedSpec: string; pomContent: string; affectedPaths: string; tokenUsage: TokenUsage }> {
  const { args, tokenUsage } = await runAgent(
    SYSTEM_PROMPT,
    buildUserMessage(issue, feature, branch, snapshots, prDiff),
    enrichmentTools,
    enrichmentHandlers
  );
  return {
    enrichedSpec: args.enrichedSpec as string,
    pomContent: args.pomContent as string,
    affectedPaths: args.affectedPaths as string,
    tokenUsage,
  };
}
