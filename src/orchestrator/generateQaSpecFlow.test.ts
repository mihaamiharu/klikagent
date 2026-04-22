import { generateQaSpecFlow } from './generateQaSpecFlow';
import { QATask } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/selfCorrection');
jest.mock('../services/github');
jest.mock('../utils/naming');
jest.mock('../agents/tools/outputTools');
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

import * as selfCorrection from '../services/selfCorrection';
import * as github from '../services/github';
import * as naming from '../utils/naming';
import * as outputTools from '../agents/tools/outputTools';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PR_URL = 'https://github.com/org/klikagent-tests/pull/5';
const CALLBACK_URL = 'http://trigger.local/callback/tasks/42/results';

function makeTask(overrides: Partial<QATask> = {}): QATask {
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
  (naming.toSpecFileName as jest.Mock).mockReturnValue('login-form-validation.spec.ts');

  (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
    specContent: 'test("login", async () => {});',
    poms: [{ pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' }],
    affectedPaths: 'tests/web/auth/',
    tokenUsage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    warned: false,
  });

  (outputTools.pomPathFromContent as jest.Mock).mockReturnValue('pages/auth/AuthPage.ts');
  (github.commitFile as jest.Mock).mockResolvedValue(undefined);
  (github.openPR as jest.Mock).mockResolvedValue(PR_URL);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultMocks();
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ received: true }), { status: 200 }),
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('generateQaSpecFlow — happy path', () => {
  it('calls all services in the correct order and opens a PR', async () => {
    await generateQaSpecFlow(makeTask());

    expect(github.getDefaultBranchSha).toHaveBeenCalledWith('klikagent-tests');
    expect(github.createBranch).toHaveBeenCalledWith(
      'klikagent-tests', 'qa/42-login-form-validation', 'sha-base-123',
    );
    expect(selfCorrection.runWithSelfCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: '42' }),
      'qa/42-login-form-validation',
      expect.stringContaining('login-form-validation.spec.ts'),
    );
    expect(github.commitFile).toHaveBeenCalledTimes(2);
    expect(github.openPR).toHaveBeenCalledWith(
      'klikagent-tests',
      'qa/42-login-form-validation',
      expect.stringContaining('42'),
      expect.any(String),
    );
  });

  it('routes spec to tests/web/general when feature is not set', async () => {
    await generateQaSpecFlow(makeTask());
    const specPath = (selfCorrection.runWithSelfCorrection as jest.Mock).mock.calls[0][2] as string;
    expect(specPath).toContain('tests/web/general/');
  });

  it('routes spec to tests/web/{feature} when feature is set', async () => {
    await generateQaSpecFlow(makeTask({ feature: 'auth' }));
    const specPath = (selfCorrection.runWithSelfCorrection as jest.Mock).mock.calls[0][2] as string;
    expect(specPath).toContain('tests/web/auth/');
  });

  it('does not call fetch when callbackUrl is not set', async () => {
    await generateQaSpecFlow(makeTask());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs TaskResult to callbackUrl when set', async () => {
    await generateQaSpecFlow(makeTask({ callbackUrl: CALLBACK_URL }));

    expect(fetchSpy).toHaveBeenCalledWith(
      CALLBACK_URL,
      expect.objectContaining({ method: 'POST' }),
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.taskId).toBe('42');
    expect(body.passed).toBe(true);
    expect(body.reportUrl).toBe(PR_URL);
  });
});

describe('generateQaSpecFlow — warned path', () => {
  beforeEach(() => {
    (selfCorrection.runWithSelfCorrection as jest.Mock).mockResolvedValue({
      specContent: 'test("login", async () => {});',
      poms: [{ pomContent: 'export class AuthPage {}', pomPath: 'pages/auth/AuthPage.ts' }],
      affectedPaths: 'tests/web/auth/',
      tokenUsage: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      warned: true,
      warningMessage: 'All 3 self-correction attempts exhausted.',
    });
  });

  it('POSTs passed=false and warning in summary when warned', async () => {
    await generateQaSpecFlow(makeTask({ callbackUrl: CALLBACK_URL }));

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.passed).toBe(false);
    expect(body.summary).toContain('warnings');
    expect(body.metadata.warned).toBe(true);
    expect(body.metadata.warningMessage).toBe('All 3 self-correction attempts exhausted.');
  });

  it('still opens PR even when warned', async () => {
    await generateQaSpecFlow(makeTask({ callbackUrl: CALLBACK_URL }));
    expect(github.openPR).toHaveBeenCalled();
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

    await generateQaSpecFlow(makeTask());

    // spec + pom1 + pom2 = 3 commits
    expect((github.commitFile as jest.Mock).mock.calls.length).toBe(3);
    expect((github.commitFile as jest.Mock).mock.calls[1][2]).toBe('pages/auth/AuthPage.ts');
    expect((github.commitFile as jest.Mock).mock.calls[2][2]).toBe('pages/auth/LoginForm.ts');
  });
});

describe('generateQaSpecFlow — callback resilience', () => {
  it('does not throw if callback fetch fails', async () => {
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    await expect(generateQaSpecFlow(makeTask({ callbackUrl: CALLBACK_URL }))).resolves.not.toThrow();
  });

  it('does not throw if callback returns non-200', async () => {
    fetchSpy.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    await expect(generateQaSpecFlow(makeTask({ callbackUrl: CALLBACK_URL }))).resolves.not.toThrow();
  });
});
