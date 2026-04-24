import { createRepo, commitFile, getDefaultBranchSha } from './github';
import { ProvisionRequest, ProvisionResult } from '../types';
import { log } from '../utils/logger';

function seedRoutesTs(features: string[]): string {
  const entries = features.map((f) => `  ${f}: '/${f}',`).join('\n');
  return `export default {\n${entries}\n};\n`;
}

function seedKeywordsJson(features: string[]): string {
  const obj = Object.fromEntries(features.map((f) => [f, [f]]));
  return JSON.stringify(obj, null, 2) + '\n';
}

function seedDomainMd(domainContext: string): string {
  return `# Domain Context\n\n${domainContext}\n`;
}

function seedPersonasMd(): string {
  return `# Personas\n\nDescribe the user personas for this application.\n\n## Example\n\n- **admin** — has full access to all features\n- **user** — standard user with limited access\n`;
}

function seedTestPatternsMd(): string {
  return `# Test Patterns\n\n## General rules\n- Use Page Object Models for all page interactions\n- Use \`getByTestId\` when data-testid attributes are available\n- Prefer \`getByRole\` over CSS selectors\n- Always await assertions — never use synchronous expect\n\n## Tags\n- Add feature tag and test type to every test: \`{ tag: ['@feature', '@smoke'] }\`\n- Describe block: \`test.describe('Feature | Scenario', { tag: '@feature' })\`\n\n## POM rules\n- One POM per feature in pages/{feature}/{ClassName}Page.ts\n- Expose locators as properties, actions as methods\n- Use POM methods in specs — never re-select elements directly\n`;
}

function seedFixturesTs(features: string[]): string {
  const imports = features.map((f) => {
    const cls = f.charAt(0).toUpperCase() + f.slice(1);
    return `// import { ${cls}Page } from '../pages/${f}/${cls}Page';`;
  }).join('\n');
  return `import { test as base } from '@playwright/test';\n\n${imports}\n\n// Register your Page Object Models here as fixture parameters.\n// Example:\n// type Fixtures = { authPage: AuthPage };\n// export const test = base.extend<Fixtures>({\n//   authPage: async ({ page }, use) => { await use(new AuthPage(page)); },\n// });\n\nexport const test = base;\nexport { expect } from '@playwright/test';\n`;
}

function seedHelpersTs(): string {
  return `import { Page } from '@playwright/test';\n\nexport async function waitForNetworkIdle(page: Page, timeout = 5000): Promise<void> {\n  await page.waitForLoadState('networkidle', { timeout });\n}\n`;
}

function seedTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      strict: true,
      esModuleInterop: true,
      outDir: 'dist',
      baseUrl: '.',
    },
    include: ['**/*.ts'],
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

function seedPlaywrightConfig(qaEnvUrl: string): string {
  return `import { defineConfig } from '@playwright/test';\n\nexport default defineConfig({\n  testDir: './tests',\n  timeout: 30000,\n  use: {\n    baseURL: '${qaEnvUrl}',\n    headless: true,\n    screenshot: 'only-on-failure',\n  },\n  reporter: [['html', { open: 'never' }]],\n});\n`;
}

export async function provisionRepo(req: ProvisionRequest): Promise<ProvisionResult> {
  log('INFO', `[repoProvisioner] Creating repo ${req.owner}/${req.repoName}`);

  const { htmlUrl, cloneUrl, defaultBranch } = await createRepo(req.owner, req.repoName);

  // Wait briefly for GitHub to finish initializing the repo after auto_init
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const baseSha = await getDefaultBranchSha(req.repoName);
  log('INFO', `[repoProvisioner] Seeding convention files on ${defaultBranch} (sha=${baseSha})`);

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: 'config/routes.ts',          content: seedRoutesTs(req.features) },
    { path: 'config/keywords.json',      content: seedKeywordsJson(req.features) },
    { path: 'context/domain.md',         content: seedDomainMd(req.domainContext) },
    { path: 'context/personas.md',       content: seedPersonasMd() },
    { path: 'context/test-patterns.md',  content: seedTestPatternsMd() },
    { path: 'fixtures/index.ts',         content: seedFixturesTs(req.features) },
    { path: 'pages/.gitkeep',            content: '' },
    { path: 'tests/web/.gitkeep',        content: '' },
    { path: 'utils/helpers.ts',          content: seedHelpersTs() },
    { path: 'tsconfig.json',             content: seedTsConfig() },
    { path: 'playwright.config.ts',      content: seedPlaywrightConfig(req.qaEnvUrl) },
  ];

  for (const { path, content } of seedFiles) {
    await commitFile(req.repoName, defaultBranch, path, content, `chore: seed ${path} [klikagent]`);
    log('INFO', `[repoProvisioner] Seeded ${path}`);
  }

  log('INFO', `[repoProvisioner] Done — ${htmlUrl}`);
  return { repoUrl: htmlUrl, cloneUrl, defaultBranch };
}
