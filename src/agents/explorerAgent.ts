import { QATask, ExplorationReport } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { explorerTools, createExplorerHandlers } from './tools';
import {
  EXPLORER_ROLE,
  FEATURE_DETERMINATION,
  CONTEXT_SEQUENCE,
  EXPLORATION_SEQUENCE,
  EXPLORER_DONE_RULES,
  BROWSER_TOOLS,
} from './prompts/sections';

const EXPLORER_MAX_ITERATIONS = 60;

function buildSystemPrompt(): string {
  return [
    EXPLORER_ROLE,
    FEATURE_DETERMINATION,
    BROWSER_TOOLS,
    CONTEXT_SEQUENCE,
    EXPLORATION_SEQUENCE,
    EXPLORER_DONE_RULES,
  ].join('\n\n');
}

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
1. Call get_context_docs, get_fixtures, and get_personas to understand project conventions and credentials
2. Call list_available_poms to see all existing page objects and available feature folders
3. Determine the correct feature name from these results and the task context
4. Call get_existing_pom with your determined feature to read any existing POM
5. Call get_existing_tests with your determined feature to see any existing specs
6. Determine which persona this task requires
7. Call browser_navigate(url, persona="{persona}") — saved auth state is loaded automatically if it exists
8. Check the snapshot URL: if NOT /login, you're already authenticated — skip login and go straight to exploration
   If on /login, log in manually then immediately call browser_command(["state-save", ".playwright-auth/{persona}.json"])
9. Explore ALL flows described in the acceptance criteria:
   - Interact using element refs: browser_click("e15"), browser_fill("e5", "value")
   - Collect "generatedCode" from every action response — these become your locators
   - For elements you observe but don't interact with, call browser_generate_locator(ref)
   - For each acceptance criterion you cannot fully explore (missing element), record it in missingLocators
10. Call browser_close() when exploration is complete
11. Call done() with the complete ExplorationReport:
    - locators grouped by route (which page the element lives on)
    - one flow entry per acceptance criterion
    - missingLocators for anything you couldn't observe
    - notes covering: where each element lives, redirects, dynamic content, conditional visibility
`.trim();
}

export async function runExplorerAgent(
  task: QATask,
  branch: string,
  repoName: string,
): Promise<{ report: ExplorationReport; tokenUsage: TokenUsage }> {
  const { args, tokenUsage } = await runAgent(
    buildSystemPrompt(),
    buildUserMessage(task, branch),
    explorerTools,
    createExplorerHandlers(repoName),
    { maxIterations: EXPLORER_MAX_ITERATIONS },
  );

  const report: ExplorationReport = {
    feature:        args.feature as string,
    visitedRoutes:  (args.visitedRoutes as string[]) ?? [],
    authPersona:    args.authPersona as string,
    locators:       (args.locators as Record<string, Record<string, string>>) ?? {},
    flows:          (args.flows as ExplorationReport['flows']) ?? [],
    missingLocators:(args.missingLocators as ExplorationReport['missingLocators']) ?? [],
    notes:          (args.notes as string[]) ?? [],
  };

  return { report, tokenUsage };
}
