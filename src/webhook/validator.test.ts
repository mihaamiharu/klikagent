import * as crypto from 'crypto';
import { Request } from 'express';
import { validatePayload } from './validator';

function makeRawBody(body: object): Buffer {
  return Buffer.from(JSON.stringify(body));
}

function signBody(body: Buffer, secret: string, algorithm: 'sha256' = 'sha256'): string {
  return crypto.createHmac(algorithm, secret).update(body).digest('hex');
}

function makeReq(rawBody: Buffer, headers: Record<string, string>): Request {
  return {
    body: rawBody,
    headers,
  } as unknown as Request;
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

describe('validatePayload — jira', () => {
  const secret = 'test-jira-secret';
  const body = makeRawBody({ webhookEvent: 'jira:issue_updated' });

  beforeEach(() => {
    process.env.JIRA_WEBHOOK_SECRET = secret;
  });

  afterEach(() => {
    delete process.env.JIRA_WEBHOOK_SECRET;
  });

  it('returns true when signature is valid (bare hex)', () => {
    const sig = signBody(body, secret);
    const req = makeReq(body, { 'x-hub-signature': sig });
    expect(validatePayload(req, 'jira')).toBe(true);
  });

  it('returns true when signature is valid (sha256= prefixed)', () => {
    const sig = `sha256=${signBody(body, secret)}`;
    const req = makeReq(body, { 'x-hub-signature': sig });
    expect(validatePayload(req, 'jira')).toBe(true);
  });

  it('returns false when signature does not match', () => {
    const req = makeReq(body, { 'x-hub-signature': 'deadbeef' });
    expect(validatePayload(req, 'jira')).toBe(false);
  });

  it('returns false when x-hub-signature header is missing', () => {
    const req = makeReq(body, {});
    expect(validatePayload(req, 'jira')).toBe(false);
  });

  it('returns true (dev mode) when JIRA_WEBHOOK_SECRET is not set', () => {
    delete process.env.JIRA_WEBHOOK_SECRET;
    const req = makeReq(body, {});
    expect(validatePayload(req, 'jira')).toBe(true);
  });
});

// ─── GitHub ───────────────────────────────────────────────────────────────────

describe('validatePayload — github', () => {
  const secret = 'test-github-secret';
  const body = makeRawBody({ action: 'completed' });

  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it('returns true when signature is valid', () => {
    const sig = `sha256=${signBody(body, secret)}`;
    const req = makeReq(body, { 'x-hub-signature-256': sig });
    expect(validatePayload(req, 'github')).toBe(true);
  });

  it('returns false when signature does not match', () => {
    const req = makeReq(body, { 'x-hub-signature-256': 'sha256=deadbeef' });
    expect(validatePayload(req, 'github')).toBe(false);
  });

  it('returns false when x-hub-signature-256 header is missing', () => {
    const req = makeReq(body, {});
    expect(validatePayload(req, 'github')).toBe(false);
  });

  it('returns true (dev mode) when GITHUB_WEBHOOK_SECRET is not set', () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const req = makeReq(body, {});
    expect(validatePayload(req, 'github')).toBe(true);
  });
});
