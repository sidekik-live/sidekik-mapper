import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import type { HealthCheck } from './routes/health.js';

/** Service-role client: bypasses RLS, so only write to tables the mapper owns (ARCHITECTURE §6). */
export function createSupabase(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseHealth(supabase: SupabaseClient): HealthCheck {
  return async () => {
    const { error } = await supabase.from('work_maps').select('id', { head: true }).limit(1);
    if (error) throw new Error(error.message);
  };
}
