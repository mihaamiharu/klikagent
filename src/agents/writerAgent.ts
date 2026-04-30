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
   - Always use fixture parameters for POMs — if you create a new POM, you MUST register it in fixtures/index.ts and pass the updated file as fixtureUpdate in done()
   - For each missingLocator, emit a test.skip with the reason from the report
2. Write or update the POM at pages/${report.feature}/<ClassName>.ts
   - Use ONLY locators from the ExplorationReport — never invent selectors
3. Call validate_typescript(code, fileType: "pom") on the POM first
4. Call validate_typescript(code, fileType: "spec") on the spec
5. Fix any errors and re-validate. Once both pass, call done() immediately.
`.trim();
}

export async function runWriterAgent(
  task: QATask,
  branch: string,
  report: ExplorationReport,
  ctx: WriterContext,
): Promise<{
  feature: string;
  enrichedSpec: string;
  poms: Array<{ pomContent: string; pomPath: string }>;
  affectedPaths: string;
  fixtureUpdate?: string;
  tokenUsage: TokenUsage;
}> {
  const { args, tokenUsage } = await runAgent(
    buildSystemPrompt(),
    buildUserMessage(task, branch, report, ctx),
    writerTools,
    createWriterHandlers(),
    { maxIterations: WRITER_MAX_ITERATIONS },
  );

  return {
    feature:        args.feature as string,
    enrichedSpec:   args.enrichedSpec as string,
    poms:           args.poms as Array<{ pomContent: string; pomPath: string }>,
    affectedPaths:  args.affectedPaths as string,
    fixtureUpdate:  args.fixtureUpdate as string | undefined,
    tokenUsage,
  };
}
