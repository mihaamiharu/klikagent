import * as ts from 'typescript';
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
        pomPath: { type: 'string', description: 'Repo-relative path to write the POM file e.g. "pages/doctors/DoctorProfilePage.ts". Must match the exported class name exactly.' },
        affectedPaths: { type: 'string', description: 'Comma-separated test paths affected by the PR diff e.g. "tests/web/auth/,tests/web/checkout/"' },
      },
      required: ['enrichedSpec', 'pomContent', 'pomPath', 'affectedPaths'],
    },
  },
};

export const qaDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the complete spec, POM(s), POM path(s), and affected test paths. Call this after validate_typescript confirms no errors.',
    parameters: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'The feature folder name you determined for this task (e.g. "auth", "doctors", "dashboard"). Must match an existing folder in pages/ or a key in fixtures/index.ts imports. NEVER use "general".' },
        enrichedSpec: { type: 'string', description: 'Full Playwright TypeScript spec file content with real locators from browser snapshots' },
        poms: {
          type: 'array',
          description: 'List of Page Object Model files to write',
          items: {
            type: 'object',
            properties: {
              pomContent: { type: 'string', description: 'Full Page Object Model file content' },
              pomPath: { type: 'string', description: 'Repo-relative path to write the POM file e.g. "pages/auth/AuthPage.ts". Must match the exported class name exactly.' },
            },
            required: ['pomContent', 'pomPath'],
          },
        },
        affectedPaths: { type: 'string', description: 'Comma-separated test paths affected by the PR diff e.g. "tests/web/auth/,tests/web/checkout/"' },
        fixtureUpdate: { type: 'string', description: 'Full updated content of fixtures/index.ts with the new POM(s) imported and registered. Omit only if the fixtures file already registers all POMs used by this spec.' },
      },
      required: ['feature', 'enrichedSpec', 'poms', 'affectedPaths'],
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
        pomPath: { type: 'string', description: 'Repo-relative path to write the POM file e.g. "pages/doctors/DoctorProfilePage.ts". Must match the exported class name exactly.' },
      },
      required: ['patchedSpec', 'pomContent', 'pomPath'],
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
        pomPath: { type: 'string', description: 'Repo-relative path to write the POM file e.g. "pages/doctors/DoctorProfilePage.ts". Must match the exported class name exactly.' },
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
      required: ['fixedSpec', 'pomContent', 'pomPath', 'commentReplies'],
    },
  },
};

/** Extracts the exported class name from POM content and returns the expected filename. */
export function pomPathFromContent(pomContent: string, feature: string): string {
  const match = pomContent.match(/export\s+class\s+(\w+)/);
  const className = match?.[1] ?? `${feature.charAt(0).toUpperCase()}${feature.slice(1)}Page`;
  return `pages/${feature}/${className}.ts`;
}

export const explorationDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the ExplorationReport after calling browser_close(). Call this only when all browser interactions are complete.',
    parameters: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature folder name e.g. "auth", "doctors"' },
        visitedRoutes: {
          type: 'array',
          items: { type: 'string' },
          description: 'All app routes visited e.g. ["/login", "/dashboard", "/doctor"]',
        },
        authPersona: { type: 'string', description: 'Persona name used for authentication e.g. "patient"' },
        locators: {
          type: 'object',
          description: 'Locators grouped by route. e.g. { "/login": { "emailInput": "page.getByTestId(\'email-input\')" }, "/dashboard": { "logoutButton": "page.getByRole(\'button\', { name: \'Log out\' })" } }',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        flows: {
          type: 'array',
          description: 'One entry per acceptance criterion scenario',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string', description: 'Scenario name e.g. "patient login success"' },
              steps:    { type: 'string', description: 'Step-by-step e.g. "navigate /login → fill email → click submit → redirect /dashboard"' },
              observed: { type: 'string', description: 'What you observed after the flow completed' },
            },
            required: ['name', 'steps', 'observed'],
          },
        },
        missingLocators: {
          type: 'array',
          description: 'Elements expected but not observed in any snapshot',
          items: {
            type: 'object',
            properties: {
              route:  { type: 'string', description: 'Route where the element was expected' },
              name:   { type: 'string', description: 'Descriptive element name e.g. "logoutButton"' },
              reason: { type: 'string', description: 'Why it was not found e.g. "button not present in snapshot"' },
            },
            required: ['route', 'name', 'reason'],
          },
        },
        notes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Critical behavioral observations: where buttons live, redirects, conditional visibility, dynamic content',
        },
      },
      required: ['feature', 'visitedRoutes', 'authPersona', 'locators', 'flows'],
    },
  },
};

export const validateTypescriptTool: AgentTool = {
  type: 'function',
  function: {
    name: 'validate_typescript',
    description: 'Validate that generated TypeScript code compiles without errors. Pass fileType so spec-only checks apply correctly.',
    parameters: {
      type: 'object',
      properties: {
        code:     { type: 'string', description: 'TypeScript code to validate' },
        fileType: { type: 'string', enum: ['spec', 'pom'], description: '"spec" for test files, "pom" for Page Object Models. Spec-only checks (no page.getBy* in spec, no hardcoded persona names) only run for specs.' },
      },
      required: ['code', 'fileType'],
    },
  },
};

export const validateTypescriptHandler: ToolHandlers = {
  validate_typescript: async (args) => {
    const code = args.code as string;
    const fileType = (args.fileType as string | undefined) ?? 'spec';

    const sourceFile = ts.createSourceFile('check.ts', code, ts.ScriptTarget.Latest, true);
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    const errors = diagnostics.map((d) => ({
      line: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));

    // Checks that apply to all files
    const allFilePatterns: Array<{ pattern: RegExp; hint: string }> = [
      {
        pattern: /expect\([^)]+\)\.(toContainText|toHaveText|toBeVisible|toBeDisabled|toBeEnabled|toHaveValue)\([^)]*\)\.or\(/,
        hint: 'expect(...).or() is not valid Playwright — use locator.or(otherLocator) on the locator itself, or use a regex in toContainText(/a|b/)',
      },
    ];

    // Checks that apply to spec files only
    const specOnlyPatterns: Array<{ pattern: RegExp; hint: string }> = [
      {
        pattern: /\bpage\.(getByRole|getByTestId|getByLabel|getByText|getByPlaceholder|locator)\s*\(/,
        hint: 'Direct page.getBy* or page.locator() found in spec file. All element interactions and locators must go through POM methods/properties — never access the page directly from a spec.',
      },
      {
        pattern: /getBy(?:Text|Role)\s*\(\s*['"`][^'"`]*(?:Jane Doe|Jane|Dr\.|Admin)[^'"`]*['"`]/,
        hint: 'Hardcoded persona display name detected. Use personas.patient.displayName (or equivalent) instead of a literal string.',
      },
      {
        pattern: /import\s*{[^}]*}\s*from\s*['"]@playwright\/test['"]/,
        hint: 'Do not import from @playwright/test directly in spec files. Use the fixture layer: import { test, expect } from \'../../../fixtures\'',
      },
    ];

    for (const { pattern, hint } of allFilePatterns) {
      if (pattern.test(code)) errors.push({ line: 0, message: hint });
    }

    if (fileType === 'spec') {
      for (const { pattern, hint } of specOnlyPatterns) {
        if (pattern.test(code)) errors.push({ line: 0, message: hint });
      }
    }

    // Conditional checks: flag patterns that require something else to also be present
    const usesExpect = /\bawait\s+expect\s*\(/.test(code);
    const importsExpect = /import\s*{[^}]*\bexpect\b[^}]*}/.test(code);
    if (usesExpect && !importsExpect) {
      errors.push({
        line: 0,
        message: 'Code uses expect() but does not import it. Add expect to your import: import { Page, Locator, expect } from \'@playwright/test\' (for POMs) or import { test, expect } from \'../fixtures\' (for specs)',
      });
    }

    return JSON.stringify({ valid: errors.length === 0, errors });
  },
};
