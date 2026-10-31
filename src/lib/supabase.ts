import { createClient } from '@supabase/supabase-js';

/**
 * Single Supabase client initialized using environment variables:
 * - SUPABASE_URL (or VITE_SUPABASE_URL in frontend)
 * - SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY in frontend)
 */
const getEnvVar = (key: string): string => {
  if (typeof process !== 'undefined' && process?.env && process.env[key]) {
    return process.env[key]!.trim();
  }
  try {
    if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
      const viteKey = key.startsWith('VITE_') ? key : `VITE_${key}`;
      const val = (import.meta as any).env[key] || (import.meta as any).env[viteKey];
      if (val) return String(val).trim();
    }
  } catch {
    // Ignore in non-Vite contexts
  }
  return '';
};

const supabaseUrl =
  getEnvVar('SUPABASE_URL') ||
  getEnvVar('VITE_SUPABASE_URL') ||
  'https://placeholder-project.supabase.co';

const supabaseAnonKey =
  getEnvVar('SUPABASE_ANON_KEY') ||
  getEnvVar('VITE_SUPABASE_ANON_KEY') ||
  'placeholder-anon-key';

export const isSupabaseConfigured = Boolean(
  getEnvVar('SUPABASE_URL') || getEnvVar('VITE_SUPABASE_URL')
);

/**
 * Detects if a Supabase error is caused by a missing table in schema cache (PGRST205 / 42P01)
 */
export function isTableMissingError(error: any): boolean {
  if (!error) return false;
  const msg = (error.message || error.details || error.hint || String(error)).toLowerCase();
  const code = (error.code || '').toUpperCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('relation')
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default supabase;
