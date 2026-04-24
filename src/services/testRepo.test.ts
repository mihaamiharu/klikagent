import { getKeywordMap } from './testRepo';
import * as github from './github';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('./github', () => ({
  getFileOnBranch: jest.fn(),
  ghRequest:       jest.fn(),
  commitFile:      jest.fn(),
  ownerName:       jest.fn().mockReturnValue('owner'),
}));
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

const mockGetFile = github.getFileOnBranch as jest.MockedFunction<typeof github.getFileOnBranch>;

const REPO = 'test-repo';
const ROUTES_TS = `export default {\n  auth: '/login',\n  doctors: '/doctors',\n  patients: '/patients'\n};`;

// ─── getKeywordMap ────────────────────────────────────────────────────────────

describe('getKeywordMap', () => {
  afterEach(() => jest.resetAllMocks());

  it('parses and returns config/keywords.json when it exists', async () => {
    const keywords = { auth: ['login', 'sign in'], doctors: ['doctor', 'physician'] };
    mockGetFile.mockImplementation(async (_repo, _ref, path) =>
      path === 'config/keywords.json' ? JSON.stringify(keywords) : null,
    );

    const result = await getKeywordMap(REPO);

    expect(result).toEqual(keywords);
  });

  it('falls back to route map keys as single-word keywords when keywords.json is missing', async () => {
    mockGetFile.mockImplementation(async (_repo, _ref, path) => {
      if (path === 'config/keywords.json') return null;
      if (path === 'config/routes.ts') return ROUTES_TS;
      return null;
    });

    const result = await getKeywordMap(REPO);

    expect(result).toEqual({ auth: ['auth'], doctors: ['doctors'], patients: ['patients'] });
  });

  it('falls back to route map keys when keywords.json contains invalid JSON', async () => {
    mockGetFile.mockImplementation(async (_repo, _ref, path) => {
      if (path === 'config/keywords.json') return '{ not valid json }';
      if (path === 'config/routes.ts') return ROUTES_TS;
      return null;
    });

    const result = await getKeywordMap(REPO);

    expect(result).toEqual({ auth: ['auth'], doctors: ['doctors'], patients: ['patients'] });
  });

  it('returns empty object when both keywords.json and routes.ts are missing', async () => {
    mockGetFile.mockResolvedValue(null);

    const result = await getKeywordMap(REPO);

    expect(result).toEqual({});
  });

  it('logs a warning when keywords.json has invalid JSON', async () => {
    const { log } = jest.requireMock('../utils/logger') as { log: jest.Mock };
    mockGetFile.mockImplementation(async (_repo, _ref, path) => {
      if (path === 'config/keywords.json') return '{ bad json }';
      if (path === 'config/routes.ts') return ROUTES_TS;
      return null;
    });

    await getKeywordMap(REPO);

    expect(log).toHaveBeenCalledWith('WARN', expect.stringContaining('keywords.json'));
  });
});
