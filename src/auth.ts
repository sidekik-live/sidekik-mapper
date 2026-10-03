import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Service-to-service calls (`X-Internal-Token`). Every /internal route uses it. */
    requireInternal: onRequestAsyncHookHandler;
  }
}

/** Builds an onRequest hook that checks a header against a shared secret in constant time. */
export function requireSharedSecret(header: string, expected: string): onRequestAsyncHookHandler {
  const expectedDigest = digest(expected);
  return async (request: FastifyRequest) => {
    const value = request.headers[header];
    if (typeof value !== 'string' || !timingSafeEqual(digest(value), expectedDigest)) {
      throw unauthorized(`Missing or invalid ${header}`);
    }
  };
}

// Hashing first makes the comparison constant-time regardless of input length.
const digest = (s: string) => createHash('sha256').update(s).digest();
