// Golden examples for the Writer Agent.
// Concise pattern snippets — not full files. The model extracts patterns from these.

export function formatGoldenExamples(): string {
  return `## Golden Pattern 1 — Auth feature tests (use authPage fixture)

Auth tests interact with the login form. Use the \`authPage\` fixture:

\`\`\`typescript
import { test, expect } from '../../../fixtures';
import { personas } from '../../../config/personas';

test.describe('Auth | Login Validation', { tag: ['@auth', '@smoke'] }, () => {
  test('patient logs in with valid credentials', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.login(personas.patient.email, personas.patient.password);
    await authPage.expectLoginSuccess(/\\\\/dashboard/);
    await authPage.expectUserProfile(personas.patient.displayName, personas.patient.role);
  });

  test('shows error for invalid credentials', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.login('nonexistent@example.com', 'wrongpassword');
    await authPage.expectLoginErrorVisible();
  });
});
\`\`\`

## Golden Pattern 2 — Feature tests (use persona fixtures, NO beforeEach)

Feature tests start already authenticated. Use \`asPatient\`, \`asDoctor\`, or \`asAdmin\`.
Construct POMs inline from the persona page. NEVER use beforeEach to log in.

\`\`\`typescript
import { test, expect } from '../../../fixtures';
import { DepartmentsPage } from '../../pages/departments/DepartmentsPage';

test.describe('Departments | Admin CRUD', { tag: ['@departments', '@regression'] }, () => {
  test('admin sees departments list', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    const deptPage = new DepartmentsPage(asAdmin);
    await deptPage.expectDepartmentsTableVisible();
  });

  test('admin creates a new department', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    const deptPage = new DepartmentsPage(asAdmin);
    await deptPage.clickAddDepartment();
    await deptPage.fillDepartmentForm('Cardiology', 'Heart and vascular care');
    await deptPage.submitDepartmentForm();
    await deptPage.expectDepartmentInList('Cardiology');
  });
});
\`\`\`

## Golden Pattern 3 — Dynamic persona data (NEVER hardcode display names)

Use \`personas.X.displayName\` in assertions — never hardcode "Jane Doe" or "Welcome back":

\`\`\`typescript
import { personas } from '../../../config/personas';

// GOOD — uses persona data dynamically
await pom.expectWelcomeHeading(new RegExp(personas.patient.displayName));

// BAD — hardcoded text that breaks if persona changes
await pom.expectWelcomeHeading(/Welcome back/);
\`\`\`

## Golden Pattern 4 — POM methods for all element access

NEVER access POM locators directly in the spec. Add a method to the POM:

\`\`\`typescript
// POM — add getter methods for attribute access
async getSidebarLinkHref(): Promise<string | null> {
  return this.sidebarBookAppointmentLink.getAttribute('href');
}

// Spec — call the method, don't access the locator
const sidebarHref = await pom.getSidebarLinkHref();

// BAD — direct locator access in spec
const sidebarHref = await pom.sidebarBookAppointmentLink.getAttribute('href');
\`\`\`

## Golden Pattern 5 — Feature POMs are NOT registered as fixtures

When using persona fixtures (\`asPatient\`, etc.), construct POMs inline.
Do NOT register the feature POM in fixtures/index.ts.

\`\`\`typescript
// fixtures/index.ts — only register authPage + persona fixtures
type Fixtures = {
  authPage: AuthPage;
  asPatient: Page;
  asDoctor: Page;
  asAdmin: Page;
};
// NO bookAppointmentPage, NO departmentsPage, etc.

// Spec — construct inline
const pom = new BookAppointmentPage(asPatient);
\`\`\`

## Golden Pattern 6 — Access control tests (compact, no POM needed)

\`\`\`typescript
import { test, expect } from '../../../fixtures';

test.describe('Departments | Access Control', { tag: ['@departments', '@regression'] }, () => {
  test('doctor cannot access departments page', async ({ asDoctor }) => {
    await asDoctor.goto('/departments');
    await expect(asDoctor).toHaveURL(/login|dashboard|403/);
  });

  test('admin can access departments page', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    await expect(asAdmin).toHaveURL(/\\\\/departments/);
    await expect(asAdmin.getByRole('table')).toBeVisible();
  });
});
\`\`\`

## Golden Pattern 7 — POM structure template

\`\`\`typescript
import { Page, Locator, expect } from '@playwright/test';

export class BookAppointmentPage {
  readonly page: Page;
  readonly sidebarLink: Locator;
  readonly ctaButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebarLink = page.getByRole('link', { name: 'Book Appointment' });
    this.ctaButton = page.getByRole('button', { name: 'Book Now' });
  }

  async gotoDashboard(): Promise<void> {
    await this.page.goto('/dashboard');
    await expect(this.sidebarLink).toBeVisible();
  }

  async expectSidebarLinkVisible(): Promise<void> {
    await expect(this.sidebarLink).toBeVisible();
  }

  // Add getter methods for attribute access — never expose locators directly
  async getSidebarHref(): Promise<string | null> {
    return this.sidebarLink.getAttribute('href');
  }
}
\`\``;
}
