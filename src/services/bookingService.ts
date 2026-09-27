import { 
  collection, 
  doc, 
  setDoc, 
  updateDoc,
  deleteDoc,
  onSnapshot, 
  serverTimestamp 
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { ConfirmedBooking, SelectedSlot } from '../types';

const BOOKINGS_COLLECTION = 'bookings';

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
 * Save a new confirmed court reservation to Cloud Firestore and dispatch automated email alert to admin.
 */
export async function saveBookingToFirestore(booking: ConfirmedBooking): Promise<void> {
  const bookingRef = doc(db, BOOKINGS_COLLECTION, booking.bookingReference);
  
  await setDoc(bookingRef, {
    bookingReference: booking.bookingReference,
    selectedDate: booking.selectedDate,
    paymentMethod: booking.paymentMethod || 'GCash (PayMongo)',
    customer: {
      fullName: booking.customer.fullName,
      phoneNumber: booking.customer.phoneNumber,
      email: booking.customer.email || '',
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
    createdAt: booking.createdAt || new Date().toISOString(),
    serverTimestamp: serverTimestamp(),
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
}

/**
 * Delete a booking from Cloud Firestore.
 */
export async function deleteBookingFromFirestore(bookingId: string): Promise<void> {
  if (!bookingId) throw new Error('Missing booking ID for deletion');
  const bookingRef = doc(db, BOOKINGS_COLLECTION, bookingId);
  await deleteDoc(bookingRef);
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
 * Update an existing booking in Cloud Firestore.
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

  const payload: Record<string, any> = {
    updatedAt: new Date().toISOString(),
  };

  if (updates.selectedDate !== undefined) payload.selectedDate = updates.selectedDate.trim();
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.totalAmount !== undefined) payload.totalAmount = Number(updates.totalAmount) || 0;
  if (cleanSlots !== undefined) payload.slots = cleanSlots;

  if (updates.fullName !== undefined) payload['customer.fullName'] = updates.fullName.trim();
  if (updates.phoneNumber !== undefined) payload['customer.phoneNumber'] = updates.phoneNumber.trim();
  if (updates.notes !== undefined) payload['customer.notes'] = (updates.notes || '').trim();

  try {
    await updateDoc(bookingRef, payload);
  } catch (err: any) {
    console.warn(`[MATCH&SIP] updateDoc failed on ${cleanId}, falling back to setDoc({ merge: true }):`, err);

    // Fallback: build nested object representation for setDoc merge
    const mergePayload: Record<string, any> = {
      updatedAt: payload.updatedAt,
    };
    if (payload.selectedDate !== undefined) mergePayload.selectedDate = payload.selectedDate;
    if (payload.status !== undefined) mergePayload.status = payload.status;
    if (payload.totalAmount !== undefined) mergePayload.totalAmount = payload.totalAmount;
    if (payload.slots !== undefined) mergePayload.slots = payload.slots;

    const customerObj: Record<string, any> = {};
    if (updates.fullName !== undefined) customerObj.fullName = updates.fullName.trim();
    if (updates.phoneNumber !== undefined) customerObj.phoneNumber = updates.phoneNumber.trim();
    if (updates.notes !== undefined) customerObj.notes = (updates.notes || '').trim();
    if (Object.keys(customerObj).length > 0) {
      mergePayload.customer = customerObj;
    }

    await setDoc(bookingRef, mergePayload, { merge: true });
  }
}

/**
 * Real-time subscription to all court reservations in Cloud Firestore.
 * Automatically receives real-time updates whenever a new booking is confirmed.
 */
export function subscribeToBookings(
  onBookingsUpdated: (bookings: ConfirmedBooking[]) => void,
  onError?: (err: Error) => void
): () => void {
  const colRef = collection(db, BOOKINGS_COLLECTION);

  const unsubscribe = onSnapshot(
    colRef,
    (snapshot) => {
      const items: ConfirmedBooking[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
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
          createdAt: data.createdAt || '',
        });
      });
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
        createdAt: data.createdAt || '',
        paidAt: data.paidAt || '',
        paymentId: data.paymentId || '',
      });
    },
    (err) => {
      console.warn('Single booking subscription error:', err);
    }
  );
}
