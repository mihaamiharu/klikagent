import { createRepo, commitFile, getDefaultBranchSha } from './github';
import { PersonaSeed, ProvisionRequest, ProvisionResult } from '../types';
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

const DEFAULT_PERSONAS: Record<string, PersonaSeed> = {
  admin:   { email: 'admin@caresync.dev',    password: 'Password123!', displayName: 'Admin',     role: 'admin' },
  doctor:  { email: 'dr.smith@caresync.dev', password: 'Password123!', displayName: 'Dr. Smith', role: 'doctor' },
  patient: { email: 'jane.doe@caresync.dev', password: 'Password123!', displayName: 'Jane',      role: 'patient' },
};

function seedPersonasTs(personas?: Record<string, PersonaSeed>): string {
  const map = personas ?? DEFAULT_PERSONAS;
  const entries = Object.entries(map).map(([key, val]) => {
    const fields = Object.entries(val)
      .map(([k, v]) => `    ${k}: '${v}'`)
      .join(',\n');
    return `  ${key}: {\n${fields}\n  }`;
  });
  return `export const personas = {\n${entries}\n} as const;\n\nexport type PersonaName = keyof typeof personas;\nexport type Persona = (typeof personas)[PersonaName];\n`;
}

function seedPersonasMd(): string {
  return `# Personas\n\nDescribe the user personas for this application.\n\n## Example\n\n- **admin** — has full access to all features\n- **user** — standard user with limited access\n`;
}

function seedTestPatternsMd(): string {
  return `# Test Patterns\n\n## General rules\n- Use Page Object Models for all page interactions\n- Use \`getByTestId\` when data-testid attributes are available\n- Prefer \`getByRole\` over CSS selectors\n- Always await assertions — never use synchronous expect\n\n## Tags\n- Add feature tag and test type to every test: \`{ tag: ['@feature', '@smoke'] }\`\n- Describe block: \`test.describe('Feature | Scenario', { tag: '@feature' })\`\n\n## POM rules\n- One POM per feature in pages/{feature}/{ClassName}Page.ts\n- Expose locators as properties, actions as methods\n- Use POM methods in specs — never re-select elements directly\n`;
}

function seedFixturesTs(_features: string[]): string {
  return [
    `import { test as base, Page } from '@playwright/test';`,
    `import { AuthPage } from '../pages/auth/AuthPage';`,
    ``,
    `// Register your Page Object Models here as fixture parameters.`,
    `// After each PR is merged, import the new POM and register it below.`,
    ``,
    `type Fixtures = {`,
    `  // Auth — use for login-page tests (form validation, error states, etc.)`,
    `  authPage: AuthPage;`,
    ``,
    `  // Persona fixtures — provide a pre-authenticated Page via storageState.`,
    `  // global-setup.ts logs in once per persona and saves .playwright-auth/{persona}.json.`,
    `  // Use in feature tests: test('...', async ({ asPatient }) => { await asPatient.goto('/dashboard'); ... })`,
    `  asPatient: Page;`,
    `  asDoctor: Page;`,
    `  asAdmin: Page;`,
    `};`,
    ``,
    `export const test = base.extend<Fixtures>({`,
    `  authPage: async ({ page }, use) => {`,
    `    await use(new AuthPage(page));`,
    `  },`,
    ``,
    `  asPatient: async ({ browser }, use) => {`,
    `    const ctx = await browser.newContext({ storageState: '.playwright-auth/patient.json' });`,
    `    const page = await ctx.newPage();`,
    `    await use(page);`,
    `    await ctx.close();`,
    `  },`,
    ``,
    `  asDoctor: async ({ browser }, use) => {`,
    `    const ctx = await browser.newContext({ storageState: '.playwright-auth/doctor.json' });`,
    `    const page = await ctx.newPage();`,
    `    await use(page);`,
    `    await ctx.close();`,
    `  },`,
    ``,
    `  asAdmin: async ({ browser }, use) => {`,
    `    const ctx = await browser.newContext({ storageState: '.playwright-auth/admin.json' });`,
    `    const page = await ctx.newPage();`,
    `    await use(page);`,
    `    await ctx.close();`,
    `  },`,
    `});`,
    ``,
    `export { expect } from '@playwright/test';`,
  ].join('\n') + '\n';
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

function seedGlobalSetupTs(): string {
  return [
    `import { chromium, FullConfig } from '@playwright/test';`,
    `import { personas } from './config/personas';`,
    `import fs from 'fs';`,
    `import path from 'path';`,
    ``,
    `/**`,
    ` * Global setup — runs once before the entire test suite.`,
    ` * Logs in as each persona and saves storageState to .playwright-auth/{persona}.json.`,
    ` * Tests load the saved state via asPatient / asDoctor / asAdmin fixtures — no login boilerplate needed.`,
    ` */`,
    `export default async function globalSetup(config: FullConfig) {`,
    `  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:3000';`,
    `  const authDir = path.join(process.cwd(), '.playwright-auth');`,
    `  fs.mkdirSync(authDir, { recursive: true });`,
    ``,
    `  const browser = await chromium.launch();`,
    ``,
    `  for (const [name, persona] of Object.entries(personas)) {`,
    `    const context = await browser.newContext({ baseURL });`,
    `    const page = await context.newPage();`,
    `    await page.goto('/login');`,
    `    await page.getByTestId('email-input').fill(persona.email);`,
    `    await page.getByTestId('password-input').fill(persona.password);`,
    `    await page.getByTestId('login-submit').click();`,
    `    // Wait for any post-login URL — different personas may land on different pages`,
    `    await page.waitForURL(url => !url.pathname.startsWith('/login'));`,
    `    await context.storageState({ path: path.join(authDir, \`\${name}.json\`) });`,
    `    await context.close();`,
    `  }`,
    ``,
    `  await browser.close();`,
    `}`,
  ].join('\n') + '\n';
}

function seedPlaywrightConfig(qaEnvUrl: string): string {
  return [
    `import { defineConfig } from '@playwright/test';`,
    ``,
    `export default defineConfig({`,
    `  testDir: './tests',`,
    `  timeout: 30000,`,
    `  globalSetup: require.resolve('./global-setup'),`,
    `  use: {`,
    `    baseURL: '${qaEnvUrl}',`,
    `    headless: true,`,
    `    screenshot: 'only-on-failure',`,
    `    video: 'retain-on-failure',`,
    `    trace: 'retain-on-failure',`,
    `  },`,
    `  reporter: [['html', { open: 'never' }], ['list']],`,
    `});`,
  ].join('\n') + '\n';
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
    { path: 'config/personas.ts',        content: seedPersonasTs(req.personas) },
    { path: 'context/domain.md',         content: seedDomainMd(req.domainContext) },
    { path: 'context/personas.md',       content: seedPersonasMd() },
    { path: 'context/test-patterns.md',  content: seedTestPatternsMd() },
    { path: 'fixtures/index.ts',         content: seedFixturesTs(req.features) },
    { path: 'global-setup.ts',           content: seedGlobalSetupTs() },
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
