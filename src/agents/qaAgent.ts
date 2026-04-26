import { QATask } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { qaTools, createQaHandlers } from './tools';
import { detectPhase, buildSystemPrompt, AgentPhase } from './prompts/phasePrompt';

function buildUserMessage(task: QATask, branch: string): string {
  const featureHint = task.feature
    ? `Feature hint (verify against list_available_poms before using): ${task.feature}`
    : 'Feature: not provided — determine it from the task context and list_available_poms output';

  return `
## Task
ID: ${task.taskId}
Title: ${task.title}
Branch: ${branch}
${featureHint}

## Acceptance Criteria
${task.description}

## QA Environment
Start here: ${task.qaEnvUrl}

## Your task
1. Call get_context_docs, get_fixtures, and get_personas to understand project conventions and credentials.
   IMPORTANT: read fixtures/index.ts carefully — note which POMs are registered as fixtures and use
   those fixture parameters in your tests instead of constructing page objects manually.
   IMPORTANT: use personas from get_personas (import { personas } from '../../../config/personas') —
   never hardcode real persona credentials. For negative tests using invalid/non-existent credentials, a literal string is correct.
2. Call list_available_poms to see all existing page objects and available feature folders.
   Determine the correct feature name from these results and the task context.
3. Call get_existing_pom with your determined feature to read any existing POM
4. Call get_existing_tests with your determined feature to see any existing specs
5. Determine which persona this task requires (from personas.md and task context)
6. Call browser_navigate(url, persona="{persona}") — saved auth state is loaded automatically if it exists
7. Check the snapshot URL: if NOT /login, you're already authenticated — skip login and go straight to exploration
   If on /login, log in manually then immediately call browser_command(["state-save", ".playwright-auth/{persona}.json"])
8. Interact using element refs from the snapshot: browser_click("e15"), browser_fill("e5", "value")
9. Collect the "generatedCode" from each action response — these are the exact Playwright locators for your POM
10. For elements you see but don't interact with, call browser_generate_locator(ref) to get their locator
11. Call browser_close() when exploration is complete
12. Write the full Playwright spec using ONLY locators from generatedCode or browser_generate_locator output
    - Import from fixtures: import { test, expect } from '../../../fixtures';
    - Use fixture parameters for any POM already registered in fixtures/index.ts
    - CRITICAL: Use POM methods/properties instead of re-selecting elements (e.g. authPage.login() not page.getByTestId().fill())
    - Add tags to every test: test(..., { tag: ['@smoke', '@auth'] }) and describe block
13. Write or update POM(s) at pages/<your-determined-feature>/ — each POM needs a matching pomPath. Put all POMs in the poms array.
14. Call validate_typescript with your spec — if errors are returned, fix them and re-validate. If valid, proceed to step 15.
15. Call done() with feature (your determined feature name), enrichedSpec, poms, and affectedPaths.
`.trim();
}

export async function runQaAgent(
  task: QATask,
  branch: string,
  repoName: string,
): Promise<{ feature: string; enrichedSpec: string; poms: Array<{ pomContent: string; pomPath: string }>; affectedPaths: string; fixtureUpdate?: string; tokenUsage: TokenUsage }> {
  const calledTools: string[] = [];
  let currentPhase: AgentPhase = 'context';

  const { args, tokenUsage } = await runAgent(
    buildSystemPrompt('context'),
    buildUserMessage(task, branch),
    qaTools,
    createQaHandlers(repoName),
    {
      maxIterations: 80,
      onToolCall: (name) => {
        calledTools.push(name);
        const nextPhase = detectPhase(calledTools);
        if (nextPhase !== currentPhase) {
          currentPhase = nextPhase;
          return buildSystemPrompt(nextPhase);
        }
        return null;
      },
    },
  );
  return {
    feature: args.feature as string,
    enrichedSpec: args.enrichedSpec as string,
    poms: args.poms as Array<{ pomContent: string; pomPath: string }>,
    affectedPaths: args.affectedPaths as string,
    fixtureUpdate: args.fixtureUpdate as string | undefined,
    tokenUsage,
  };
}
