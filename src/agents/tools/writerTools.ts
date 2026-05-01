import { AgentTool, ToolHandlers } from '../../types';
import * as localRepo from '../../services/localRepo';

// ─── Writer discovery tools (Phase 1) ─────────────────────────────────────────
// These give the Writer Agent on-demand access to the test repo filesystem.

export const searchCodebaseTool: AgentTool = {
  type: 'function',
  function: {
    name: 'search_codebase',
    description:
      'Search the test repo for code patterns, utility functions, or existing implementations. ' +
      'Returns up to 10 matches with 2 lines of context each. ' +
      'Use this ONLY when you need to understand how something is done in this repo ' +
      '(e.g. "custom assertion", "date formatting", "API mocking"). ' +
      'Do NOT search for common terms like "expect" or "page" — results will be noisy.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (grep pattern). Be specific.',
        },
        filePattern: {
          type: 'string',
          description: 'Glob pattern for files to search, e.g. "*.ts", "*.json", "utils/*.ts". Defaults to "*.ts".',
        },
        path: {
          type: 'string',
          description: 'Subdirectory to search within, e.g. "utils", "fixtures". Searches entire repo if omitted.',
        },
      },
      required: ['query'],
    },
  },
};

export const getFileTool: AgentTool = {
  type: 'function',
  function: {
    name: 'get_file',
    description:
      'Read the full contents of a specific file from the test repo. ' +
      'Use this after search_codebase identifies a relevant file, ' +
      'or when you need to read a file not in your pre-fetched context. ' +
      'Do NOT use this to re-read fixtures/index.ts or config/personas.ts — those are already in your context.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo-relative file path e.g. "utils/dateHelpers.ts", "fixtures/mock-data/auth.json"',
        },
      },
      required: ['path'],
    },
  },
};

export const listDirectoryTool: AgentTool = {
  type: 'function',
  function: {
    name: 'list_directory',
    description:
      'List files and subdirectories in a given path within the test repo. ' +
      'Use this to discover what utilities, helpers, or fixtures exist ' +
      'when you do not know the exact file names.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo-relative directory path e.g. "utils", "fixtures", "pages/auth". Use "" for repo root.',
        },
      },
      required: ['path'],
    },
  },
};

export const writerDiscoveryTools: AgentTool[] = [searchCodebaseTool, getFileTool, listDirectoryTool];

export function createWriterDiscoveryHandlers(repoName: string): ToolHandlers {
  return {
    search_codebase: async (args) => {
      const query = String(args.query ?? '');
      if (!query) throw new Error('search_codebase: query is required');
      const filePattern = args.filePattern ? String(args.filePattern) : undefined;
      const searchPath = args.path ? String(args.path) : undefined;
      const { matches, truncated } = await localRepo.searchCodebase(repoName, query, { filePattern, path: searchPath });
      return JSON.stringify({
        matches,
        truncated,
        note: truncated
          ? '10 of 10+ matches shown — narrow your query or search a specific path.'
          : undefined,
      });
    },
    get_file: async (args) => {
      const filePath = String(args.path ?? '');
      if (!filePath) throw new Error('get_file: path is required');
      const content = await localRepo.readFile(repoName, filePath);
      if (content === null) return JSON.stringify({ error: 'FILE_NOT_FOUND', path: filePath });
      return content;
    },
    list_directory: async (args) => {
      const dirPath = String(args.path ?? '');
      const entries = await localRepo.listDirectory(repoName, dirPath);
      return JSON.stringify({ path: dirPath, entries });
    },
  };
}
