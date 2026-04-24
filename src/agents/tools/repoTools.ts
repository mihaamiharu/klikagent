import { AgentTool, ToolHandlers } from '../../types';
import * as testRepo from '../../services/testRepo';

export const repoToolDefs: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_route_map',
      description: 'Get the route map from the test repo config/routes.ts — feature name to URL path.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_context_docs',
      description: 'Get all domain context docs (domain.md, personas.md, test-patterns.md, etc.) from the test repo context/ directory.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fixtures',
      description: 'Get the fixtures/index.ts file from the test repo — shows available test fixtures and page objects.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_helpers',
      description: 'Get utility helpers from the test repo utils/helpers.ts.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_existing_pom',
      description: 'Get the existing Page Object Model file for a feature, if one exists.',
      parameters: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature name e.g. "auth", "checkout"' },
        },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_existing_tests',
      description: 'Get all existing spec files for a feature from the test repo tests/web/{feature}/.',
      parameters: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature name e.g. "auth"' },
        },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_skeleton_spec',
      description: 'Get the skeleton spec file committed to the QA branch for this ticket.',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name e.g. "qa/42-login-validation"' },
          ticketId: { type: 'string', description: 'Issue number e.g. "42"' },
          feature: { type: 'string', description: 'Feature name e.g. "auth"' },
        },
        required: ['branch', 'ticketId', 'feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_pom',
      description: 'Get the current POM file from the QA branch (may have been updated in a previous step).',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          feature: { type: 'string' },
        },
        required: ['branch', 'feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_parent_spec',
      description: 'Get the parent ticket spec file from the QA branch (used in rework flows).',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          parentTicketId: { type: 'string' },
          feature: { type: 'string' },
        },
        required: ['branch', 'parentTicketId', 'feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_available_poms',
      description: 'List all existing Page Object Model files in the test repo pages/ directory. Use this before writing imports to ensure you only import POMs that actually exist.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tsconfig',
      description: 'Get the tsconfig.json from the test repo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_playwright_config',
      description: 'Get the playwright.config.ts from the test repo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export function createRepoToolHandlers(repoName: string): ToolHandlers {
  return {
    get_route_map: async () => JSON.stringify(await testRepo.getRouteMap(repoName)),
    get_context_docs: async () => {
      const docs = await testRepo.getContextDocs(repoName);
      return Object.entries(docs).map(([file, content]) => `## ${file}\n${content}`).join('\n\n');
    },
    get_fixtures: async () => await testRepo.getFixtures(repoName),
    get_helpers: async () => {
      const helpers = await testRepo.getHelpers(repoName);
      return Object.values(helpers).join('\n\n');
    },
    get_existing_pom: async (args) => await testRepo.getExistingPOM(repoName, args.feature as string) ?? '(no POM found)',
    get_existing_tests: async (args) => {
      const tests = await testRepo.getExistingTests(repoName, args.feature as string);
      return Object.entries(tests).map(([f, c]) => `## ${f}\n${c}`).join('\n\n') || '(no existing tests)';
    },
    get_skeleton_spec: async (args) =>
      await testRepo.getCurrentSpec(repoName, args.branch as string, args.ticketId as string, args.feature as string) ?? '(no skeleton found)',
    get_current_pom: async (args) =>
      await testRepo.getCurrentPOM(repoName, args.branch as string, args.feature as string) ?? '(no POM on branch)',
    get_parent_spec: async (args) =>
      await testRepo.getParentSpec(repoName, args.branch as string, args.parentTicketId as string, args.feature as string) ?? '(no parent spec found)',
    list_available_poms: async () => {
      const poms = await testRepo.listAllPOMs(repoName);
      return poms.length > 0 ? poms.join('\n') : '(no POM files found)';
    },
    get_tsconfig: async () => await testRepo.getTsConfig(repoName),
    get_playwright_config: async () => await testRepo.getPlaywrightConfig(repoName),
  };
}
