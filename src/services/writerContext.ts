import * as localRepo from './localRepo';
import { WriterContext } from '../types';
import { formatGoldenExamples } from '../agents/goldenExamples';

// Feature-independent context — safe to prefetch while the explorer is still running.
interface BaseContext {
  fixtures: string;
  personas: string;
  contextDocs: string;
  availablePoms: string[];
  goldenExamples: string;
}

/**
 * Fetches the parts of WriterContext that don't need the feature name.
 * Called by the orchestrator in parallel with runExplorerAgent so the
 * fetch overlaps with the (long) browser exploration phase.
 */
export async function prefetchBaseContext(repoName: string): Promise<BaseContext> {
  const [fixtures, personas, contextDocsMap, availablePoms] = await Promise.all([
    localRepo.readFile(repoName, 'fixtures/index.ts'),
    localRepo.readFile(repoName, 'config/personas.ts'),
    readContextDocs(repoName),
    localRepo.listAllPoms(repoName),
  ]);

  const contextDocs = Object.entries(contextDocsMap)
    .map(([file, content]) => `## ${file}\n${content}`)
    .join('\n\n');

  return {
    fixtures: fixtures ?? '',
    personas: personas ?? '',
    contextDocs,
    availablePoms,
    goldenExamples: formatGoldenExamples(),
  };
}

async function readContextDocs(repoName: string): Promise<Record<string, string>> {
  const files = await localRepo.listDirectory(repoName, 'context');
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const entries = await Promise.all(
    mdFiles.map(async (f) => {
      const content = await localRepo.readFile(repoName, `context/${f}`);
      return [f, content ?? ''] as [string, string];
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

/**
 * Fetches the feature-specific parts of WriterContext.
 * Called after the explorer returns (feature name is now known).
 */
async function prefetchFeatureContext(
  repoName: string,
  feature: string,
): Promise<Pick<WriterContext, 'existingTests' | 'existingPom'>> {
  const [existingTestsMap, existingPom] = await Promise.all([
    readExistingTests(repoName, feature),
    readExistingPom(repoName, feature),
  ]);
  return { existingTests: existingTestsMap, existingPom };
}

async function readExistingTests(repoName: string, feature: string): Promise<Record<string, string>> {
  const files = await localRepo.listDirectory(repoName, `tests/web/${feature}`);
  const specFiles = files.filter((f) => f.endsWith('.spec.ts'));
  const entries = await Promise.all(
    specFiles.map(async (f) => {
      const content = await localRepo.readFile(repoName, `tests/web/${feature}/${f}`);
      return [f, content ?? ''] as [string, string];
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

async function readExistingPom(repoName: string, feature: string): Promise<string | null> {
  const files = await localRepo.listDirectory(repoName, `pages/${feature}`);
  const pomFile = files.find((n) => n.endsWith('Page.ts'));
  if (!pomFile) return null;
  return localRepo.readFile(repoName, `pages/${feature}/${pomFile}`);
}

/**
 * Merges base + feature context into a complete WriterContext.
 * Call this after the explorer finishes and the feature name is known.
 */
export async function resolveWriterContext(
  repoName: string,
  feature: string,
  base: BaseContext,
): Promise<WriterContext> {
  const featureCtx = await prefetchFeatureContext(repoName, feature);
  return { ...base, ...featureCtx };
}

/** Formats a WriterContext into the user message section injected into the writer. */
export function formatWriterContext(ctx: WriterContext): string {
  const parts: string[] = [];

  parts.push(`## Golden Examples — Follow these patterns exactly\n\n${ctx.goldenExamples}`);

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
