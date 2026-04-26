import { provisionRepo } from './repoProvisioner';
import { ProvisionRequest } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('./github', () => ({
  createRepo:           jest.fn(),
  getDefaultBranchSha:  jest.fn(),
  commitFile:           jest.fn(),
}));
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

import * as github from './github';

const mockCreateRepo          = github.createRepo as jest.MockedFunction<typeof github.createRepo>;
const mockGetDefaultBranchSha = github.getDefaultBranchSha as jest.MockedFunction<typeof github.getDefaultBranchSha>;
const mockCommitFile          = github.commitFile as jest.MockedFunction<typeof github.commitFile>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    repoName: 'myteam-tests',
    owner: 'acme-corp',
    qaEnvUrl: 'https://qa.acme.com',
    features: ['auth', 'billing'],
    domainContext: 'A SaaS platform for managing invoices.',
    ...overrides,
  };
}

async function runProvision(req: ProvisionRequest = makeRequest()) {
  jest.useFakeTimers();
  const promise = provisionRepo(req);
  await jest.runAllTimersAsync();
  const result = await promise;
  jest.useRealTimers();
  return result;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockCreateRepo.mockResolvedValue({
    htmlUrl: 'https://github.com/acme-corp/myteam-tests',
    cloneUrl: 'https://github.com/acme-corp/myteam-tests.git',
    defaultBranch: 'main',
  });
  mockGetDefaultBranchSha.mockResolvedValue('sha-abc123');
  mockCommitFile.mockResolvedValue(undefined);
});

describe('provisionRepo', () => {
  it('creates the repo with the correct owner and name', async () => {
    await runProvision();
    expect(mockCreateRepo).toHaveBeenCalledWith('acme-corp', 'myteam-tests');
  });

  it('returns the correct ProvisionResult', async () => {
    const result = await runProvision();
    expect(result.repoUrl).toBe('https://github.com/acme-corp/myteam-tests');
    expect(result.cloneUrl).toBe('https://github.com/acme-corp/myteam-tests.git');
    expect(result.defaultBranch).toBe('main');
  });

  it('commits all 12 convention seed files', async () => {
    await runProvision();

    const committedPaths = mockCommitFile.mock.calls.map((call) => call[2]);
    expect(committedPaths).toContain('config/routes.ts');
    expect(committedPaths).toContain('config/keywords.json');
    expect(committedPaths).toContain('config/personas.json');
    expect(committedPaths).toContain('context/domain.md');
    expect(committedPaths).toContain('context/personas.md');
    expect(committedPaths).toContain('context/test-patterns.md');
    expect(committedPaths).toContain('fixtures/index.ts');
    expect(committedPaths).toContain('pages/.gitkeep');
    expect(committedPaths).toContain('tests/web/.gitkeep');
    expect(committedPaths).toContain('utils/helpers.ts');
    expect(committedPaths).toContain('tsconfig.json');
    expect(committedPaths).toContain('playwright.config.ts');
    expect(mockCommitFile).toHaveBeenCalledTimes(12);
  });

  it('seeds routes.ts with the provided features', async () => {
    await runProvision(makeRequest({ features: ['auth', 'billing'] }));

    const routesCall = mockCommitFile.mock.calls.find((c) => c[2] === 'config/routes.ts');
    expect(routesCall).toBeDefined();
    const content = routesCall![3] as string;
    expect(content).toContain('auth');
    expect(content).toContain('billing');
  });

  it('seeds keywords.json with each feature mapped to itself', async () => {
    await runProvision(makeRequest({ features: ['auth', 'billing'] }));

    const keywordsCall = mockCommitFile.mock.calls.find((c) => c[2] === 'config/keywords.json');
    const parsed = JSON.parse(keywordsCall![3] as string);
    expect(parsed).toEqual({ auth: ['auth'], billing: ['billing'] });
  });

  it('seeds domain.md with the provided domainContext', async () => {
    await runProvision(makeRequest({ domainContext: 'A SaaS platform for managing invoices.' }));

    const domainCall = mockCommitFile.mock.calls.find((c) => c[2] === 'context/domain.md');
    expect(domainCall![3]).toContain('A SaaS platform for managing invoices.');
  });

  it('seeds playwright.config.ts with the qaEnvUrl as baseURL', async () => {
    await runProvision(makeRequest({ qaEnvUrl: 'https://qa.acme.com' }));

    const configCall = mockCommitFile.mock.calls.find((c) => c[2] === 'playwright.config.ts');
    expect(configCall![3]).toContain('https://qa.acme.com');
  });

  it('commits all files to the default branch of the new repo', async () => {
    await runProvision();

    for (const call of mockCommitFile.mock.calls) {
      expect(call[0]).toBe('myteam-tests');  // repoName
      expect(call[1]).toBe('main');           // defaultBranch
    }
  });
});
