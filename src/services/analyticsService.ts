export interface AnalyticsLog {
  id: number;
  ipAddress: string;
  action: string;
  userAgent: string;
  timestamp: string;
}

export interface AnalyticsMetrics {
  totalEvents: number;
  uniqueIps: number;
  bookingActions: number;
  slotInteractions: number;
  topActions: Array<{ action: string; count: number }>;
  topIps: Array<{ ip_address: string; count: number }>;
}

/**
 * Sends a visitor security / audit event to the backend.
 * Uses beacon / keepalive so it doesn't block UI interactions or get cancelled on navigation.
 */
export async function trackVisitorAction(action: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const payload = JSON.stringify({ action });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics/track', blob);
      return;
    }

    await fetch('/api/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    });
  } catch (err) {
    // Non-blocking
    console.debug('[ANALYTICS] Tracking notice:', err);
  }
}

/**
 * Fetch visitor analytics logs for the 48-hour window (Protected with admin PIN).
 */
export async function fetchAnalyticsLogs(
  adminPin: string,
  limit = 250
): Promise<{ logs: AnalyticsLog[]; metrics: AnalyticsMetrics }> {
  const res = await fetch(`/api/analytics?limit=${limit}`, {
    method: 'GET',
    headers: {
      'x-admin-pin': adminPin.trim(),
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to fetch analytics logs. Unauthorized.');
  }

  const data = await res.json();
  return {
    logs: data.logs || [],
    metrics: data.metrics || {
      totalEvents: 0,
      uniqueIps: 0,
      bookingActions: 0,
      slotInteractions: 0,
      topActions: [],
      topIps: [],
    },
  };
}

/**
 * Delete a specific analytics log entry by its ID.
 */
export async function deleteAnalyticsLog(adminPin: string, id: number): Promise<boolean> {
  const res = await fetch(`/api/analytics/${id}`, {
    method: 'DELETE',
    headers: {
      'x-admin-pin': adminPin.trim(),
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to delete analytics record.');
  }

  const data = await res.json();
  return data.success;
}

/**
 * Clear/delete all visitor analytics logs and reset the feed.
 */
export async function clearAllAnalytics(adminPin: string): Promise<{ count: number }> {
  const res = await fetch('/api/analytics', {
    method: 'DELETE',
    headers: {
      'x-admin-pin': adminPin.trim(),
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to clear analytics logs.');
  }

  const data = await res.json();
  return { count: data.count || 0 };
}
