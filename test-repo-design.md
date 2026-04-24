# Test Repo Design

## What is a Test Repo?

A test repo is the GitHub repository where KlikAgent commits generated Playwright specs and Page Object Models. Each team has their own test repo. KlikAgent reads context from it and writes back to it — all via `task.outputRepo` in the POST /tasks payload.

KlikAgent provisions new test repos via `POST /repos/provision`, which seeds the convention structure automatically.

---

## How KlikAgent Uses the Test Repo

### Reads (agent context)
Before writing any spec, the QA agent reads these files to understand the project:

| File | Purpose |
|---|---|
| `config/routes.ts` | Maps feature names to URL paths — used for feature detection and navigation |
| `config/keywords.json` | Maps feature names to keywords — used to detect which feature a ticket belongs to |
| `context/domain.md` | App domain knowledge — feeds the agent's understanding of the business |
| `context/personas.md` | User personas — tells the agent who the users are |
| `context/test-patterns.md` | Test conventions and anti-patterns for this team |
| `fixtures/index.ts` | Available Playwright fixtures and registered POMs |
| `pages/{feature}/{ClassName}Page.ts` | Existing POMs — agent checks these before writing new ones |
| `tests/web/{feature}/*.spec.ts` | Existing specs — agent uses these as style references |
| `utils/helpers.ts` | Shared test helpers |
| `tsconfig.json` | TypeScript config — used by the self-correction validator |
| `playwright.config.ts` | Playwright config — baseURL, timeouts, reporters |

### Writes (agent output)
After generating a spec, KlikAgent commits to a `qa/` branch and opens a draft PR:

| Path | Content |
|---|---|
| `tests/web/{feature}/{ticketId}.spec.ts` | Generated Playwright spec |
| `pages/{feature}/{ClassName}Page.ts` | Generated Page Object Model |

Branch naming: `qa/{ticketId}-{slug}` (max 40 chars slug, lowercase, hyphens)

---

## Required Directory Convention

All test repos managed by KlikAgent must follow this exact layout:

```
config/
  routes.ts             # REQUIRED — feature → URL path map
  keywords.json         # REQUIRED — feature → keyword list
  personas.json         # OPTIONAL — persona credentials (resolved from env vars)
context/
  domain.md             # REQUIRED — app domain description
  personas.md           # REQUIRED — user persona descriptions
  test-patterns.md      # REQUIRED — test conventions
fixtures/
  index.ts              # REQUIRED — Playwright fixtures + POM registrations
pages/
  {feature}/
    {ClassName}Page.ts  # per-feature POMs
tests/
  web/
    {feature}/
      {ticketId}.spec.ts
utils/
  helpers.ts            # REQUIRED — shared helpers (can be empty scaffold)
tsconfig.json           # REQUIRED
playwright.config.ts    # REQUIRED
package.json            # REQUIRED — must have @playwright/test
```

---

## File Specifications

### `config/routes.ts`
Maps feature names to base URL paths. The agent uses this to know where to navigate for each feature.

```typescript
export default {
  auth: '/login',
  billing: '/billing',
  dashboard: '/dashboard',
  // add more features here
};
```

**Rules:**
- Keys must be lowercase, single words (used as feature identifiers throughout)
- Values are URL paths relative to `playwright.config.ts` baseURL
- Every feature that has specs should have a route entry

---

### `config/keywords.json`
Maps feature names to keywords found in ticket titles/descriptions. KlikAgent uses this to auto-detect the feature when `task.feature` is not provided.

```json
{
  "auth": ["login", "sign in", "sign up", "password", "logout"],
  "billing": ["invoice", "payment", "subscription", "billing"],
  "dashboard": ["dashboard", "overview", "home"]
}
```

**Rules:**
- Keys must match keys in `routes.ts`
- Values are keyword arrays — partial match is enough
- More keywords = better feature detection accuracy

---

### `context/domain.md`
Plain English description of the app. The agent reads this to understand business context before writing tests.

**What to include:**
- What the app does (1-2 paragraphs)
- Key entities (e.g. "A Patient can book appointments with Doctors")
- Business rules that affect test logic (e.g. "Only patients with completed appointments can leave reviews")
- Any domain-specific terminology

**What NOT to include:** technical implementation details, infrastructure, deployment info

---

### `context/personas.md`
Describes the human users of the app. The agent uses this to write realistic test scenarios.

**What to include:**
- Role names (must match keys in `config/personas.json` if used)
- What each role can and cannot do
- Example journeys per role

```markdown
## Patient
Can book appointments, view history, leave reviews for completed appointments.
Cannot access doctor management or admin panels.

## Doctor
Can view their schedule, manage availability, see patient reviews.
Cannot book appointments on behalf of patients.
```

---

### `context/test-patterns.md`
Team-specific testing conventions. This is the most important context file — it shapes how the agent writes tests.

**What to include:**
- Import style (e.g. `import { test, expect } from '../../../fixtures'`)
- POM usage rules (e.g. always use POM methods, never re-select elements)
- Tagging conventions (feature tags, test type tags)
- What to assert vs what not to assert
- Common patterns used in this team's tests
- Known anti-patterns to avoid

---

### `fixtures/index.ts`
Playwright test fixture definitions. The agent reads this to know which POMs are already registered as fixtures and how to import them.

```typescript
import { test as base } from '@playwright/test';
import { AuthPage } from '../pages/auth/AuthPage';

type Fixtures = {
  authPage: AuthPage;
};

export const test = base.extend<Fixtures>({
  authPage: async ({ page }, use) => {
    await use(new AuthPage(page));
  },
});

export { expect } from '@playwright/test';
```

**Rules:**
- The agent imports from `fixtures/index.ts` — this file must export `test` and `expect`
- Every registered POM should be in the fixtures file
- New POMs generated by KlikAgent will need to be manually added here after review

---

### `utils/helpers.ts`
Shared test helper functions. Can start as a minimal scaffold.

```typescript
import { Page } from '@playwright/test';

export async function waitForNetworkIdle(page: Page, timeout = 5000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
}
```

---

### `playwright.config.ts`
Standard Playwright config. The `baseURL` is the QA environment URL.

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'https://qa.yourapp.com',
    headless: true,
    screenshot: 'only-on-failure',
  },
  reporter: [['html', { open: 'never' }]],
});
```

---

### POM conventions (`pages/{feature}/{ClassName}Page.ts`)
Page Object Models follow a strict convention so the agent can discover and reuse them.

```typescript
import { Page, Locator } from '@playwright/test';

export class AuthPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(private page: Page) {
    this.emailInput = page.getByTestId('email-input');
    this.passwordInput = page.getByTestId('password-input');
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectLoginSuccess(): Promise<void> {
    await this.page.waitForURL('**/dashboard');
  }
}
```

**Rules:**
- File path: `pages/{feature}/{ClassName}Page.ts`
- Class name must end with `Page`
- Expose locators as `readonly` properties
- Expose actions as async methods
- The agent will use these methods in specs — never re-select elements

---

## Spec conventions (`tests/web/{feature}/{ticketId}.spec.ts`)

```typescript
import { test, expect } from '../../../fixtures';

test.describe('Auth | Login form validation', { tag: '@auth' }, () => {
  test('shows error message on invalid credentials', { tag: ['@auth', '@regression'] }, async ({ authPage }) => {
    await authPage.navigateToLogin();
    await authPage.login('invalid@example.com', 'wrongpass');
    await authPage.expectErrorMessage('Invalid credentials');
  });
});
```

**Rules:**
- Import from `../../../fixtures` (relative, 3 levels up from `tests/web/{feature}/`)
- Use fixture parameters for registered POMs
- Every test must have feature tag + type tag (`@smoke`, `@regression`, `@full`)
- Describe block tag is the feature; test tags are feature + type

---

## Provisioning a New Team

When a new team wants to use KlikAgent, call:

```bash
curl -X POST http://klikagent.internal/repos/provision \
  -H "Content-Type: application/json" \
  -d '{
    "repoName": "myteam-tests",
    "owner": "your-org",
    "qaEnvUrl": "https://qa.myteam.com",
    "features": ["auth", "billing", "dashboard"],
    "domainContext": "A SaaS platform for X. Key entities: ..."
  }'
```

This creates the repo and seeds all required files. After provisioning, the team should:
1. Clone the repo and install deps (`npm install`)
2. Flesh out `context/domain.md` with real domain knowledge
3. Flesh out `context/personas.md` with real user roles
4. Update `context/test-patterns.md` with team conventions
5. Add `config/keywords.json` entries for better feature detection
6. Add real personas to `config/personas.json` if using persona-based auth

---

## What Makes a Good Test Repo

| Factor | Impact |
|---|---|
| Rich `context/domain.md` | Agent writes domain-accurate assertions |
| Detailed `context/test-patterns.md` | Agent follows team conventions without correction |
| Complete `config/keywords.json` | Correct feature routing, fewer misclassified specs |
| Fixtures wired for all POMs | Agent uses fixture params instead of manual instantiation |
| Real locators in existing POMs | Agent reuses proven selectors instead of guessing |

The test repo is the agent's only source of truth about the project. The better it is, the better the output.
