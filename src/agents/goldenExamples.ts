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

## Golden Pattern 2 — Feature tests (use feature fixtures, NO manual instantiation)

Feature tests use POM fixtures that are pre-authenticated. 
NEVER use \`new PageClass(page)\` in spec files. Use the fixture parameter.

\`\`\`typescript
import { test, expect } from '../../../fixtures';

test.describe('Departments | Admin CRUD', { tag: ['@departments', '@regression'] }, () => {
  test('admin sees departments list', async ({ departmentsPage }) => {
    // ✅ departmentsPage is pre-authenticated via the fixture logic
    await departmentsPage.goto();
    await departmentsPage.expectDepartmentsTableVisible();
  });

  test('admin creates a new department', async ({ departmentsPage }) => {
    await departmentsPage.goto();
    await departmentsPage.clickAddDepartment();
    await departmentsPage.fillDepartmentForm('Cardiology', 'Heart and vascular care');
    await departmentsPage.submitDepartmentForm();
    await departmentsPage.expectDepartmentInList('Cardiology');
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

## Golden Pattern 5 — Registering Feature POMs as Fixtures

Every new POM MUST be registered in \`fixtures/index.ts\`. 
This ensures consistent authentication and page initialization.

\`\`\`typescript
// fixtures/index.ts

import { test as base } from '@playwright/test';
import { DepartmentsPage } from '../pages/departments/DepartmentsPage';
import { asAdmin } from './personas'; // assuming asAdmin is a page helper

type Fixtures = {
  departmentsPage: DepartmentsPage;
};

export const test = base.extend<Fixtures>({
  departmentsPage: async ({ asAdmin }, use) => {
    // ✅ Initialize POM with the authenticated persona page
    await use(new DepartmentsPage(asAdmin));
  },
});
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
