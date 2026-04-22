import { toBranchSlug, toReworkBranch, toPRTitle, toSpecFileName } from './naming';

// ─── toSpecFileName ───────────────────────────────────────────────────────────

describe('toSpecFileName', () => {
  it('slugifies the title with .spec.ts extension', () => {
    expect(toSpecFileName('Doctor Reviews Management')).toBe('doctor-reviews-management.spec.ts');
  });

  it('strips special characters from the title', () => {
    expect(toSpecFileName('Login & Password Reset!')).toBe('login-password-reset.spec.ts');
  });

  it('collapses multiple spaces and hyphens to a single hyphen', () => {
    expect(toSpecFileName('Patient  --  Admission')).toBe('patient-admission.spec.ts');
  });

  it('lowercases the title', () => {
    expect(toSpecFileName('AUTH LOGIN FLOW')).toBe('auth-login-flow.spec.ts');
  });

  it('truncates the slug to 40 characters', () => {
    const longTitle = 'This is a very long title that definitely exceeds the forty character limit';
    const result = toSpecFileName(longTitle);
    const slug = result.replace(/\.spec\.ts$/, '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('does not end with a hyphen after truncation', () => {
    const result = toSpecFileName('a'.repeat(45));
    expect(result).not.toMatch(/-\.spec\.ts$/);
  });

  it('handles a single-word title', () => {
    expect(toSpecFileName('Patients')).toBe('patients.spec.ts');
  });
});

// ─── toBranchSlug ─────────────────────────────────────────────────────────────

describe('toBranchSlug', () => {
  it('formats as qa/{id}-{slug}', () => {
    expect(toBranchSlug('42', 'Login Form Validation')).toBe('qa/42-login-form-validation');
  });

  it('strips special characters from summary', () => {
    expect(toBranchSlug('7', 'Fix: user can\'t sign in')).toBe('qa/7-fix-user-cant-sign-in');
  });
});

// ─── toReworkBranch ───────────────────────────────────────────────────────────

describe('toReworkBranch', () => {
  it('formats as qa/{parentId}-rework-{round}', () => {
    expect(toReworkBranch('42', 1)).toBe('qa/42-rework-1');
    expect(toReworkBranch('42', 2)).toBe('qa/42-rework-2');
  });
});

// ─── toPRTitle ────────────────────────────────────────────────────────────────

describe('toPRTitle', () => {
  it('formats as [KlikAgent] {id}: {summary}', () => {
    expect(toPRTitle('42', 'Login Validation')).toBe('[KlikAgent] 42: Login Validation');
  });
});
