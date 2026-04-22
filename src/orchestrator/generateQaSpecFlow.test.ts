import { generateQaSpecFlow } from './generateQaSpecFlow';
import { QATask } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/issues');
jest.mock('../services/selfCorrection');
jest.mock('../services/github');
jest.mock('../utils/naming');
jest.mock('../agents/tools/outputTools');
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

import * as issues from '../services/issues';
import * as selfCorrection from '../services/selfCorrection';
import * as github from '../services/github';
import * as naming from '../utils/naming';
import * as outputTools from '../agents/tools/outputTools';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<QATask> = {}): QATask {
  return {
    taskId: '42',
    title: 'Login form validation',
    description: 'As a user I want to login',
    qaEnvUrl: 'https://qa.example.com',
    outputRepo: 'klikagent-tests',
    metadata: { issueUrl: 'https://github.com/org/repo/issues/42' },
    ...overrides,
  };
}

function setupDefaultMocks(): void {
  (github.getDefaultBranchSha as jest.Mock).mockResolvedValue('sha-base-123');
  (github.createBranch as jest.Mock).mockResolvedValue(undefined);
  (naming.toBranchSlug as jest.Mock).mockReturnValue('qa/42-login-form-validation');
  (naming.toSpecFileName as jest.Mock).mockReturnValue('42-login-form-validation.spec.ts');

  (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
    specContent: 'test("login", async () => {});',
    poms: [{ pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' }],
    affectedPaths: 'tests/web/auth/',
    tokenUsage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    warned: false,
  });

  (outputTools.pomPathFromContent as jest.Mock).mockReturnValue('pages/auth/AuthPage.ts');

  (github.commitFile as jest.Mock).mockResolvedValue(undefined);
  (github.openPR as jest.Mock).mockResolvedValue('https://github.com/org/klikagent-tests/pull/5');

  (issues.transitionToInQA as jest.Mock).mockResolvedValue(undefined);
  (issues.commentOnIssue as jest.Mock).mockResolvedValue(undefined);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultMocks();
});

describe('generateQaSpecFlow — happy path', () => {
  it('calls all services in the correct order and opens a PR', async () => {
    const ctx = makeContext();
    await generateQaSpecFlow(ctx);

    // Step 1: QA branch created using task.outputRepo
    expect(github.getDefaultBranchSha).toHaveBeenCalledWith('klikagent-tests');
    expect(github.createBranch).toHaveBeenCalledWith(
      'klikagent-tests', 'qa/42-login-form-validation', 'sha-base-123',
    );

    // Step 8: Self-correction ran
    expect(selfCorrection.runWithSelfCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
      'general',
      'qa/42-login-form-validation',
      [],
      [],
      '',
      expect.stringContaining('42-login-form-validation.spec.ts'),
    );

    // Step 10: Two commits made
    expect(github.commitFile).toHaveBeenCalledTimes(2);

    // Step 11: PR opened
    expect(github.openPR).toHaveBeenCalledWith(
      'klikagent-tests',
      'qa/42-login-form-validation',
      expect.stringContaining('42'),
      expect.any(String),
    );

    // Step 12: Issue transitioned
    expect(issues.transitionToInQA).toHaveBeenCalledWith(42);

    // Step 13: Issue commented — should contain PR URL
    expect(issues.commentOnIssue).toHaveBeenCalledWith(
      42,
      expect.stringContaining('https://github.com/org/klikagent-tests/pull/5'),
    );
  });

  it('includes token usage in the issue comment', async () => {
    await generateQaSpecFlow(makeContext());

    const commentBody = (issues.commentOnIssue as jest.Mock).mock.calls[0][1] as string;
    expect(commentBody).toContain('1,000');
    expect(commentBody).toContain('500');
    expect(commentBody).toContain('1,500');
  });
});

describe('generateQaSpecFlow — warned path', () => {
  it('includes warning message in issue comment when result.warned is true', async () => {
    const warningMessage = 'All 3 self-correction attempts exhausted. Playwright test still failing.';
    (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
      specContent: 'test("login", async () => {});',
      poms: [{ pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' }],
      affectedPaths: 'tests/web/auth/',
      tokenUsage: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      warned: true,
      warningMessage,
    });

    await generateQaSpecFlow(makeContext());

    const commentBody = (issues.commentOnIssue as jest.Mock).mock.calls[0][1] as string;
    expect(commentBody).toContain('Warning');
    expect(commentBody).toContain(warningMessage);
  });

  it('still opens PR and transitions issue even when warned', async () => {
    (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
      specContent: 'test("login", async () => {});',
      poms: [{ pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' }],
      affectedPaths: 'tests/web/auth/',
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      warned: true,
      warningMessage: 'Playwright tests failed after 3 attempts.',
    });

    await generateQaSpecFlow(makeContext());

    expect(github.openPR).toHaveBeenCalled();
    expect(issues.transitionToInQA).toHaveBeenCalled();
    expect(issues.commentOnIssue).toHaveBeenCalled();
  });
});

describe('generateQaSpecFlow — POM handling', () => {
  it('commits all POMs from the poms array', async () => {
    (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
      specContent: 'test("login", async () => {});',
      poms: [
        { pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' },
        { pomContent: 'export class LoginForm {}', pomPath: 'pages/auth/LoginForm.ts' },
      ],
      affectedPaths: 'tests/web/auth/',
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      warned: false,
    });

    await generateQaSpecFlow(makeContext());

    // Should have 3 commitFile calls: spec, pom1, pom2
    expect((github.commitFile as jest.Mock).mock.calls.length).toBe(3);
    expect((github.commitFile as jest.Mock).mock.calls[1][2]).toBe('pages/auth/AuthPage.ts');
    expect((github.commitFile as jest.Mock).mock.calls[2][2]).toBe('pages/auth/LoginForm.ts');
  });
});
