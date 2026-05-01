import { QATask, ExplorationReport, WriterContext } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { writerTools, createWriterHandlers } from './tools';
import { formatWriterContext } from '../services/writerContext';
import {
  WRITER_ROLE,
  SPEC_RULES,
  POM_RULES,
  VALIDATION_RULES,
  WRITER_CODE_GEN_SEQUENCE,
} from './prompts/sections';

const WRITER_MAX_ITERATIONS = 20;

function buildSystemPrompt(): string {
  return [
    WRITER_ROLE,
    SPEC_RULES,
    POM_RULES,
    VALIDATION_RULES,
    WRITER_CODE_GEN_SEQUENCE,
  ].join('\n\n');
}

function formatLocators(locators: ExplorationReport['locators']): string {
  if (Object.keys(locators).length === 0) return '(none observed)';
  return Object.entries(locators)
    .map(([route, elements]) => {
      const entries = Object.entries(elements)
        .map(([name, code]) => `    ${name}: ${code}`)
        .join('\n');
      return `  ${route}:\n${entries}`;
    })
    .join('\n');
}

function formatFlows(flows: ExplorationReport['flows']): string {
  if (flows.length === 0) return '(none recorded)';
  return flows
    .map((f, i) =>
      `  ${i + 1}. ${f.name}\n     Steps: ${f.steps}\n     Observed: ${f.observed}`,
    )
    .join('\n\n');
}

function formatMissingLocators(missing: ExplorationReport['missingLocators']): string {
  if (!missing || missing.length === 0) return '(none)';
  return missing
    .map((m) => `  - route: ${m.route} | name: ${m.name} | reason: ${m.reason}`)
    .join('\n');
}

function formatReport(report: ExplorationReport): string {
  return `
## Exploration Report
Feature: ${report.feature} | Persona: ${report.authPersona}
Visited routes: ${report.visitedRoutes.join(', ')}

### Locators (grouped by route)
${formatLocators(report.locators)}

### Flows
${formatFlows(report.flows)}

### Missing Locators
${formatMissingLocators(report.missingLocators)}

### Notes
${report.notes.length > 0 ? report.notes.map((n) => `- ${n}`).join('\n') : '(none)'}
`.trim();
}

function buildUserMessage(task: QATask, branch: string, report: ExplorationReport, ctx: WriterContext): string {
  return `
## Task
ID: ${task.taskId}
Title: ${task.title}
Branch: ${branch}
Feature: ${report.feature}

## Acceptance Criteria
${task.description}

${formatReport(report)}

${formatWriterContext(ctx)}

## Your task
Using the ExplorationReport above:
1. Write a complete Playwright spec at tests/web/${report.feature}/${task.taskId}-<slug>.spec.ts
   - Import: import { test, expect } from '../../../fixtures';
   - Import: import { personas } from '../../../config/personas';
   - Import POM: import { ClassName } from '../../../pages/${report.feature}/ClassName'; (3 levels up from tests/web/feature/)
   - Always use fixture parameters for POMs — if you create a new POM, you MUST register it in fixtures/index.ts and include the updated fixtures/index.ts in your files[] with role="fixture"
   - For each missingLocator, emit a test.skip with the reason from the report
2. Write or update the POM at pages/${report.feature}/<ClassName>.ts
   - Use ONLY locators from the ExplorationReport — never invent selectors
3. Call validate_typescript(code, fileType: "pom") on EACH POM file separately
4. Call validate_typescript(code, fileType: "spec") on the spec
5. If you need to output additional files (mock data, helpers, config updates), include them with role="extra"
6. Fix any errors and re-validate. Once all pass, call done() immediately.
`.trim();
}

export async function runWriterAgent(
  task: QATask,
  branch: string,
  report: ExplorationReport,
  ctx: WriterContext,
): Promise<{
  feature: string;
  files: Array<{ path: string; content: string; role: string }>;
  affectedPaths: string;
  tokenUsage: TokenUsage;
}> {
  const { args, tokenUsage } = await runAgent(
    buildSystemPrompt(),
    buildUserMessage(task, branch, report, ctx),
    writerTools,
    createWriterHandlers(task.outputRepo),
    { maxIterations: WRITER_MAX_ITERATIONS },
  );

  return {
    feature:       args.feature as string,
    files:         args.files as Array<{ path: string; content: string; role: string }>,
    affectedPaths: args.affectedPaths as string,
    tokenUsage,
  };
}
