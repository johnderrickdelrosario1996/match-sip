import { desc, sql, gte } from 'drizzle-orm';
import { db } from './index.ts';
import { visitorAnalytics } from './schema.ts';

export interface AnalyticsEventInput {
  ipAddress: string;
  action: string;
  userAgent?: string;
}

/**
 * Record a visitor analytics / security audit event.
 * Automatically enforces a rolling 48-hour window by auto-deleting records older than 48 hours.
 */
export async function recordAnalyticsEvent(event: AnalyticsEventInput) {
  try {
    const cleanIp = (event.ipAddress || 'unknown').slice(0, 255);
    const cleanAction = (event.action || 'view').trim();
    const cleanUa = (event.userAgent || '').slice(0, 1000);

    const result = await db
      .insert(visitorAnalytics)
      .values({
        ipAddress: cleanIp,
        action: cleanAction,
        userAgent: cleanUa,
      })
      .returning();

    // Probabilistic or immediate cleanup of logs older than 48 hours to maintain a rolling 48h log window
    // (runs asynchronously so it never slows down client requests)
    if (Math.random() < 0.25) {
      purgeOldAnalyticsLogs(48).catch((err) => {
        console.warn('[ANALYTICS] Auto-purge warning:', err);
      });
    }

    return result[0];
  } catch (error) {
    console.error('Failed to record visitor analytics event:', error);
    // Non-blocking: analytics should never crash application operations
    return null;
  }
}

/**
 * Get visitor analytics logs within the 48-hour window.
 */
export async function getAnalyticsLogs(limitCount = 500) {
  try {
    // Purge any logs older than 48 hours
    await purgeOldAnalyticsLogs(48);

    // Query logs within the 48-hour window
    const logs = await db
      .select()
      .from(visitorAnalytics)
      .where(sql`${visitorAnalytics.timestamp} >= NOW() - INTERVAL '48 hours'`)
      .orderBy(desc(visitorAnalytics.timestamp))
      .limit(limitCount);

    return logs;
  } catch (error) {
    console.error('Failed to fetch visitor analytics logs:', error);
    throw new Error('Database query for visitor analytics failed.', { cause: error });
  }
}

/**
 * Auto-delete security & visitor logs older than the specified hour window (default 48 hours).
 */
export async function purgeOldAnalyticsLogs(hoursWindow = 48) {
  try {
    await db.execute(
      sql`DELETE FROM visitor_analytics WHERE timestamp < NOW() - INTERVAL '${sql.raw(String(hoursWindow))} hours'`
    );
  } catch (error) {
    console.warn('Failed to purge old analytics logs:', error);
  }
}

/**
 * Delete a specific analytics log record by its ID.
 */
export async function deleteAnalyticsLogById(id: number) {
  try {
    const deleted = await db
      .delete(visitorAnalytics)
      .where(sql`${visitorAnalytics.id} = ${id}`)
      .returning();
    return deleted[0] || null;
  } catch (error) {
    console.error('Failed to delete analytics log by ID:', error);
    throw new Error('Database error deleting analytics record', { cause: error });
  }
}

/**
 * Reset / purge all present visitor analytics logs and refresh the tracking feed.
 */
export async function clearAllAnalyticsLogs() {
  try {
    const deleted = await db.delete(visitorAnalytics).returning();
    return { count: deleted.length };
  } catch (error) {
    console.error('Failed to clear all analytics logs:', error);
    throw new Error('Database error clearing analytics logs', { cause: error });
  }
}

/**
 * Get summary metrics for the 48-hour analytics window.
 */
export async function getAnalyticsMetrics() {
  try {
    const countsResult = await db.execute(sql`
      SELECT 
        COUNT(*)::int as total_events,
        COUNT(DISTINCT ip_address)::int as unique_ips,
        COUNT(CASE WHEN action LIKE '%Booking%' OR action LIKE '%checkout%' THEN 1 END)::int as booking_actions,
        COUNT(CASE WHEN action LIKE '%Slot%' THEN 1 END)::int as slot_interactions
      FROM visitor_analytics 
      WHERE timestamp >= NOW() - INTERVAL '48 hours';
    `);

    const topActionsResult = await db.execute(sql`
      SELECT action, COUNT(*)::int as count
      FROM visitor_analytics
      WHERE timestamp >= NOW() - INTERVAL '48 hours'
      GROUP BY action
      ORDER BY count DESC
      LIMIT 6;
    `);

    const topIpsResult = await db.execute(sql`
      SELECT ip_address, COUNT(*)::int as count
      FROM visitor_analytics
      WHERE timestamp >= NOW() - INTERVAL '48 hours'
      GROUP BY ip_address
      ORDER BY count DESC
      LIMIT 6;
    `);

    const counts = (countsResult as any).rows?.[0] || {
      total_events: 0,
      unique_ips: 0,
      booking_actions: 0,
      slot_interactions: 0,
    };

    return {
      totalEvents: Number(counts.total_events) || 0,
      uniqueIps: Number(counts.unique_ips) || 0,
      bookingActions: Number(counts.booking_actions) || 0,
      slotInteractions: Number(counts.slot_interactions) || 0,
      topActions: (topActionsResult as any).rows || [],
      topIps: (topIpsResult as any).rows || [],
    };
  } catch (error) {
    console.error('Failed to calculate analytics metrics:', error);
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
