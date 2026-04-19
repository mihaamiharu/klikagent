import { GitHubIssue } from '../types';
import { runAgent } from '../services/ai';
import { skeletonTools, skeletonHandlers } from './tools';

const SYSTEM_PROMPT = `You are a senior QA engineer writing Playwright TypeScript test skeletons for a web application.

Your job is to generate a well-structured skeleton spec file based on the Jira acceptance criteria.
The skeleton should have the correct test structure but use TODO comments as placeholders for selectors and assertions.

Rules:
- Use the klikagent-tests fixture system (import from '../../fixtures' or relative path)
- Use getByRole, getByLabel, getByTestId, getByPlaceholder — never CSS selectors or XPath
- Structure tests with describe blocks matching the AC scenarios
- Each Given/When/Then maps to arrange/act/assert blocks
- Add // TODO: comments where real selectors and assertions will go in enrichment
- Use relative imports — never @pages, @helpers, @data aliases
- Follow existing test patterns from the context docs
- Do NOT invent selectors — leave TODOs for the Enrichment Agent

For rework tickets:
- Read the parent spec first with get_parent_spec
- Add new test cases alongside existing ones — never delete or rewrite existing tests
- New tests follow the same style as existing ones

When done, call done() with the complete skeleton spec content.`;

function buildUserMessage(issue: GitHubIssue, feature: string, branch: string, isRework: boolean, parentTicketId?: string): string {
  return `
## Ticket
Issue #${issue.number}: ${issue.title}
URL: ${issue.url}
Feature: ${feature}
Branch: ${branch}
Is Rework: ${isRework}
${parentTicketId ? `Parent Ticket: #${parentTicketId}` : ''}

## Acceptance Criteria
${issue.body}

## Your task
1. Use get_context_docs to understand the domain, personas, and test patterns
2. Use get_fixtures to see available fixtures
3. Use get_existing_tests to see existing specs for this feature
4. ${isRework ? `Use get_parent_spec (branch: "${branch}", parentTicketId: "${parentTicketId}", feature: "${feature}") to read the parent spec` : 'Use get_existing_pom to check for an existing POM'}
5. Generate the skeleton spec at: tests/web/${feature}/${issue.number}.spec.ts
6. Call done() with the skeleton spec content
`.trim();
}

export async function runSkeletonAgent(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  isRework = false,
  parentTicketId?: string
): Promise<string> {
  const result = await runAgent(
    SYSTEM_PROMPT,
    buildUserMessage(issue, feature, branch, isRework, parentTicketId),
    skeletonTools,
    skeletonHandlers
  );
  return result.skeletonSpec as string;
}
