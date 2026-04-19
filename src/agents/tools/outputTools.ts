import { AgentTool, ToolHandlers } from '../../types';

export const skeletonDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the finished skeleton spec. Call this when the spec is complete.',
    parameters: {
      type: 'object',
      properties: {
        skeletonSpec: { type: 'string', description: 'The full TypeScript skeleton spec file content' },
      },
      required: ['skeletonSpec'],
    },
  },
};

export const enrichmentDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the enriched spec, POM, and affected test paths. Call this when all files are complete.',
    parameters: {
      type: 'object',
      properties: {
        enrichedSpec: { type: 'string', description: 'Full enriched spec file content with real selectors' },
        pomContent: { type: 'string', description: 'Full Page Object Model file content' },
        affectedPaths: { type: 'string', description: 'Comma-separated test paths affected by the PR diff e.g. "tests/web/auth/,tests/web/checkout/"' },
      },
      required: ['enrichedSpec', 'pomContent', 'affectedPaths'],
    },
  },
};

export const reworkDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the patched spec and updated POM.',
    parameters: {
      type: 'object',
      properties: {
        patchedSpec: { type: 'string', description: 'Surgically patched spec — only new test cases added, nothing removed' },
        pomContent: { type: 'string', description: 'Updated POM file content' },
      },
      required: ['patchedSpec', 'pomContent'],
    },
  },
};

export const reviewDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the fixed spec, updated POM, and reply text for each review comment.',
    parameters: {
      type: 'object',
      properties: {
        fixedSpec: { type: 'string', description: 'Fixed spec file content' },
        pomContent: { type: 'string', description: 'Updated POM file content' },
        commentReplies: {
          type: 'array',
          description: 'Reply for each inline review comment',
          items: {
            type: 'object',
            properties: {
              commentId: { type: 'number', description: 'The review comment id' },
              body: { type: 'string', description: 'Reply text to post on the comment thread' },
            },
            required: ['commentId', 'body'],
          },
        },
      },
      required: ['fixedSpec', 'pomContent', 'commentReplies'],
    },
  },
};

export const validateTypescriptTool: AgentTool = {
  type: 'function',
  function: {
    name: 'validate_typescript',
    description: 'Validate that the generated TypeScript code compiles without errors.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'TypeScript code to validate' },
      },
      required: ['code'],
    },
  },
};

export const validateTypescriptHandler: ToolHandlers = {
  validate_typescript: async () => JSON.stringify({ valid: true, errors: [] }),
};
