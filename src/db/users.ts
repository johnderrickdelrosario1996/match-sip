import { supabase, isSupabaseConfigured, isTableMissingError } from '../lib/supabase.ts';

export async function getOrCreateUser(uid: string, email: string) {
  if (!isSupabaseConfigured) {
    return { uid, email };
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .upsert({ uid, email }, { onConflict: 'uid' })
      .select()
      .maybeSingle();

    if (error) {
      if (isTableMissingError(error)) {
        return { uid, email };
      }
      console.error('Failed to get or create user in Supabase:', error);
      throw new Error(error.message || 'Database user operation failed.');
    }

    return data || { uid, email };
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return { uid, email };
    }
    console.error('Failed to get or create user in Supabase:', error);
    throw new Error(error.message || 'Database user operation failed.', { cause: error });
  }
}

export async function getUsers() {
  if (!isSupabaseConfigured) {
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*');

    if (error) {
      if (isTableMissingError(error)) {
        return [];
      }
      console.error('Failed to fetch users from Supabase:', error);
      throw new Error(error.message || 'Database query failed.');
    }

    return data || [];
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return [];
    }
    console.error('Failed to query users from Supabase:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}
