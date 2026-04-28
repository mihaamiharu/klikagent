import * as testRepo from './testRepo';
import { WriterContext } from '../types';

/**
 * Pre-fetches all repo context the writer agent needs.
 * Called by the orchestrator (qaAgent) between explorerAgent and writerAgent,
 * so the writer receives a fully self-contained context and needs zero repo tool calls.
 */
export async function prefetchWriterContext(repoName: string, feature: string): Promise<WriterContext> {
  const [fixtures, personas, contextDocsMap, availablePoms, existingTestsMap, existingPom] =
    await Promise.all([
      testRepo.getFixtures(repoName),
      testRepo.getPersonas(repoName),
      testRepo.getContextDocs(repoName),
      testRepo.listAllPOMs(repoName),
      testRepo.getExistingTests(repoName, feature),
      testRepo.getExistingPOM(repoName, feature),
    ]);

  const contextDocs = Object.entries(contextDocsMap)
    .map(([file, content]) => `## ${file}\n${content}`)
    .join('\n\n');

  return {
    fixtures,
    personas,
    contextDocs,
    availablePoms,
    existingTests: existingTestsMap,
    existingPom,
  };
}

/** Formats a WriterContext into the user message section injected into the writer. */
export function formatWriterContext(ctx: WriterContext): string {
  const parts: string[] = [];

  parts.push(`## Project Context\n\n### fixtures/index.ts\n\`\`\`typescript\n${ctx.fixtures}\n\`\`\``);
  parts.push(`### config/personas.ts\n\`\`\`typescript\n${ctx.personas}\n\`\`\``);

  if (ctx.contextDocs) {
    parts.push(`### Context Docs\n${ctx.contextDocs}`);
  }

  if (ctx.availablePoms.length > 0) {
    parts.push(`### Available POMs\n${ctx.availablePoms.join('\n')}`);
  } else {
    parts.push(`### Available POMs\n(none yet)`);
  }

  if (Object.keys(ctx.existingTests).length > 0) {
    const tests = Object.entries(ctx.existingTests)
      .map(([f, c]) => `#### ${f}\n\`\`\`typescript\n${c}\n\`\`\``)
      .join('\n\n');
    parts.push(`### Existing Tests\n${tests}`);
  } else {
    parts.push(`### Existing Tests\n(none yet)`);
  }

  if (ctx.existingPom) {
    parts.push(`### Existing POM\n\`\`\`typescript\n${ctx.existingPom}\n\`\`\``);
  } else {
    parts.push(`### Existing POM\n(none yet)`);
  }

  return parts.join('\n\n');
}
