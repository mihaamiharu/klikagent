import { GitHubIssue } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { qaTools, qaHandlers } from './tools';

const SYSTEM_PROMPT = `You are a senior QA engineer who writes complete Playwright TypeScript test specs and Page Object Models (POMs).

You receive a GitHub issue, personas, starting URLs, and a PR diff. Your job is to:
1. Navigate the live QA app as each persona using browser tools
2. Interact with pages to reach meaningful states (fill forms, click buttons, navigate through flows)
3. Capture page snapshots to discover real locators
4. Write a complete, runnable Playwright spec using ONLY locators observed in snapshots
5. Write or update the Page Object Model for the feature
6. Call validate_typescript and fix any errors before calling done()

## Browser tools
Browser tools use playwright-cli under the hood. Snapshots contain element refs like e5, e12 that you use as selectors.

Snapshot format: JSON with a "refs" map where keys are element refs (e5, e12) and values describe the element.
Locator priority: snapshot refs first, then CSS selectors, then Playwright locators.
On locator failure: tool returns error JSON with a hint. Call browser_snapshot() to see current state.

## Browser exploration workflow
- Call browser_navigate(url, persona) for each starting URL x persona combination
- After navigation, interact with the page: use browser_click and browser_fill to reach states relevant to the acceptance criteria
- Call browser_snapshot() after each meaningful interaction to capture updated locators
- Repeat until you have observed all states required by the acceptance criteria
- Call browser_close() when exploration is complete

## Spec writing rules
- Use ONLY locators from the page snapshots - never invent selectors
- Prefer snapshot refs > CSS selectors > Playwright locators (getByRole, getByText, getByLabel, getByPlaceholder, getByTestId)
- Every test must have at least one assertion (expect)
- Structure tests using the personas defined in the issue
- Import from the POM using relative paths - never @pages, @helpers, @data aliases
- CRITICAL: Call list_available_poms before writing imports. Only import POM classes that appear in that list OR the POM you are creating as pomContent. NEVER import a POM that does not exist in the list.
- The pomPath field must be the repo-relative path matching the exported class name exactly e.g. "pages/doctors/DoctorProfilePage.ts"
- The affectedPaths field should list test folders impacted by the PR diff

## POM rules
- POM file goes in: pages/{feature}/{ClassName}.ts
- Exported class name must match the pomPath filename exactly
- Use relative imports only

## Playwright API rules (violations will be caught by validate_typescript)
- NEVER use expect(...).or() - this method does not exist on expect. Use locator.or(): locator1.or(locator2), or use a regex: expect(el).toContainText(/value1|value2/)
- NEVER chain .or() after expect(...).toContainText(...) or any other expect assertion
- locator.or(other) works ONLY on Locator objects, not on expect results

## Required tool call sequence
1. Call get_context_docs and get_fixtures for project conventions
2. Call get_existing_pom to check for an existing POM for this feature
3. Call list_available_poms to see all existing page objects
4. Call get_existing_tests to see any existing specs for this feature
5. Use browser_navigate, browser_click, browser_fill, browser_snapshot to explore the app
6. Call browser_close() when exploration is complete
7. Write enrichedSpec and pomContent using only observed locators
8. Call validate_typescript with your spec - fix any errors returned
9. Call done() with enrichedSpec, pomContent, pomPath, and affectedPaths`;

function buildUserMessage(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  personas: string[],
  startingUrls: string[],
  prDiff: string
): string {
  const featureCap = feature.charAt(0).toUpperCase() + feature.slice(1);
  return `
## Ticket
Issue #${issue.number}: ${issue.title}
Feature: ${feature}
Branch: ${branch}

## Acceptance Criteria
${issue.body}

## Personas to test as
${personas.length > 0 ? personas.map((p) => `- ${p}`).join('\n') : '- default'}

## Starting URLs (navigate to each using browser_navigate)
${startingUrls.length > 0 ? startingUrls.map((u) => `- ${u}`).join('\n') : '(no starting URLs provided - infer from feature name and get_route_map)'}

## PR Diff (main dev repo - use this to determine affectedPaths)
${prDiff || '(no diff available)'}

## Your task
1. Call get_context_docs and get_fixtures to understand project conventions
2. Call get_existing_pom (feature: "${feature}") to read any existing POM
3. Call list_available_poms to see all existing page objects you may import
4. Call get_existing_tests (feature: "${feature}") to see any existing specs
5. Use browser_navigate for each starting URL x persona combination above
6. Interact with the page (browser_click, browser_fill) to reach states matching acceptance criteria
7. Call browser_snapshot() after each interaction to capture real locators
8. Call browser_close() when exploration is complete
9. Write the full Playwright spec using ONLY locators from your snapshots
10. Write or update the POM at pages/${feature}/${featureCap}Page.ts (adjust class name if needed)
11. Call validate_typescript with your spec - fix any errors before proceeding
12. Call done() with enrichedSpec, pomContent, pomPath (matching exported class name), and affectedPaths
`.trim();
}

export async function runQaAgent(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  personas: string[],
  startingUrls: string[],
  prDiff: string
): Promise<{ enrichedSpec: string; pomContent: string; pomPath: string; affectedPaths: string; tokenUsage: TokenUsage }> {
  const { args, tokenUsage } = await runAgent(
    SYSTEM_PROMPT,
    buildUserMessage(issue, feature, branch, personas, startingUrls, prDiff),
    qaTools,
    qaHandlers
  );
  return {
    enrichedSpec: args.enrichedSpec as string,
    pomContent: args.pomContent as string,
    pomPath: args.pomPath as string,
    affectedPaths: args.affectedPaths as string,
    tokenUsage,
  };
}
