import { ConfirmedBooking, SelectedSlot } from '../types';

const LOCAL_STORAGE_CACHE_KEY = 'matchsip_bookings_cache';

// Client-Side In-Memory Cache with TTL to prevent redundant network fetches
let inMemoryBookingsCache: ConfirmedBooking[] | null = null;
let lastCacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds fresh cache TTL

/**
 * Retrieves initial bookings synchronously from memory or persistent storage (localStorage).
 * Completely eliminates the initial loading flash and delay when mounting components!
 */
export function getInitialCachedBookings(): ConfirmedBooking[] {
  if (inMemoryBookingsCache && inMemoryBookingsCache.length > 0) {
    return inMemoryBookingsCache;
  }
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(LOCAL_STORAGE_CACHE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          inMemoryBookingsCache = parsed;
          lastCacheTimestamp = Date.now();
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('[MATCH&SIP] Persistent cache read warning:', err);
  }
  return [];
}

export function getCachedBookings(): ConfirmedBooking[] | null {
  if (inMemoryBookingsCache && (Date.now() - lastCacheTimestamp < CACHE_TTL_MS)) {
    return inMemoryBookingsCache;
  }
  const disk = getInitialCachedBookings();
  return disk.length > 0 ? disk : inMemoryBookingsCache;
}

export function setCachedBookings(bookings: ConfirmedBooking[]): void {
  inMemoryBookingsCache = bookings;
  lastCacheTimestamp = Date.now();
  try {
    if (typeof window !== 'undefined') {
      // Omit data: URLs from localStorage to prevent QuotaExceededError while retaining metadata
      const safeForLocalStorage = bookings.map((b) => {
        if (b.paymentProofUrl && b.paymentProofUrl.startsWith('data:')) {
          return { ...b, paymentProofUrl: '' };
        }
        return b;
      });
      localStorage.setItem(LOCAL_STORAGE_CACHE_KEY, JSON.stringify(safeForLocalStorage));
    }
  } catch (err) {
    // Quota exceeded or private browsing
  }
}

/**
 * Send an automated immediate notification email to the admin via Resend server API.
 */
export async function sendAdminBookingNotification(
  booking: ConfirmedBooking
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await fetch('/api/notify-admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ booking }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.warn('Admin notification email returned non-OK status:', errData);
      return { success: false, message: errData.error || errData.message || 'Notification failed' };
    }

    const data = await response.json();
    return { success: true, message: data.message };
  } catch (error: any) {
    console.warn('Failed to send admin booking notification email:', error);
    return { success: false, message: error?.message || 'Network error' };
  }
}

/**
 * Builds a deterministic canonical lock document ID for a court slot on a specific date.
 * E.g. "2026-10-08_court-1_0800"
 */
export function toCanonicalSlotLockId(date: string, courtId: string, timeLabel: string): string {
  const match = (timeLabel || '').match(/(\d{1,2}):(\d{2})/);
  const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '0800';
  const cleanCourt = (courtId || 'court-1').toLowerCase().trim();
  const cleanDate = (date || '').trim();
  return `${cleanDate}_${cleanCourt}_${timeKey}`;
}

/**
 * Helper to build canonical slot ID (e.g. "court-1-0800")
 */
export function toCanonicalSlotId(courtId: string, timeLabel: string): string {
  const match = (timeLabel || '').match(/(\d{1,2}):(\d{2})/);
  const timeDigits = match ? `${match[1].padStart(2, '0')}${match[2]}` : '0800';
  return `${courtId || 'court-1'}-${timeDigits}`;
}

/**
 * Convert Cloud SQL row to frontend ConfirmedBooking interface
 */
export function mapSqlRowToBooking(row: any): ConfirmedBooking {
  return {
    id: row.bookingReference || String(row.id),
    bookingReference: row.bookingReference,
    selectedDate: row.selectedDate,
    paymentMethod: row.paymentMethod || 'GCash (PayMongo)',
    customer: {
      fullName: row.customerName || '',
      phoneNumber: row.customerPhone || '',
      email: row.customerEmail || '',
      notes: row.customerNotes || '',
    },
    slots: Array.isArray(row.slots) ? row.slots : [],
    totalAmount: Number(row.totalAmount) || 0,
    paymentProofUrl: row.paymentProofUrl || '',
    status: row.status || 'BOOKED',
    confirmedAt: row.confirmedAt || (row.createdAt ? new Date(row.createdAt).toISOString() : ''),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : (row.confirmedAt || ''),
    bookedAt: row.bookedAt || (row.createdAt ? new Date(row.createdAt).toISOString() : ''),
  };
}

/**
 * Live pre-checkout / pre-submission slot availability verification.
 * Directly checks live Cloud SQL bookings for the target date to prevent double bookings.
 */
export async function validateSlotsLiveAvailability(
  slots: SelectedSlot[],
  dateStr: string,
  excludeBookingRef?: string
): Promise<{ isAvailable: boolean; conflictReason?: string; conflictingSlot?: SelectedSlot }> {
  if (!slots || slots.length === 0) {
    return { isAvailable: true };
  }

  try {
    const res = await fetch(`/api/sql/bookings?date=${encodeURIComponent(dateStr)}`);
    if (!res.ok) {
      return { isAvailable: true };
    }
    const data = await res.json();
    const existingBookings = Array.isArray(data.bookings) ? data.bookings : [];

    const bookedSlotKeys = new Set<string>();
    const bookedRefMap = new Map<string, string>();

    existingBookings.forEach((b: any) => {
      const ref = b.bookingReference;
      if (excludeBookingRef && ref === excludeBookingRef) return;
      if (b.status === 'CANCELLED' || b.status === 'REJECTED') return;

      (b.slots || []).forEach((s: any) => {
        const cId = (s.courtId || 'court-1').toLowerCase();
        const tLabel = s.timeLabel || '';
        const match = tLabel.match(/(\d{1,2}):(\d{2})/);
        const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '';

        if (s.slotId) bookedSlotKeys.add(s.slotId);
        if (timeKey) bookedSlotKeys.add(`${cId}-${timeKey}`);
        if (tLabel) bookedSlotKeys.add(`${cId}-${tLabel.trim()}`);

        const canonical = toCanonicalSlotLockId(dateStr, cId, tLabel);
        bookedSlotKeys.add(canonical);
        bookedRefMap.set(canonical, ref);
      });
    });

    for (const slot of slots) {
      const cId = (slot.courtId || 'court-1').toLowerCase();
      const tLabel = slot.timeLabel || '';
      const match = tLabel.match(/(\d{1,2}):(\d{2})/);
      const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '';
      const canonical = toCanonicalSlotLockId(slot.date || dateStr, cId, tLabel);

      const isConflict =
        bookedSlotKeys.has(canonical) ||
        bookedSlotKeys.has(slot.slotId) ||
        (timeKey ? bookedSlotKeys.has(`${cId}-${timeKey}`) : false);

      if (isConflict) {
        const ref = bookedRefMap.get(canonical) || bookedRefMap.get(slot.slotId) || '';
        return {
          isAvailable: false,
          conflictingSlot: slot,
          conflictReason: `Court slot "${slot.courtName} (${slot.timeLabel})" was just reserved by another player${ref ? ` (#${ref})` : ''}. Please select an open slot.`,
        };
      }
    }

    return { isAvailable: true };
  } catch (err) {
    console.warn('[MATCH&SIP] Live slot availability check warning:', err);
    return { isAvailable: true };
  }
}

/**
 * Save a new confirmed court reservation to Cloud SQL with atomic slot locks.
 */
export async function saveBookingToFirestore(booking: ConfirmedBooking): Promise<void> {
  const nowIso = new Date().toISOString();
  const confirmedAt = booking.confirmedAt || booking.createdAt || nowIso;
  const createdAt = booking.createdAt || confirmedAt;
  const bookedAt = booking.bookedAt || confirmedAt;

  const payload = {
    bookingReference: booking.bookingReference,
    selectedDate: booking.selectedDate,
    paymentMethod: booking.paymentMethod || 'GCash (PayMongo)',
    customerName: booking.customer.fullName,
    customerPhone: booking.customer.phoneNumber,
    customerEmail: booking.customer.email || '',
    customerNotes: booking.customer.notes || '',
    slots: booking.slots.map((s) => ({
      slotId: s.slotId,
      courtId: s.courtId,
      courtName: s.courtName,
      timeLabel: s.timeLabel,
      date: s.date || booking.selectedDate,
      price: s.price,
    })),
    totalAmount: Number(booking.totalAmount) || 0,
    paymentProofUrl: booking.paymentProofUrl || '',
    status: booking.status || 'BOOKED',
    confirmedAt,
    bookedAt,
  };

  const res = await fetch('/api/sql/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to save booking to database.');
  }

  // Automated immediate notification email to admin via Resend
  try {
    const notifyResult = await sendAdminBookingNotification(booking);
    if (notifyResult.success) {
      console.log(`[MATCH&SIP] Admin email notification sent for #${booking.bookingReference}`);
    } else {
      console.warn(`[MATCH&SIP] Admin email notification dispatch warning:`, notifyResult.message);
    }
  } catch (err) {
    console.warn('[MATCH&SIP] Non-blocking admin email notification failed:', err);
  }

  // Update in-memory & persistent cache immediately
  const existingCached = getInitialCachedBookings();
  const alreadyInCache = existingCached.some((b) => b.bookingReference === booking.bookingReference);
  if (!alreadyInCache) {
    setCachedBookings([booking, ...existingCached]);
  }
}

/**
 * Delete a booking and release its locks from Cloud SQL.
 */
export async function deleteBookingFromFirestore(bookingId: string): Promise<void> {
  if (!bookingId) throw new Error('Missing booking ID for deletion');
  const cleanId = bookingId.trim();

  const res = await fetch(`/api/sql/bookings/${encodeURIComponent(cleanId)}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete booking from database.');
  }

  // Synchronously update in-memory and persistent cache
  if (inMemoryBookingsCache) {
    const updatedCache = inMemoryBookingsCache.filter(
      (b) => b.id !== cleanId && b.bookingReference !== cleanId
    );
    setCachedBookings(updatedCache);
  }
}

/**
 * Update an existing booking in Cloud SQL.
 */
export async function updateBookingInFirestore(
  bookingId: string,
  updates: {
    fullName?: string;
    phoneNumber?: string;
    selectedDate?: string;
    status?: string;
    totalAmount?: number;
    notes?: string;
    slots?: SelectedSlot[];
  }
): Promise<void> {
  const cleanId = (bookingId || '').trim();
  if (!cleanId) throw new Error('Missing booking ID for update');

  const cleanSlots = updates.slots
    ? updates.slots.map((s) => {
        const courtId = s.courtId || 'court-1';
        const courtName = s.courtName || (courtId === 'court-2' ? 'Court 02' : 'Court 01');
        const timeLabel = s.timeLabel || '08:00 - 09:00';
        const canonicalSlotId = toCanonicalSlotId(courtId, timeLabel);

        return {
          slotId: canonicalSlotId,
          courtId,
          courtName,
          timeLabel,
          date: s.date || updates.selectedDate || '',
          price: Number(s.price) || 0,
        };
      })
    : undefined;

  const payload: Record<string, any> = {};
  if (updates.fullName !== undefined) payload.customerName = updates.fullName.trim();
  if (updates.phoneNumber !== undefined) payload.customerPhone = updates.phoneNumber.trim();
  if (updates.notes !== undefined) payload.customerNotes = (updates.notes || '').trim();
  if (updates.selectedDate !== undefined) payload.selectedDate = updates.selectedDate.trim();
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.totalAmount !== undefined) payload.totalAmount = Number(updates.totalAmount) || 0;
  if (cleanSlots !== undefined) payload.slots = cleanSlots;

  const res = await fetch(`/api/sql/bookings/${encodeURIComponent(cleanId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update booking in database.');
  }

  // Update local cache
  const currentCache = getInitialCachedBookings();
  if (currentCache.length > 0) {
    const updatedCache = currentCache.map((b) => {
      if (b.id === cleanId || b.bookingReference === cleanId) {
        return {
          ...b,
          ...(updates.selectedDate ? { selectedDate: updates.selectedDate } : {}),
          ...(updates.status ? { status: updates.status } : {}),
          ...(updates.totalAmount !== undefined ? { totalAmount: Number(updates.totalAmount) } : {}),
          customer: {
            ...b.customer,
            ...(updates.fullName ? { fullName: updates.fullName } : {}),
            ...(updates.phoneNumber ? { phoneNumber: updates.phoneNumber } : {}),
            ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
          },
          slots: cleanSlots || b.slots,
        };
      }
      return b;
    });
    setCachedBookings(updatedCache);
  }
}

/**
 * Consolidate updates across multiple bookings into Cloud SQL.
 */
export async function batchUpdateBookingsInFirestore(
  bookingUpdates: Array<{
    bookingId: string;
    updates: {
      fullName?: string;
      phoneNumber?: string;
      selectedDate?: string;
      status?: string;
      totalAmount?: number;
      notes?: string;
      slots?: SelectedSlot[];
    };
  }>
): Promise<void> {
  if (!bookingUpdates || bookingUpdates.length === 0) return;

  for (const { bookingId, updates } of bookingUpdates) {
    await updateBookingInFirestore(bookingId, updates);
  }
}

/**
 * Real-time subscription to court reservations in Cloud SQL via periodic polling and instant cache delivery.
 */
export function subscribeToBookings(
  onBookingsUpdated: (bookings: ConfirmedBooking[]) => void,
  onError?: (err: Error) => void,
  options?: { maxLimit?: number }
): () => void {
  // 1. Immediately emit cached bookings from memory or persistent storage (0ms latency, eliminates loading flash!)
  const cached = getInitialCachedBookings();
  if (cached.length > 0) {
    onBookingsUpdated(cached);
  }

  const maxLimit = options?.maxLimit ?? 250;
  let isMounted = true;

  const fetchBookings = async () => {
    try {
      const res = await fetch(`/api/sql/bookings?limit=${maxLimit}`);
      if (!res.ok) throw new Error('Failed to fetch bookings from Cloud SQL');
      const data = await res.json();
      if (!isMounted) return;

      const items: ConfirmedBooking[] = (data.bookings || []).map(mapSqlRowToBooking);
      setCachedBookings(items);
      onBookingsUpdated(items);
    } catch (err: any) {
      if (!isMounted) return;
      console.warn('Cloud SQL bookings fetch notice:', err);
      if (onError) onError(err);
    }
  };

  // Initial fetch
  fetchBookings();

  // Poll every 4 seconds to catch newly confirmed bookings in real-time
  const intervalId = setInterval(fetchBookings, 4000);

  return () => {
    isMounted = false;
    clearInterval(intervalId);
  };
}

/**
 * Call the backend checkout creation endpoint (/api/create-checkout)
 * Integrates PayMongo Checkout Session or Source when user clicks BOOK RESERVATION.
 */
export async function createPaymongoCheckout(booking: ConfirmedBooking): Promise<{
  success: boolean;
  checkoutUrl: string;
  qrCodeUrl: string;
  bookingReference: string;
  provider: string;
  isLive: boolean;
  error?: string;
}> {
  try {
    const response = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ booking }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to initialize payment checkout.');
    }

    return data;
  } catch (err: any) {
    console.error('Error creating payment checkout session:', err);
    throw err;
  }
}

/**
 * Simulate GCash webhook payment approval for test/sandbox mode
 */
export async function simulatePaymongoPayment(bookingReference: string): Promise<boolean> {
  try {
    const response = await fetch('/api/payment/simulate-pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bookingReference }),
    });
    const data = await response.json();
    return Boolean(data.success);
  } catch (err) {
    console.error('Error simulating payment:', err);
    return false;
  }
}

/**
 * Real-time listener for a single booking document to detect when status flips to 'BOOKED'
 */
export function subscribeToSingleBooking(
  bookingReference: string,
  onUpdate: (booking: ConfirmedBooking | null) => void
): () => void {
  let isMounted = true;

  const pollStatus = async () => {
    try {
      const res = await fetch(`/api/payment/status/${encodeURIComponent(bookingReference)}`);
      if (!res.ok) {
        if (res.status === 404 && isMounted) onUpdate(null);
        return;
      }
      const data = await res.json();
      if (!isMounted) return;

      onUpdate({
        id: bookingReference,
        bookingReference,
        selectedDate: data.selectedDate,
        paymentMethod: 'GCash (PayMongo)',
        customer: {
          fullName: data.customer?.fullName || '',
          phoneNumber: data.customer?.phoneNumber || '',
          email: data.customer?.email || '',
          notes: data.customer?.notes || '',
        },
        slots: Array.isArray(data.slots) ? data.slots : [],
        totalAmount: Number(data.totalAmount) || 0,
        paymentProofUrl: '',
        status: data.status || 'PENDING',
        confirmedAt: '',
        createdAt: '',
        paidAt: data.isBooked ? new Date().toISOString() : '',
        paymentId: '',
      });
    } catch (err) {
      console.warn('Single booking status poll notice:', err);
    }
  };

  pollStatus();
  const intervalId = setInterval(pollStatus, 2500);

  return () => {
    isMounted = false;
    clearInterval(intervalId);
  };
}
