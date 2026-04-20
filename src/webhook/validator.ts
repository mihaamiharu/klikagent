import { Request } from 'express';
import * as crypto from 'crypto';
import { log } from '../utils/logger';

export function validatePayload(req: Request, source: 'github'): boolean {
  const rawBody: Buffer = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody)) {
    log('ERROR', `validatePayload: req.body is not a Buffer (got ${typeof rawBody}) — check raw body middleware`);
    return false;
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
    } catch (err) {
      log('ERROR', `GitHub HMAC comparison failed: ${(err as Error).message} — computed="${computed}" provided="${provided}"`);
      return false;
    }
  }

  return false;
}
