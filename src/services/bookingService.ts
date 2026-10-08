import { 
  collection, 
  doc, 
  getDoc,
  getDocs,
  setDoc, 
  updateDoc,
  deleteDoc,
  onSnapshot, 
  query,
  limit,
  where,
  runTransaction,
  writeBatch,
  serverTimestamp 
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import { ConfirmedBooking, SelectedSlot } from '../types';

const BOOKINGS_COLLECTION = 'bookings';
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
      localStorage.setItem(LOCAL_STORAGE_CACHE_KEY, JSON.stringify(bookings));
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
 * Live pre-checkout / pre-submission slot availability verification.
 * Directly checks live Firestore bookings for the target date to prevent double bookings.
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
    // 1. Live query of existing bookings on this reservation date (preserves all data, catches legacy records)
    const colRef = collection(db, BOOKINGS_COLLECTION);
    const dateQuery = query(colRef, where('selectedDate', '==', dateStr));
    const snap = await getDocs(dateQuery);

    const bookedSlotKeys = new Set<string>();
    const bookedRefMap = new Map<string, string>();

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const ref = data.bookingReference || docSnap.id;
      if (excludeBookingRef && ref === excludeBookingRef) return;
      if (data.status === 'CANCELLED' || data.status === 'REJECTED') return;

      (data.slots || []).forEach((s: any) => {
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

    // 2. Validate requested slots against existing booked slots and atomic locks
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

    // Consolidated parallel reads for any remaining active slot locks
    const remainingChecks = slots.map(async (slot) => {
      const cId = (slot.courtId || 'court-1').toLowerCase();
      const tLabel = slot.timeLabel || '';
      const canonical = toCanonicalSlotLockId(slot.date || dateStr, cId, tLabel);
      try {
        const lockRef = doc(db, 'court_slot_locks', canonical);
        const lockSnap = await getDoc(lockRef);
        if (lockSnap.exists()) {
          const lData = lockSnap.data();
          if (lData.bookingReference !== excludeBookingRef && lData.status !== 'RELEASED') {
            return {
              isAvailable: false,
              conflictingSlot: slot,
              conflictReason: `Court slot "${slot.courtName} (${slot.timeLabel})" is already locked (#${lData.bookingReference}). Please select an open slot.`,
            };
          }
        }
      } catch {
        // Fall back gracefully if lock document read had issues
      }
      return null;
    });

    const lockResults = await Promise.all(remainingChecks);
    const firstConflict = lockResults.find((r) => r !== null && !r.isAvailable);
    if (firstConflict) {
      return firstConflict;
    }

    return { isAvailable: true };
  } catch (err) {
    console.warn('[MATCH&SIP] Live slot availability check warning (proceeding with atomic transaction):', err);
    return { isAvailable: true };
  }
}

/**
 * Save a new confirmed court reservation to Cloud Firestore using an ATOMIC TRANSACTION.
 * Guarantees that concurrent submissions for the exact same slot will NEVER double-book!
 */
export async function saveBookingToFirestore(booking: ConfirmedBooking): Promise<void> {
  const bookingRef = doc(db, BOOKINGS_COLLECTION, booking.bookingReference);
  const nowIso = new Date().toISOString();
  const confirmedAt = booking.confirmedAt || booking.createdAt || nowIso;
  const createdAt = booking.createdAt || confirmedAt;
  const bookedAt = booking.bookedAt || confirmedAt;

  const bookingPayload = {
    bookingReference: booking.bookingReference,
    selectedDate: booking.selectedDate,
    paymentMethod: booking.paymentMethod || 'GCash (PayMongo)',
    customer: {
      fullName: booking.customer.fullName,
      phoneNumber: booking.customer.phoneNumber,
      email: booking.customer.email || '',
      notes: booking.customer.notes || '',
    },
    slots: booking.slots.map((s) => ({
      slotId: s.slotId,
      courtId: s.courtId,
      courtName: s.courtName,
      timeLabel: s.timeLabel,
      date: s.date,
      price: s.price,
    })),
    totalAmount: booking.totalAmount,
    paymentProofUrl: booking.paymentProofUrl || '',
    status: booking.status || 'BOOKED',
    confirmedAt: confirmedAt,
    createdAt: createdAt,
    bookedAt: bookedAt,
    serverTimestamp: serverTimestamp(),
  };

  // Run atomic Firestore transaction: acquires lock on every slot and commits the booking
  await runTransaction(db, async (transaction) => {
    // Phase 1: Reads (all transaction reads must occur before any writes)
    const lockEntries: { lockRef: any; lockId: string; slot: SelectedSlot }[] = [];

    for (const slot of booking.slots) {
      const lockId = toCanonicalSlotLockId(slot.date || booking.selectedDate, slot.courtId, slot.timeLabel);
      const lockRef = doc(db, 'court_slot_locks', lockId);
      const lockSnap = await transaction.get(lockRef);

      if (lockSnap.exists()) {
        const existingData = lockSnap.data();
        if (
          existingData.bookingReference &&
          existingData.bookingReference !== booking.bookingReference &&
          existingData.status !== 'RELEASED'
        ) {
          throw new Error(
            `DOUBLE_BOOKING_PREVENTED: Slot "${slot.courtName} (${slot.timeLabel})" was just booked by another player (#${existingData.bookingReference}).`
          );
        }
      }

      lockEntries.push({ lockRef, lockId, slot });
    }

    // Phase 2: Writes
    // 1. Commit slot locks
    for (const { lockRef, lockId, slot } of lockEntries) {
      transaction.set(lockRef, {
        lockId,
        bookingReference: booking.bookingReference,
        customerName: booking.customer.fullName,
        date: slot.date || booking.selectedDate,
        courtId: slot.courtId,
        courtName: slot.courtName,
        timeLabel: slot.timeLabel,
        status: 'BOOKED',
        lockedAt: nowIso,
      });
    }

    // 2. Commit the booking record
    transaction.set(bookingRef, bookingPayload);
  });

  // Automated immediate notification email to admin (danamieratan@gmail.com) via Resend
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

  // Update in-memory & persistent cache immediately to prevent redundant network fetches
  const existingCached = getInitialCachedBookings();
  const alreadyInCache = existingCached.some((b) => b.bookingReference === booking.bookingReference);
  if (!alreadyInCache) {
    setCachedBookings([booking, ...existingCached]);
  }
}

/**
 * Delete a booking from Cloud Firestore using a single consolidated WriteBatch.
 */
export async function deleteBookingFromFirestore(bookingId: string): Promise<void> {
  if (!bookingId) throw new Error('Missing booking ID for deletion');
  const cleanId = bookingId.trim();
  const bookingRef = doc(db, BOOKINGS_COLLECTION, cleanId);

  try {
    const snap = await getDoc(bookingRef);
    if (snap.exists()) {
      const data = snap.data();

      // Consolidate deletions into a single atomic WriteBatch (drastically reduces network write operations)
      const batch = writeBatch(db);
      batch.delete(bookingRef);

      for (const s of (data.slots || [])) {
        const lockId = toCanonicalSlotLockId(s.date || data.selectedDate, s.courtId, s.timeLabel);
        batch.delete(doc(db, 'court_slot_locks', lockId));
      }

      await batch.commit();
    } else {
      await deleteDoc(bookingRef);
    }
  } catch (err) {
    console.warn('[MATCH&SIP] Batched deletion fallback:', err);
    await deleteDoc(bookingRef);
  }

  // Synchronously update in-memory and persistent cache to eliminate redundant reads
  if (inMemoryBookingsCache) {
    const updatedCache = inMemoryBookingsCache.filter(
      (b) => b.id !== cleanId && b.bookingReference !== cleanId
    );
    setCachedBookings(updatedCache);
  }
}

/**
 * Helper to build canonical slot ID (e.g. "court-1-0800")
 */
function toCanonicalSlotId(courtId: string, timeLabel: string): string {
  const match = (timeLabel || '').match(/(\d{1,2}):(\d{2})/);
  const timeDigits = match ? `${match[1].padStart(2, '0')}${match[2]}` : '0800';
  return `${courtId || 'court-1'}-${timeDigits}`;
}

/**
 * Update an existing booking in Cloud Firestore consolidating all modified fields into
 * a single atomic write batch, reducing roundtrips and write overhead.
 * Automatically synchronizes slot locks in the same atomic commit.
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
  const bookingRef = doc(db, BOOKINGS_COLLECTION, cleanId);

  // Clean slot objects to ensure NO undefined values reach Firestore and canonical slot IDs are set
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

  // Consolidate all top-level and nested updates into a single atomic write payload
  const nowIso = new Date().toISOString();
  const consolidatedPayload: Record<string, any> = {
    updatedAt: nowIso,
  };

  if (updates.selectedDate !== undefined) consolidatedPayload.selectedDate = updates.selectedDate.trim();
  if (updates.status !== undefined) consolidatedPayload.status = updates.status;
  if (updates.totalAmount !== undefined) consolidatedPayload.totalAmount = Number(updates.totalAmount) || 0;
  if (cleanSlots !== undefined) consolidatedPayload.slots = cleanSlots;

  const customerUpdates: Record<string, any> = {};
  if (updates.fullName !== undefined) customerUpdates.fullName = updates.fullName.trim();
  if (updates.phoneNumber !== undefined) customerUpdates.phoneNumber = updates.phoneNumber.trim();
  if (updates.notes !== undefined) customerUpdates.notes = (updates.notes || '').trim();

  if (Object.keys(customerUpdates).length > 0) {
    consolidatedPayload.customer = customerUpdates;
  }

  try {
    // Consolidate booking updates and slot lock state changes into a single atomic WriteBatch
    const batch = writeBatch(db);
    batch.set(bookingRef, consolidatedPayload, { merge: true });

    // If booking was cancelled or rejected, release locks in the same write batch
    if (updates.status === 'CANCELLED' || updates.status === 'REJECTED') {
      if (cleanSlots && cleanSlots.length > 0) {
        for (const s of cleanSlots) {
          const lockId = toCanonicalSlotLockId(s.date || updates.selectedDate || '', s.courtId, s.timeLabel);
          batch.delete(doc(db, 'court_slot_locks', lockId));
        }
      }
    } else if (cleanSlots && cleanSlots.length > 0) {
      // Synchronize slot locks atomically in the same batch
      for (const s of cleanSlots) {
        const lockId = toCanonicalSlotLockId(s.date || updates.selectedDate || '', s.courtId, s.timeLabel);
        batch.set(
          doc(db, 'court_slot_locks', lockId),
          {
            lockId,
            bookingReference: cleanId,
            customerName: updates.fullName || 'Player',
            date: s.date || updates.selectedDate || '',
            courtId: s.courtId,
            courtName: s.courtName,
            timeLabel: s.timeLabel,
            status: updates.status || 'BOOKED',
            lockedAt: nowIso,
          },
          { merge: true }
        );
      }
    }

    await batch.commit();

    // Immediately update local cache to keep client UI responsive without re-fetching
    const currentCache = getInitialCachedBookings();
    if (currentCache.length > 0) {
      const updatedCache = currentCache.map((b) => {
        if (b.id === cleanId || b.bookingReference === cleanId) {
          return {
            ...b,
            ...consolidatedPayload,
            customer: {
              ...b.customer,
              ...(customerUpdates || {}),
            },
            slots: cleanSlots || b.slots,
          };
        }
        return b;
      });
      setCachedBookings(updatedCache);
    }
  } catch (err) {
    console.error('[MATCH&SIP] Consolidated update error:', err);
    handleFirestoreError(err, OperationType.UPDATE, `${BOOKINGS_COLLECTION}/${cleanId}`);
  }
}

/**
 * Consolidate updates across multiple bookings into a SINGLE atomic WriteBatch.
 * Substantially reduces Firestore write operations and guarantees all-or-nothing execution.
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

  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();

  for (const { bookingId, updates } of bookingUpdates) {
    const cleanId = (bookingId || '').trim();
    if (!cleanId) continue;
    const bookingRef = doc(db, BOOKINGS_COLLECTION, cleanId);

    const cleanSlots = updates.slots
      ? updates.slots.map((s) => ({
          slotId: toCanonicalSlotId(s.courtId || 'court-1', s.timeLabel || '08:00 - 09:00'),
          courtId: s.courtId || 'court-1',
          courtName: s.courtName || (s.courtId === 'court-2' ? 'Court 02' : 'Court 01'),
          timeLabel: s.timeLabel || '08:00 - 09:00',
          date: s.date || updates.selectedDate || '',
          price: Number(s.price) || 0,
        }))
      : undefined;

    const consolidatedPayload: Record<string, any> = {
      updatedAt: nowIso,
    };

    if (updates.selectedDate !== undefined) consolidatedPayload.selectedDate = updates.selectedDate.trim();
    if (updates.status !== undefined) consolidatedPayload.status = updates.status;
    if (updates.totalAmount !== undefined) consolidatedPayload.totalAmount = Number(updates.totalAmount) || 0;
    if (cleanSlots !== undefined) consolidatedPayload.slots = cleanSlots;

    const customerUpdates: Record<string, any> = {};
    if (updates.fullName !== undefined) customerUpdates.fullName = updates.fullName.trim();
    if (updates.phoneNumber !== undefined) customerUpdates.phoneNumber = updates.phoneNumber.trim();
    if (updates.notes !== undefined) customerUpdates.notes = (updates.notes || '').trim();

    if (Object.keys(customerUpdates).length > 0) {
      consolidatedPayload.customer = customerUpdates;
    }

    batch.set(bookingRef, consolidatedPayload, { merge: true });

    if (updates.status === 'CANCELLED' || updates.status === 'REJECTED') {
      if (cleanSlots && cleanSlots.length > 0) {
        for (const s of cleanSlots) {
          const lockId = toCanonicalSlotLockId(s.date || updates.selectedDate || '', s.courtId, s.timeLabel);
          batch.delete(doc(db, 'court_slot_locks', lockId));
        }
      }
    }
  }

  try {
    await batch.commit();

    // Sync cache
    const currentCache = getInitialCachedBookings();
    if (currentCache.length > 0) {
      const updateMap = new Map(bookingUpdates.map((u) => [u.bookingId.trim(), u.updates]));
      const updatedCache = currentCache.map((b) => {
        const u = updateMap.get(b.bookingReference) || updateMap.get(b.id || '');
        if (u) {
          return {
            ...b,
            ...u,
            customer: {
              ...b.customer,
              ...(u.fullName ? { fullName: u.fullName } : {}),
              ...(u.phoneNumber ? { phoneNumber: u.phoneNumber } : {}),
              ...(u.notes !== undefined ? { notes: u.notes } : {}),
            },
          };
        }
        return b;
      });
      setCachedBookings(updatedCache);
    }
  } catch (err) {
    console.error('[MATCH&SIP] Batch update commit error:', err);
    handleFirestoreError(err, OperationType.WRITE, BOOKINGS_COLLECTION);
  }
}

/**
 * Real-time subscription to all court reservations in Cloud Firestore.
 * Automatically receives real-time updates whenever a new booking is confirmed.
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

  // 2. Query optimization: limit to active/recent reservations (default 250) instead of unbounded collection
  const maxLimit = options?.maxLimit ?? 250;
  const colRef = collection(db, BOOKINGS_COLLECTION);
  const q = query(colRef, limit(maxLimit));

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const items: ConfirmedBooking[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        let fallbackTimestamp = '';
        if (data.serverTimestamp) {
          try {
            fallbackTimestamp = typeof data.serverTimestamp.toDate === 'function'
              ? data.serverTimestamp.toDate().toISOString()
              : '';
          } catch {
            fallbackTimestamp = '';
          }
        }
        const confirmedAt = data.confirmedAt || data.createdAt || data.bookedAt || fallbackTimestamp || '';

        items.push({
          id: docSnap.id,
          bookingReference: data.bookingReference || docSnap.id,
          selectedDate: data.selectedDate,
          paymentMethod: data.paymentMethod || 'InstaPay QR',
          customer: {
            fullName: data.customer?.fullName || '',
            phoneNumber: data.customer?.phoneNumber || '',
            email: data.customer?.email || '',
            notes: data.customer?.notes || '',
          },
          slots: Array.isArray(data.slots) ? data.slots : [],
          totalAmount: Number(data.totalAmount) || 0,
          paymentProofUrl: data.paymentProofUrl || '',
          status: data.status || 'VERIFIED',
          confirmedAt: confirmedAt,
          createdAt: data.createdAt || confirmedAt,
          bookedAt: data.bookedAt || confirmedAt,
        });
      });
      setCachedBookings(items);
      onBookingsUpdated(items);
    },
    (err) => {
      console.warn('Firestore subscription fallback:', err);
      if (onError) onError(err);
    }
  );

  return unsubscribe;
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
  const bookingRef = doc(db, BOOKINGS_COLLECTION, bookingReference);
  return onSnapshot(
    bookingRef,
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null);
        return;
      }
      const data = snap.data();
      const confirmedAt = data.confirmedAt || data.createdAt || data.bookedAt || '';
      onUpdate({
        id: snap.id,
        bookingReference: data.bookingReference || snap.id,
        selectedDate: data.selectedDate,
        paymentMethod: data.paymentMethod || 'GCash (PayMongo)',
        customer: {
          fullName: data.customer?.fullName || '',
          phoneNumber: data.customer?.phoneNumber || '',
          email: data.customer?.email || '',
          notes: data.customer?.notes || '',
        },
        slots: Array.isArray(data.slots) ? data.slots : [],
        totalAmount: Number(data.totalAmount) || 0,
        paymentProofUrl: data.paymentProofUrl || '',
        status: data.status || 'PENDING',
        confirmedAt: confirmedAt,
        createdAt: data.createdAt || confirmedAt,
        paidAt: data.paidAt || '',
        paymentId: data.paymentId || '',
      });
    },
    (err) => {
      console.warn('Single booking subscription error:', err);
    }
  );
}
