import { z } from 'zod';

// Shared secrets are generated with `openssl rand -hex 32` (64 hex chars).
const secret = z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)');
const url = z.string().url();

// DESIGN §8. GEMINI_API_KEY / EMBED_* in .env.example are unused: retrieval is Postgres full-text.
export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8083),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  REDIS_URL: url,
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  SK_INTERNAL_TOKEN: secret,

  ANTHROPIC_API_KEY: z.string().min(1),
  BUILDER_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  PATCH_MODEL: z.string().min(1).default('claude-sonnet-5-5'),

  BRAIN_URL: url,
  GATEWAY_INTERNAL_URL: url,
  PERCEPTION_URL: url,
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
