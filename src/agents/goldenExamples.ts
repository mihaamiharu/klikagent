// Golden examples for the Writer Agent.
// Curated from real klikagent-demo-tests patterns + Playwright best practices.
// These demonstrate correct import style, POM usage, selector priority,
// auto-retrying assertions, and role-based test structure.

// ─── Example 1: Auth — Login validation (happy path + negative cases) ────────
// Demonstrates:
//   - Import from project fixtures (NOT @playwright/test)
//   - Import personas for credentials (NEVER hardcode)
//   - POM-only locators — all interactions through AuthPage methods
//   - Auto-retrying assertions (toBeVisible, toHaveURL, toContainText)
//   - Tagging: feature + test type
//   - Selector priority: getByRole > getByTestId > getByLabel

export const AUTH_LOGIN_EXAMPLE = {
  label: 'Example 1 — Auth: Login validation (positive + negative)',
  specPath: 'tests/web/auth/38-login-validation.spec.ts',
  spec: `import { test, expect } from '../../../fixtures';
import { personas } from '../../../config/personas';

test.describe('Auth | Login Validation', { tag: ['@auth', '@smoke'] }, () => {
  test('patient logs in with valid credentials', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.login(personas.patient.email, personas.patient.password);
    await authPage.expectLoginSuccess(/\\/dashboard/);
    await authPage.expectUserProfile(personas.patient.displayName, personas.patient.role);
  });

  test('shows error for invalid credentials', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.login('nonexistent@example.com', 'wrongpassword');
    await authPage.expectLoginErrorVisible();
  });

  test('shows validation for empty password', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.loginWithPartialFields(personas.patient.email, '');
    await authPage.expectPasswordValidationError();
  });

  test('shows validation for invalid email format', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.loginWithPartialFields('not-an-email', '');
    await authPage.expectEmailValidationError();
  });

  test('email field retains value after failed login', async ({ authPage }) => {
    await authPage.gotoLogin();
    await authPage.loginWithPartialFields(personas.patient.email, '');
    await authPage.expectEmailFieldRetainsValue(personas.patient.email);
  });
});
`,
  pomPath: 'pages/auth/AuthPage.ts',
  pom: `import { Page, Locator, expect } from '@playwright/test';

export class AuthPage {
  readonly page: Page;

  // Login form locators
  readonly careSyncHeading: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorAlert: Locator;
  readonly emailError: Locator;
  readonly passwordError: Locator;
  readonly signUpLink: Locator;

  // Sidebar (authenticated pages)
  readonly sidebar: Locator;
  readonly logoutButton: Locator;

  constructor(page: Page) {
    this.page = page;

    // Login form — prefer getByTestId for form fields, getByRole for buttons
    this.careSyncHeading = page.getByRole('heading', { name: 'CareSync' });
    this.emailInput = page.getByTestId('email-input');
    this.passwordInput = page.getByTestId('password-input');
    this.submitButton = page.getByTestId('login-submit');
    this.errorAlert = page.getByTestId('login-error');
    this.emailError = page.getByTestId('email-error');
    this.passwordError = page.getByTestId('password-error');
    this.signUpLink = page.getByTestId('register-link');

    // Sidebar (authenticated)
    this.sidebar = page.getByRole('complementary');
    this.logoutButton = page.getByRole('button', { name: 'Log out' });
  }

  async gotoLogin(): Promise<void> {
    await this.page.goto('/login');
    await this.careSyncHeading.waitFor({ state: 'visible' });
  }

  async login(email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async loginWithPartialFields(email: string, password: string): Promise<void> {
    if (email !== undefined) {
      await this.emailInput.fill(email);
    }
    if (password !== undefined) {
      await this.passwordInput.fill(password);
    }
    await this.submitButton.click();
  }

  async clearFields(): Promise<void> {
    await this.emailInput.clear();
    await this.passwordInput.clear();
  }

  async expectOnLoginPage(): Promise<void> {
    await expect(this.page).toHaveURL(/\\/login/);
    await this.careSyncHeading.waitFor({ state: 'visible' });
  }

  async expectLoginSuccess(expectedUrlPattern: RegExp): Promise<void> {
    await expect(this.page).toHaveURL(expectedUrlPattern);
  }

  async expectLoginErrorVisible(): Promise<void> {
    await expect(this.errorAlert).toBeVisible();
    await expect(this.errorAlert).toContainText('Invalid email or password');
  }

  async expectEmailValidationError(): Promise<void> {
    await expect(this.emailError).toBeVisible();
    await expect(this.emailError).toContainText('Invalid email address');
  }

  async expectPasswordValidationError(): Promise<void> {
    await expect(this.passwordError).toBeVisible();
    await expect(this.passwordError).toContainText('Password must be at least 6 characters');
  }

  async expectEmailFieldRetainsValue(email: string): Promise<void> {
    await expect(this.emailInput).toHaveValue(email);
  }

  async expectNoLoginError(): Promise<void> {
    await expect(this.errorAlert).not.toBeVisible();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
    await this.expectOnLoginPage();
  }

  async expectUserProfile(name: string, role: string): Promise<void> {
    await expect(this.sidebar.getByText(name, { exact: false })).toBeVisible();
    await expect(this.sidebar.getByText(role, { exact: true })).toBeVisible();
  }

  async expectWelcomeHeading(textPattern: string | RegExp): Promise<void> {
    const heading = this.page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(textPattern);
  }

  async expectAdminHeading(): Promise<void> {
    const heading = this.page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(/Admin Dashboard/);
  }
}
`,
  fixturesUpdate: `import { AuthPage } from '../pages/auth/AuthPage';
import { test as base, Page } from '@playwright/test';

// POMs are added here as KlikAgent generates and reviews them.
// After each PR is merged, import the new POM and register it below.

type Fixtures = {
  // Auth — use for login-page tests (form validation, error states, etc.)
  authPage: AuthPage;

  // Persona fixtures — provide a pre-authenticated Page via storageState.
  // global-setup.ts logs in once per persona and saves .playwright-auth/{persona}.json.
  // Use in feature tests: test('...', async ({ asPatient }) => { await asPatient.goto('/dashboard'); ... })
  asPatient: Page;
  asDoctor: Page;
  asAdmin: Page;
};

export const test = base.extend<Fixtures>({
  authPage: async ({ page }, use) => {
    await use(new AuthPage(page));
  },

  asPatient: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: '.playwright-auth/patient.json' });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  asDoctor: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: '.playwright-auth/doctor.json' });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },

  asAdmin: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: '.playwright-auth/admin.json' });
    const page = await ctx.newPage();
    await use(page);
    await ctx.close();
  },
});

export { expect } from '@playwright/test';
`,
};

// ─── Example 2: Departments — Admin CRUD with persona fixture ───────────────
// Demonstrates:
//   - asAdmin fixture (pre-authenticated via storageState, NO beforeEach)
//   - Role-based test structure (admin-only feature)
//   - CRUD flow: create → verify → update → delete
//   - Dynamic locator with parameterized POM method
//   - URL assertion after navigation
//   - @regression tag for detailed edge-case coverage
//   - POM constructed inline from persona page (not registered as fixture)

export const DEPARTMENTS_ADMIN_EXAMPLE = {
  label: 'Example 2 — Departments: Admin CRUD operations',
  specPath: 'tests/web/departments/41-department-crud.spec.ts',
  spec: `import { test, expect } from '../../../fixtures';
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

  test('admin edits an existing department', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    const deptPage = new DepartmentsPage(asAdmin);
    await deptPage.clickEditDepartment('Cardiology');
    await deptPage.fillDepartmentForm('Cardiology', 'Updated description');
    await deptPage.submitDepartmentForm();
    await deptPage.expectDepartmentDescription('Cardiology', 'Updated description');
  });

  test('admin deletes a department', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    const deptPage = new DepartmentsPage(asAdmin);
    await deptPage.clickDeleteDepartment('Cardiology');
    await deptPage.confirmDelete();
    await deptPage.expectDepartmentNotInList('Cardiology');
  });

  test('cannot create department with duplicate name', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    const deptPage = new DepartmentsPage(asAdmin);
    await deptPage.clickAddDepartment();
    await deptPage.fillDepartmentForm('Cardiology', 'Duplicate');
    await deptPage.submitDepartmentForm();
    await deptPage.expectDuplicateNameError();
  });
});
`,
  pomPath: 'pages/departments/DepartmentsPage.ts',
  pom: `import { Page, Locator, expect } from '@playwright/test';

export class DepartmentsPage {
  readonly page: Page;
  readonly departmentsTable: Locator;
  readonly addDepartmentButton: Locator;
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly duplicateError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.departmentsTable = page.getByRole('table');
    this.addDepartmentButton = page.getByRole('button', { name: 'Add Department' });
    this.nameInput = page.getByLabel('Department name');
    this.descriptionInput = page.getByLabel('Description');
    this.submitButton = page.getByRole('button', { name: 'Save' });
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
    this.duplicateError = page.getByTestId('duplicate-name-error');
  }

  async gotoDepartments(): Promise<void> {
    await this.page.goto('/departments');
    await expect(this.departmentsTable).toBeVisible();
  }

  async expectDepartmentsTableVisible(): Promise<void> {
    await expect(this.departmentsTable).toBeVisible();
  }

  async clickAddDepartment(): Promise<void> {
    await this.addDepartmentButton.click();
    await expect(this.nameInput).toBeVisible();
  }

  async fillDepartmentForm(name: string, description: string): Promise<void> {
    await this.nameInput.fill(name);
    await this.descriptionInput.fill(description);
  }

  async submitDepartmentForm(): Promise<void> {
    await this.submitButton.click();
  }

  getDepartmentRow(name: string): Locator {
    return this.departmentsTable.getByRole('row').filter({ hasText: name });
  }

  async expectDepartmentInList(name: string): Promise<void> {
    await expect(this.getDepartmentRow(name)).toBeVisible();
  }

  async expectDepartmentNotInList(name: string): Promise<void> {
    await expect(this.getDepartmentRow(name)).not.toBeVisible();
  }

  async expectDepartmentDescription(name: string, description: string): Promise<void> {
    await expect(this.getDepartmentRow(name)).toContainText(description);
  }

  async clickEditDepartment(name: string): Promise<void> {
    await this.getDepartmentRow(name).getByRole('button', { name: 'Edit' }).click();
    await expect(this.nameInput).toBeVisible();
  }

  async clickDeleteDepartment(name: string): Promise<void> {
    await this.getDepartmentRow(name).getByRole('button', { name: 'Delete' }).click();
  }

  async confirmDelete(): Promise<void> {
    await this.page.getByRole('button', { name: 'Confirm' }).click();
    await this.page.waitForLoadState('networkidle');
  }

  async expectDuplicateNameError(): Promise<void> {
    await expect(this.duplicateError).toBeVisible();
    await expect(this.duplicateError).toContainText('Department name already exists');
  }
}
`,
  fixturesUpdate: undefined,
};

// ─── Example 3: Appointments — Patient booking flow ─────────────────────────
// Demonstrates:
//   - asPatient fixture (pre-authenticated via storageState, NO beforeEach)
//   - Multi-step user flow across pages
//   - Selecting from dropdowns (selectOption)
//   - Waiting for async content (waitForLoadState, networkidle)
//   - Parameterized POM methods for dynamic data
//   - Combining multiple assertions per test
//   - @smoke tag for critical happy path
//   - POM constructed inline from persona page (not registered as fixture)

export const APPOINTMENTS_BOOKING_EXAMPLE = {
  label: 'Example 3 — Appointments: Patient booking flow',
  specPath: 'tests/web/appointments/55-booking-flow.spec.ts',
  spec: `import { test, expect } from '../../../fixtures';
import { AppointmentsPage } from '../../pages/appointments/AppointmentsPage';

test.describe('Appointments | Patient Booking', { tag: ['@appointments', '@smoke'] }, () => {
  test('patient books an appointment successfully', async ({ asPatient }) => {
    await asPatient.goto('/appointments');
    const appointments = new AppointmentsPage(asPatient);
    await appointments.clickBookAppointment();
    await appointments.selectDoctor('Dr. Smith');
    await appointments.selectDate('2025-06-15');
    await appointments.selectTimeSlot('09:00');
    await appointments.confirmBooking();
    await appointments.expectBookingConfirmation('Dr. Smith', '09:00');
  });

  test('patient sees their upcoming appointments', async ({ asPatient }) => {
    await asPatient.goto('/appointments');
    const appointments = new AppointmentsPage(asPatient);
    await appointments.expectUpcomingAppointmentsVisible();
  });

  test('patient cancels an appointment', async ({ asPatient }) => {
    await asPatient.goto('/appointments');
    const appointments = new AppointmentsPage(asPatient);
    await appointments.cancelAppointment('Dr. Smith', '09:00');
    await appointments.expectAppointmentStatus('Dr. Smith', 'Cancelled');
  });

  test('cannot book without selecting a time slot', async ({ asPatient }) => {
    await asPatient.goto('/appointments');
    const appointments = new AppointmentsPage(asPatient);
    await appointments.clickBookAppointment();
    await appointments.selectDoctor('Dr. Smith');
    await appointments.selectDate('2025-06-15');
    await appointments.confirmBooking();
    await appointments.expectTimeSlotRequiredError();
  });
});
`,
  pomPath: 'pages/appointments/AppointmentsPage.ts',
  pom: `import { Page, Locator, expect } from '@playwright/test';

export class AppointmentsPage {
  readonly page: Page;
  readonly appointmentsTable: Locator;
  readonly bookButton: Locator;
  readonly doctorSelect: Locator;
  readonly dateInput: Locator;
  readonly timeSlotSelect: Locator;
  readonly confirmButton: Locator;
  readonly confirmationMessage: Locator;
  readonly timeSlotError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.appointmentsTable = page.getByRole('table');
    this.bookButton = page.getByRole('button', { name: 'Book Appointment' });
    this.doctorSelect = page.getByLabel('Select doctor');
    this.dateInput = page.getByLabel('Select date');
    this.timeSlotSelect = page.getByLabel('Select time slot');
    this.confirmButton = page.getByRole('button', { name: 'Confirm Booking' });
    this.confirmationMessage = page.getByTestId('booking-confirmation');
    this.timeSlotError = page.getByTestId('time-slot-error');
  }

  async gotoAppointments(): Promise<void> {
    await this.page.goto('/appointments');
    await expect(this.appointmentsTable).toBeVisible();
  }

  async expectUpcomingAppointmentsVisible(): Promise<void> {
    await expect(this.appointmentsTable).toBeVisible();
  }

  async clickBookAppointment(): Promise<void> {
    await this.bookButton.click();
    await expect(this.doctorSelect).toBeVisible();
  }

  async selectDoctor(name: string): Promise<void> {
    await this.doctorSelect.selectOption({ label: name });
  }

  async selectDate(date: string): Promise<void> {
    await this.dateInput.fill(date);
    await this.page.waitForLoadState('networkidle');
  }

  async selectTimeSlot(time: string): Promise<void> {
    await this.timeSlotSelect.selectOption({ label: time });
  }

  async confirmBooking(): Promise<void> {
    await this.confirmButton.click();
    await this.page.waitForLoadState('networkidle');
  }

  async expectBookingConfirmation(doctorName: string, time: string): Promise<void> {
    await expect(this.confirmationMessage).toBeVisible();
    await expect(this.confirmationMessage).toContainText(doctorName);
    await expect(this.confirmationMessage).toContainText(time);
  }

  getAppointmentRow(doctorName: string, time: string): Locator {
    return this.appointmentsTable
      .getByRole('row')
      .filter({ hasText: doctorName })
      .filter({ hasText: time });
  }

  async expectAppointmentStatus(doctorName: string, status: string): Promise<void> {
    await expect(this.getAppointmentRow(doctorName, status)).toBeVisible();
  }

  async cancelAppointment(doctorName: string, time: string): Promise<void> {
    await this.getAppointmentRow(doctorName, time)
      .getByRole('button', { name: 'Cancel' })
      .click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
    await this.page.waitForLoadState('networkidle');
  }

  async expectTimeSlotRequiredError(): Promise<void> {
    await expect(this.timeSlotError).toBeVisible();
    await expect(this.timeSlotError).toContainText('Please select a time slot');
  }
}
`,
  fixturesUpdate: undefined,
};

// ─── Example 4: Access control — role-based routing ─────────────────────────
// Demonstrates:
//   - Testing forbidden access (wrong role tries to reach restricted page)
//   - URL-based assertions for redirect/403 outcomes
//   - Compact test structure for access-denied scenarios
//   - Multiple roles in one describe block
//   - asDoctor/asPatient/asAdmin fixtures for pre-authenticated access
//   - No POM needed — reusing existing AuthPage pattern for navigation only

export const ACCESS_CONTROL_EXAMPLE = {
  label: 'Example 4 — Access control: Role-based route restrictions',
  specPath: 'tests/web/departments/60-access-control.spec.ts',
  spec: `import { test, expect } from '../../../fixtures';

test.describe('Departments | Access Control', { tag: ['@departments', '@regression'] }, () => {
  test('doctor cannot access departments page', async ({ asDoctor }) => {
    await asDoctor.goto('/departments');
    await expect(asDoctor).toHaveURL(/login|dashboard|403/);
  });

  test('patient cannot access departments page', async ({ asPatient }) => {
    await asPatient.goto('/departments');
    await expect(asPatient).toHaveURL(/login|dashboard|403/);
  });

  test('admin can access departments page', async ({ asAdmin }) => {
    await asAdmin.goto('/departments');
    await expect(asAdmin).toHaveURL(/\\/departments/);
    await expect(asAdmin.getByRole('table')).toBeVisible();
  });
});
`,
  pomPath: 'pages/auth/AuthPage.ts',
  pom: `// No POM changes needed — this example uses persona fixtures directly.
// Demonstrates that not every spec requires a new POM.
// Reuse existing POMs when possible.
`,
  fixturesUpdate: undefined,
};

// ─── Formatter — converts all examples into a single prompt section ──────────

export function formatGoldenExamples(): string {
  const examples = [AUTH_LOGIN_EXAMPLE, DEPARTMENTS_ADMIN_EXAMPLE, APPOINTMENTS_BOOKING_EXAMPLE, ACCESS_CONTROL_EXAMPLE];

  return examples
    .map((ex) => {
      const parts: string[] = [];
      parts.push(`### ${ex.label}`);
      parts.push(`**Spec:** \`${ex.specPath}\``);
      parts.push('');
      parts.push('```typescript');
      parts.push(ex.spec);
      parts.push('```');
      parts.push('');
      parts.push(`**POM:** \`${ex.pomPath}\``);
      parts.push('');
      parts.push('```typescript');
      parts.push(ex.pom);
      parts.push('```');
      if (ex.fixturesUpdate) {
        parts.push('');
        parts.push('**fixtures/index.ts update:**');
        parts.push('');
        parts.push('```typescript');
        parts.push(ex.fixturesUpdate);
        parts.push('```');
      }
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}
