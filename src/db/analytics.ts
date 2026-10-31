import { supabase, isSupabaseConfigured, isTableMissingError } from '../lib/supabase.ts';

export interface AnalyticsEventInput {
  ipAddress: string;
  action: string;
  userAgent?: string;
}

/**
 * Normalizes an analytics log row from Supabase
 */
export function normalizeAnalyticsRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    ipAddress: row.ip_address ?? row.ipAddress ?? '',
    action: row.action ?? '',
    userAgent: row.user_agent ?? row.userAgent ?? '',
    timestamp: row.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Record a visitor analytics / security audit event using Supabase syntax.
 */
export async function recordAnalyticsEvent(event: AnalyticsEventInput) {
  if (!isSupabaseConfigured) {
    return null;
  }

  try {
    const cleanIp = (event.ipAddress || 'unknown').slice(0, 255);
    const cleanAction = (event.action || 'view').trim();
    const cleanUa = (event.userAgent || '').slice(0, 1000);

    const { data, error } = await supabase
      .from('visitor_analytics')
      .insert({
        ip_address: cleanIp,
        action: cleanAction,
        user_agent: cleanUa,
      })
      .select()
      .maybeSingle();

    if (error && !isTableMissingError(error)) {
      console.warn('[ANALYTICS] Supabase record insert notice:', error.message);
    }

    // Probabilistically purge old logs to maintain the 48h window
    if (Math.random() < 0.25) {
      purgeOldAnalyticsLogs(48).catch(() => {});
    }

    return data ? normalizeAnalyticsRow(data) : null;
  } catch (error) {
    if (!isTableMissingError(error)) {
      console.error('Failed to record visitor analytics event in Supabase:', error);
    }
    return null;
  }
}

/**
 * Get visitor analytics logs within the 48-hour window using Supabase syntax.
 */
export async function getAnalyticsLogs(limitCount = 500) {
  if (!isSupabaseConfigured) {
    return [];
  }

  try {
    const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let { data, error } = await supabase
      .from('visitor_analytics')
      .select('*')
      .gte('timestamp', cutoffIso)
      .order('timestamp', { ascending: false })
      .limit(limitCount);

    if (error) {
      if (isTableMissingError(error)) {
        return [];
      }
      console.error('Failed to fetch visitor analytics logs from Supabase:', error);
      throw new Error(error.message || 'Database query for visitor analytics failed.');
    }

    return (data || []).map(normalizeAnalyticsRow);
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return [];
    }
    console.error('Failed to fetch visitor analytics logs from Supabase:', error);
    throw new Error('Database query for visitor analytics failed.', { cause: error });
  }
}

/**
 * Auto-delete security & visitor logs older than the specified hour window (default 48 hours).
 */
export async function purgeOldAnalyticsLogs(hoursWindow = 48) {
  try {
    const cutoffIso = new Date(Date.now() - hoursWindow * 60 * 60 * 1000).toISOString();
    await supabase
      .from('visitor_analytics')
      .delete()
      .lt('timestamp', cutoffIso);
  } catch (error) {
    if (!isTableMissingError(error)) {
      console.warn('Failed to purge old analytics logs from Supabase:', error);
    }
  }
}

/**
 * Delete a specific analytics log record by its ID using Supabase syntax.
 */
export async function deleteAnalyticsLogById(id: number) {
  try {
    const { data, error } = await supabase
      .from('visitor_analytics')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      if (isTableMissingError(error)) {
        return { id };
      }
      console.error('Failed to delete analytics log by ID in Supabase:', error);
      throw new Error(error.message || 'Database error deleting analytics record');
    }

    return data ? normalizeAnalyticsRow(data) : { id };
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return { id };
    }
    console.error('Failed to delete analytics log by ID in Supabase:', error);
    throw new Error('Database error deleting analytics record', { cause: error });
  }
}

/**
 * Reset / purge all present visitor analytics logs and refresh the tracking feed.
 */
export async function clearAllAnalyticsLogs() {
  try {
    const { data, error } = await supabase
      .from('visitor_analytics')
      .delete()
      .neq('id', -1)
      .select();

    if (error) {
      if (isTableMissingError(error)) {
        return { count: 0 };
      }
      console.error('Failed to clear all analytics logs in Supabase:', error);
      throw new Error(error.message || 'Database error clearing analytics logs');
    }

    return { count: data ? data.length : 0 };
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return { count: 0 };
    }
    console.error('Failed to clear all analytics logs in Supabase:', error);
    throw new Error('Database error clearing analytics logs', { cause: error });
  }
}

/**
 * Get summary metrics for the 48-hour analytics window using Supabase data.
 */
export async function getAnalyticsMetrics() {
  if (!isSupabaseConfigured) {
    return {
      totalEvents: 0,
      uniqueIps: 0,
      bookingActions: 0,
      slotInteractions: 0,
      topActions: [],
      topIps: [],
    };
  }

  try {
    const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('visitor_analytics')
      .select('*')
      .gte('timestamp', cutoffIso);

    if (error || !data) {
      return {
        totalEvents: 0,
        uniqueIps: 0,
        bookingActions: 0,
        slotInteractions: 0,
        topActions: [],
        topIps: [],
      };
    }

    const uniqueIpsSet = new Set<string>();
    let bookingActions = 0;
    let slotInteractions = 0;
    const actionCounts: Record<string, number> = {};
    const ipCounts: Record<string, number> = {};

    for (const item of data) {
      const ip = (item.ip_address ?? item.ipAddress ?? 'unknown').trim();
      const action = (item.action ?? 'view').trim();

      if (ip) {
        uniqueIpsSet.add(ip);
        ipCounts[ip] = (ipCounts[ip] || 0) + 1;
      }

      if (action.includes('Booking') || action.toLowerCase().includes('checkout')) {
        bookingActions++;
      }
      if (action.includes('Slot')) {
        slotInteractions++;
      }

      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }

    const topActions = Object.entries(actionCounts)
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const topIps = Object.entries(ipCounts)
      .map(([ip_address, count]) => ({ ip_address, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      totalEvents: data.length,
      uniqueIps: uniqueIpsSet.size,
      bookingActions,
      slotInteractions,
      topActions,
      topIps,
    };
  } catch (error) {
    return {
      totalEvents: 0,
      uniqueIps: 0,
      bookingActions: 0,
      slotInteractions: 0,
      topActions: [],
      topIps: [],
    };
  }
}
