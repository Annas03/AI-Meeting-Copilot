import { describe, expect, it } from 'vitest';
import { realtimeEndpointToken, signSvix, verifyRecallWebhook, verifySvixSignature } from './webhook.js';

const secret = `whsec_${Buffer.from('test-secret').toString('base64')}`;
const body = JSON.stringify({ event: 'bot.done', data: {} });
const nowMs = 1_760_000_000_000;
const timestamp = String(Math.floor(nowMs / 1000));

describe('verifySvixSignature', () => {
  it('accepts a correctly signed delivery', () => {
    const signature = `v1,${signSvix(secret, 'msg_1', timestamp, body)}`;
    expect(verifySvixSignature({ secret, id: 'msg_1', timestamp, signature, body, nowMs })).toEqual({ ok: true });
  });

  it('accepts when one of several signatures matches', () => {
    const signature = `v1,AAAA v1,${signSvix(secret, 'msg_1', timestamp, body)}`;
    expect(verifySvixSignature({ secret, id: 'msg_1', timestamp, signature, body, nowMs }).ok).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a stale timestamp', () => {
    const signature = `v1,${signSvix(secret, 'msg_1', timestamp, body)}`;
    expect(verifySvixSignature({ secret, id: 'msg_1', timestamp, signature, body: body + ' ', nowMs }).ok).toBe(false);
    expect(verifySvixSignature({ secret: 'whsec_b3RoZXI=', id: 'msg_1', timestamp, signature, body, nowMs }).ok).toBe(false);
    expect(verifySvixSignature({ secret, id: 'msg_1', timestamp, signature, body, nowMs: nowMs + 10 * 60_000 })).toEqual({ ok: false, reason: 'stale svix timestamp' });
    expect(verifySvixSignature({ secret, body, nowMs })).toEqual({ ok: false, reason: 'missing svix headers' });
  });
});

describe('verifyRecallWebhook', () => {
  it('accepts everything when no secret is configured', () => {
    expect(verifyRecallWebhook({ body, headers: {} })).toEqual({ ok: true });
  });

  it('falls back to the endpoint token when the delivery is unsigned', () => {
    expect(verifyRecallWebhook({ secret, body, headers: {}, token: realtimeEndpointToken(secret) })).toEqual({ ok: true });
    expect(verifyRecallWebhook({ secret, body, headers: {}, token: 'nope' }).ok).toBe(false);
    expect(verifyRecallWebhook({ secret, body, headers: {} })).toEqual({ ok: false, reason: 'unsigned webhook' });
  });

  it('prefers the signature when headers are present, even with a valid token', () => {
    const headers = { id: 'msg_1', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'v1,bad' };
    expect(verifyRecallWebhook({ secret, body, headers, token: realtimeEndpointToken(secret) }).ok).toBe(false);
  });
});
