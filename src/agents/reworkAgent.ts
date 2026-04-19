import { GitHubIssue, PageSnapshot } from '../types';
import { runAgent } from '../services/ai';
import { reworkTools, reworkHandlers } from './tools';

const SYSTEM_PROMPT = `You are a senior QA engineer applying a surgical patch to an existing Playwright test suite.

A rework ticket describes new or changed behaviour that must be reflected in the tests.
Your job is to ADD the new test cases to the existing spec — never delete or rewrite what is already there.

Patch rules:
- Read the parent spec first — understand its structure, imports, and style
- Add new describe blocks or it() cases as needed
- Never remove or rename existing test cases
- Never rewrite passing tests
- Match the exact coding style of the existing spec
- Update the POM only if new locators are needed — preserve all existing methods
- Use ONLY locators from the page snapshots
- Use relative imports — never @pages, @helpers, @data aliases
- Call validate_typescript before done()

When done, call done() with patchedSpec (the full file with additions) and pomContent.`;

function serializeSnapshots(snapshots: PageSnapshot[]): string {
  return snapshots.map((s) => `
### Page: ${s.url}
**ARIA Tree:**
${s.ariaTree || '(empty)'}

**Interactable Locators:**
${s.locators.length ? s.locators.map((l) => `- ${l}`).join('\n') : '(none found)'}

**data-testid attributes:**
${s.testIds.length ? s.testIds.map((id) => `- ${id}`).join('\n') : '(none found)'}
`).join('\n---\n');
}

function buildUserMessage(
  subtask: GitHubIssue,
  parentTicket: GitHubIssue,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[]
): string {
  return `
## Rework Subtask
Issue #${subtask.number}: ${subtask.title}
Feature: ${feature}
Branch: ${branch}

## Rework Description (what changed)
${subtask.body}

## Parent Ticket
Issue #${parentTicket.number}: ${parentTicket.title}

## Page Snapshots
${serializeSnapshots(snapshots)}

## Your task
1. Use get_parent_spec (branch: "${branch}", parentTicketId: "${parentTicket.number}", feature: "${feature}") to read the existing spec
2. Use get_current_pom to read the existing POM
3. Use get_context_docs for project conventions
4. Identify what new test cases are needed based on the rework description
5. Add new tests to the spec — do NOT remove or rewrite existing ones
6. Update the POM only if new locators are required
7. Call validate_typescript to confirm the patched spec compiles
8. Call done() with patchedSpec and pomContent
`.trim();
}

export async function runReworkAgent(
  subtask: GitHubIssue,
  parentTicket: GitHubIssue,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[]
): Promise<{ patchedSpec: string; pomContent: string }> {
  const result = await runAgent(
    SYSTEM_PROMPT,
    buildUserMessage(subtask, parentTicket, feature, branch, snapshots),
    reworkTools,
    reworkHandlers
  );
  return {
    patchedSpec: result.patchedSpec as string,
    pomContent: result.pomContent as string,
  };
}
