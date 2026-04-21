import { generateQaSpecFlow } from './generateQaSpecFlow';
import { TriggerContext } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/issues');
jest.mock('../services/testRepo');
jest.mock('../utils/featureDetector');
jest.mock('../utils/diffAnalyzer');
jest.mock('../utils/pagesResolver');
jest.mock('../services/personas');
jest.mock('../services/selfCorrection');
jest.mock('../services/github');
jest.mock('../utils/naming');
jest.mock('../agents/tools/outputTools');
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

import * as issues from '../services/issues';
import * as testRepo from '../services/testRepo';
import * as featureDetector from '../utils/featureDetector';
import * as diffAnalyzer from '../utils/diffAnalyzer';
import * as pagesResolver from '../utils/pagesResolver';
import * as personas from '../services/personas';
import * as selfCorrection from '../services/selfCorrection';
import * as github from '../services/github';
import * as naming from '../utils/naming';
import * as outputTools from '../agents/tools/outputTools';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    flow: 2,
    ticketId: '42',
    ticketSummary: 'Login form validation',
    ticketUrl: 'https://github.com/org/repo/issues/42',
    status: 'status:ready-for-qa',
    previousStatus: '',
    labels: ['scope:web', 'feature:auth'],
    scope: 'web',
    isRework: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function setupDefaultMocks(): void {
  (issues.getIssue as jest.Mock).mockResolvedValue({
    number: 42,
    title: 'Login form validation',
    body: 'As a user I want to login',
    url: 'https://github.com/org/repo/issues/42',
    labels: ['scope:web', 'feature:auth'],
  });

  (testRepo.getKeywordMap as jest.Mock).mockResolvedValue({ auth: ['login', 'password'] });
  (featureDetector.detectFeature as jest.Mock).mockReturnValue('auth');
  (personas.parsePersonasFromIssue as jest.Mock).mockReturnValue(['patient', 'doctor']);
  (pagesResolver.resolveStartingUrls as jest.Mock).mockResolvedValue(['/login', '/auth']);

  (github.findPRByTicketId as jest.Mock).mockResolvedValue({
    number: 10, branch: 'feat/42-login', headSha: 'abc123', url: 'https://pr.url', isDraft: false,
  });
  (diffAnalyzer.fetchPRDiff as jest.Mock).mockResolvedValue('--- a/login.ts\n+++ b/login.ts\n@@ -1,1 +1,2 @@');

  (github.getDefaultBranchSha as jest.Mock).mockResolvedValue('sha-base-123');
  (github.createBranch as jest.Mock).mockResolvedValue(undefined);
  (naming.toBranchSlug as jest.Mock).mockReturnValue('qa/42-login-form-validation');
  (naming.toSpecFileName as jest.Mock).mockReturnValue('42-login-form-validation.spec.ts');

  (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
    specContent: 'test("login", async () => {});',
    pomContent: 'export class AuthPage {}',
    pomPath: 'pages/auth/AuthPage.ts',
    affectedPaths: 'tests/web/auth/',
    tokenUsage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    warned: false,
  });

  (outputTools.pomPathFromContent as jest.Mock).mockReturnValue('pages/auth/AuthPage.ts');

  (github.testRepoName as jest.Mock).mockReturnValue('klikagent-tests');
  (github.ownerName as jest.Mock).mockReturnValue('mihaamiharu');
  (github.mainRepo as jest.Mock).mockReturnValue('caresync');
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

    // Step 1: Issue fetched
    expect(issues.getIssue).toHaveBeenCalledWith(42);

    // Step 2: Feature detected
    expect(featureDetector.detectFeature).toHaveBeenCalled();

    // Step 3: Personas parsed
    expect(personas.parsePersonasFromIssue).toHaveBeenCalled();

    // Step 4: URLs resolved
    expect(pagesResolver.resolveStartingUrls).toHaveBeenCalledWith('auth', expect.any(String));

    // Step 5: PR diff fetched
    expect(github.findPRByTicketId).toHaveBeenCalledWith('42', 'caresync');
    expect(diffAnalyzer.fetchPRDiff).toHaveBeenCalled();

    // Step 6: QA branch created
    expect(github.getDefaultBranchSha).toHaveBeenCalledWith('klikagent-tests');
    expect(github.createBranch).toHaveBeenCalledWith(
      'klikagent-tests', 'qa/42-login-form-validation', 'sha-base-123',
    );

    // Step 8: Self-correction ran
    expect(selfCorrection.runWithSelfCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
      'auth',
      'qa/42-login-form-validation',
      ['patient', 'doctor'],
      ['/login', '/auth'],
      expect.any(String),
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

  it('includes the number of starting URLs in the issue comment', async () => {
    await generateQaSpecFlow(makeContext());

    const commentBody = (issues.commentOnIssue as jest.Mock).mock.calls[0][1] as string;
    expect(commentBody).toContain('URLs crawled: 2');
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
      pomContent: 'export class AuthPage {}',
      pomPath: 'pages/auth/AuthPage.ts',
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
      pomContent: 'export class AuthPage {}',
      pomPath: 'pages/auth/AuthPage.ts',
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

describe('generateQaSpecFlow — no URLs / env fallback', () => {
  it('passes empty array to runWithSelfCorrection when resolveStartingUrls fails', async () => {
    (pagesResolver.resolveStartingUrls as jest.Mock).mockRejectedValue(
      new Error('GITHUB_TOKEN not set'),
    );

    await generateQaSpecFlow(makeContext());

    expect(selfCorrection.runWithSelfCorrection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      [],     // empty array fallback
      expect.anything(),
      expect.anything(),
    );
  });

  it('comment mentions 0 URLs crawled when resolveStartingUrls returns empty', async () => {
    (pagesResolver.resolveStartingUrls as jest.Mock).mockResolvedValue([]);

    await generateQaSpecFlow(makeContext());

    const commentBody = (issues.commentOnIssue as jest.Mock).mock.calls[0][1] as string;
    expect(commentBody).toContain('URLs crawled: 0');
  });

  it('proceeds without PR diff when findPRByTicketId returns null', async () => {
    (github.findPRByTicketId as jest.Mock).mockResolvedValue(null);

    await generateQaSpecFlow(makeContext());

    expect(diffAnalyzer.fetchPRDiff).not.toHaveBeenCalled();
    expect(selfCorrection.runWithSelfCorrection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      '',   // empty prDiff
      expect.anything(),
    );
  });
});

describe('generateQaSpecFlow — pomPath sanity check', () => {
  it('uses derived pomPath when agent pomPath mismatches class name', async () => {
    (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
      specContent: 'test("login", async () => {});',
      pomContent: 'export class LoginPage {}',
      pomPath: 'pages/auth/WrongPage.ts',    // agent returned wrong path
      affectedPaths: 'tests/web/auth/',
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      warned: false,
    });
    (outputTools.pomPathFromContent as jest.Mock).mockReturnValue('pages/auth/LoginPage.ts');

    await generateQaSpecFlow(makeContext());

    // The second commitFile call should use the derived path
    const pomCommitCall = (github.commitFile as jest.Mock).mock.calls[1];
    expect(pomCommitCall[2]).toBe('pages/auth/LoginPage.ts');
  });
});
