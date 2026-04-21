import { toBranchSlug, toReworkBranch, toPRTitle, toSpecFileName } from './naming';

// ─── toSpecFileName ───────────────────────────────────────────────────────────

describe('toSpecFileName', () => {
  it('combines ticketId and slugified title with .spec.ts extension', () => {
    expect(toSpecFileName('21', 'Doctor Reviews Management')).toBe('21-doctor-reviews-management.spec.ts');
  });

  it('strips special characters from the title', () => {
    expect(toSpecFileName('42', 'Login & Password Reset!')).toBe('42-login-password-reset.spec.ts');
  });

  it('collapses multiple spaces and hyphens to a single hyphen', () => {
    expect(toSpecFileName('5', 'Patient  --  Admission')).toBe('5-patient-admission.spec.ts');
  });

  it('lowercases the title', () => {
    expect(toSpecFileName('1', 'AUTH LOGIN FLOW')).toBe('1-auth-login-flow.spec.ts');
  });

  it('truncates the slug portion to 40 characters', () => {
    const longTitle = 'This is a very long title that definitely exceeds the forty character limit';
    const result = toSpecFileName('1', longTitle);
    const slug = result.replace(/^1-/, '').replace(/\.spec\.ts$/, '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('does not end with a hyphen after truncation', () => {
    const result = toSpecFileName('99', 'a'.repeat(45));
    expect(result).not.toMatch(/-\.spec\.ts$/);
  });

  it('handles a single-word title', () => {
    expect(toSpecFileName('3', 'Patients')).toBe('3-patients.spec.ts');
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
