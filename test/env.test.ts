import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { RAW_ENV } from './helpers.js';

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(RAW_ENV);
    expect(env.PORT).toBe(8083);
    expect(env.BRAIN_URL).toBe('http://localhost:8082');
  });

  it('defaults PORT, LOG_LEVEL and the Claude models', () => {
    const { PORT: _p, LOG_LEVEL: _l, BUILDER_MODEL: _b, PATCH_MODEL: _m, ...rest } = RAW_ENV;
    const env = loadEnv(rest);
    expect(env.PORT).toBe(8083);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.BUILDER_MODEL).toBe('claude-sonnet-5-5');
    expect(env.PATCH_MODEL).toBe('claude-sonnet-5-5');
  });

  it('names every missing or invalid variable', () => {
    const { ANTHROPIC_API_KEY: _k, ...rest } = RAW_ENV;
    expect(() => loadEnv({ ...rest, SK_INTERNAL_TOKEN: 'short', PERCEPTION_URL: 'not-a-url' })).toThrow(
      /SK_INTERNAL_TOKEN[\s\S]*ANTHROPIC_API_KEY[\s\S]*PERCEPTION_URL/,
    );
  });

  it('ignores the unused embedding variables from .env.example', () => {
    const env = loadEnv({ ...RAW_ENV, GEMINI_API_KEY: '', EMBED_MODEL: '<id>', EMBED_DIM: '768' });
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
  });
});
