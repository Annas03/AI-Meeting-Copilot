import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookInput, WebhookVerdict } from '../provider.js';

/** Recall delivers webhooks through Svix: `svix-id`, `svix-timestamp`, `svix-signature` headers signed with a `whsec_` secret. */
const DEFAULT_TOLERANCE_SEC = 5 * 60;

function secretBytes(secret: string): Buffer {
  return secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.from(secret, 'utf8');
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Computes the Svix v1 signature for a delivery; exported so tests and the smoke script can sign payloads. */
export function signSvix(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verifySvixSignature(input: {
  secret: string;
  id?: string;
  timestamp?: string;
  signature?: string;
  body: string;
  nowMs?: number;
  toleranceSec?: number;
}): WebhookVerdict {
  const { secret, id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing svix headers' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid svix timestamp' };
  const nowSec = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSec - ts) > (input.toleranceSec ?? DEFAULT_TOLERANCE_SEC)) return { ok: false, reason: 'stale svix timestamp' };
  const expected = signSvix(secret, id, timestamp, body);
  // The header may carry several space-separated "v1,<base64>" entries during secret rotation.
  for (const entry of signature.split(' ')) {
    const [version, sig] = entry.split(',');
    if (version === 'v1' && sig && equal(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

/** Token placed in the real-time endpoint URL (Recall's query-parameter auth option), derived from the same secret. */
export function realtimeEndpointToken(secret: string): string {
  return createHmac('sha256', secretBytes(secret)).update('recall-realtime-endpoint').digest('hex').slice(0, 32);
}

/**
 * Accepts a delivery when it is Svix-signed, or when it carries the endpoint token. Without a configured
 * secret everything is accepted; the server warns about that at boot.
 */
export function verifyRecallWebhook(input: WebhookInput & { secret?: string }): WebhookVerdict {
  if (!input.secret) return { ok: true };
  const { id, timestamp, signature } = input.headers;
  if (id || timestamp || signature) return verifySvixSignature({ secret: input.secret, id, timestamp, signature, body: input.body });
  if (input.token) return equal(input.token, realtimeEndpointToken(input.secret)) ? { ok: true } : { ok: false, reason: 'invalid endpoint token' };
  return { ok: false, reason: 'unsigned webhook' };
}
