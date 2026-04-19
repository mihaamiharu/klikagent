import { Request } from 'express';
import * as crypto from 'crypto';
import { log } from '../utils/logger';

export function validatePayload(req: Request, source: 'jira' | 'github'): boolean {
  const rawBody: Buffer = req.body as Buffer;

  if (source === 'jira') {
    const secret = process.env.JIRA_WEBHOOK_SECRET;

    if (!secret) {
      log('WARN', 'JIRA_WEBHOOK_SECRET not set — skipping validation (dev mode)');
      return true;
    }

    const signatureHeader = req.headers['x-hub-signature'] as string | undefined;
    if (!signatureHeader) {
      log('WARN', 'Missing x-hub-signature header on Jira webhook');
      return false;
    }

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const computed = hmac.digest('hex');

    // Header may be prefixed with "sha256="
    const provided = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice(7)
      : signatureHeader;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(provided, 'hex')
      );
    } catch {
      return false;
    }
  }

  if (source === 'github') {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret) {
      log('WARN', 'GITHUB_WEBHOOK_SECRET not set — skipping validation (dev mode)');
      return true;
    }

    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signatureHeader) {
      log('WARN', 'Missing x-hub-signature-256 header on GitHub webhook');
      return false;
    }

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const computed = `sha256=${hmac.digest('hex')}`;

    // Strip sha256= prefix from provided header before comparing
    const provided = signatureHeader;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(computed),
        Buffer.from(provided)
      );
    } catch {
      return false;
    }
  }

  return false;
}
