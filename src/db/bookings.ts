import { eq, desc, and, or } from 'drizzle-orm';
import { db } from './index.ts';
import { bookings, courtSlotLocks } from './schema.ts';

export interface BookingInput {
  bookingReference: string;
  selectedDate: string;
  paymentMethod?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerNotes?: string;
  slots: any[];
  totalAmount: number;
  paymentProofUrl?: string;
  status?: string;
  confirmedAt?: string;
  bookedAt?: string;
}

/**
 * Fetch bookings from Cloud SQL ordered by creation time descending
 */
export async function getAllBookings(limitCount = 250) {
  try {
    return await db
      .select()
      .from(bookings)
      .orderBy(desc(bookings.createdAt))
      .limit(limitCount);
  } catch (error) {
    console.error('Failed to query bookings from Cloud SQL:', error);
    throw new Error('Database query for bookings failed. Please try again later.', { cause: error });
  }
}

/**
 * Fetch bookings for a specific reservation date
 */
export async function getBookingsByDate(selectedDate: string) {
  try {
    return await db
      .select()
      .from(bookings)
      .where(eq(bookings.selectedDate, selectedDate));
  } catch (error) {
    console.error('Failed to query bookings by date from Cloud SQL:', error);
    throw new Error('Database query by date failed.', { cause: error });
  }
}

/**
 * Fetch a single booking by bookingReference
 */
export async function getBookingByReference(bookingReference: string) {
  try {
    const results = await db
      .select()
      .from(bookings)
      .where(eq(bookings.bookingReference, bookingReference))
      .limit(1);
    return results[0] || null;
  } catch (error) {
    console.error('Failed to query booking by reference from Cloud SQL:', error);
    throw new Error('Database query by booking reference failed.', { cause: error });
  }
}

/**
 * Create or save a confirmed booking atomically with slot locks in Cloud SQL
 */
export async function saveBookingWithLocks(bookingData: BookingInput) {
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    return await db.transaction(async (tx) => {
      // 1. Verify and create locks for each slot
      for (const slot of bookingData.slots) {
        const timeLabel = slot.timeLabel || '';
        const match = timeLabel.match(/(\d{1,2}):(\d{2})/);
        const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '0800';
        const cleanCourt = (slot.courtId || 'court-1').toLowerCase().trim();
        const dateStr = (slot.date || bookingData.selectedDate || '').trim();
        const lockId = `${dateStr}_${cleanCourt}_${timeKey}`;

        // Check if active lock exists
        const existingLocks = await tx
          .select()
          .from(courtSlotLocks)
          .where(and(eq(courtSlotLocks.lockId, lockId), eq(courtSlotLocks.status, 'BOOKED')));

        if (existingLocks.length > 0 && existingLocks[0].bookingReference !== bookingData.bookingReference) {
          throw new Error(
            `DOUBLE_BOOKING_PREVENTED: Slot "${slot.courtName} (${slot.timeLabel})" was just booked by another player (#${existingLocks[0].bookingReference}).`
          );
        }

        // Upsert lock
        await tx
          .insert(courtSlotLocks)
          .values({
            lockId,
            bookingReference: bookingData.bookingReference,
            customerName: bookingData.customerName,
            date: dateStr,
            courtId: slot.courtId || 'court-1',
            courtName: slot.courtName || '',
            timeLabel: slot.timeLabel || '',
            status: 'BOOKED',
            lockedAt: nowIso,
          })
          .onConflictDoUpdate({
            target: courtSlotLocks.lockId,
            set: {
              bookingReference: bookingData.bookingReference,
              customerName: bookingData.customerName,
              status: 'BOOKED',
              lockedAt: nowIso,
            },
          });
      }

      // 2. Insert or update the booking record
      const result = await tx
        .insert(bookings)
        .values({
          bookingReference: bookingData.bookingReference,
          selectedDate: bookingData.selectedDate,
          paymentMethod: bookingData.paymentMethod || 'GCash (PayMongo)',
          customerName: bookingData.customerName,
          customerPhone: bookingData.customerPhone,
          customerEmail: bookingData.customerEmail || '',
          customerNotes: bookingData.customerNotes || '',
          slots: bookingData.slots,
          totalAmount: Number(bookingData.totalAmount) || 0,
          paymentProofUrl: bookingData.paymentProofUrl || '',
          status: bookingData.status || 'BOOKED',
          confirmedAt: bookingData.confirmedAt || nowIso,
          bookedAt: bookingData.bookedAt || nowIso,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: bookings.bookingReference,
          set: {
            selectedDate: bookingData.selectedDate,
            customerName: bookingData.customerName,
            customerPhone: bookingData.customerPhone,
            customerEmail: bookingData.customerEmail || '',
            customerNotes: bookingData.customerNotes || '',
            slots: bookingData.slots,
            totalAmount: Number(bookingData.totalAmount) || 0,
            paymentProofUrl: bookingData.paymentProofUrl || '',
            status: bookingData.status || 'BOOKED',
            updatedAt: now,
          },
        })
        .returning();

      return result[0];
    });
  } catch (error: any) {
    if (error?.message && error.message.includes('DOUBLE_BOOKING_PREVENTED')) {
      throw error;
    }
    console.error('Failed to save booking to Cloud SQL:', error);
    throw new Error('Database transaction for booking failed.', { cause: error });
  }
}

/**
 * Delete a booking and release its slot locks from Cloud SQL
 */
export async function deleteBookingByReference(bookingReference: string) {
  try {
    return await db.transaction(async (tx) => {
      const isNum = !isNaN(Number(bookingReference)) && Number(bookingReference) > 0;
      const found = await tx
        .select()
        .from(bookings)
        .where(
          isNum
            ? or(eq(bookings.bookingReference, bookingReference), eq(bookings.id, Number(bookingReference)))
            : eq(bookings.bookingReference, bookingReference)
        )
        .limit(1);

      const actualRef = found[0]?.bookingReference || bookingReference;

      // Release or delete slot locks
      await tx
        .delete(courtSlotLocks)
        .where(eq(courtSlotLocks.bookingReference, actualRef));

      // Delete booking
      const deleted = await tx
        .delete(bookings)
        .where(eq(bookings.bookingReference, actualRef))
        .returning();

      return deleted[0] || null;
    });
  } catch (error) {
    console.error('Failed to delete booking from Cloud SQL:', error);
    throw new Error('Database deletion failed.', { cause: error });
  }
}

/**
 * Update an existing booking in Cloud SQL
 */
export async function updateBookingFields(
  bookingReference: string,
  updates: Partial<BookingInput>
) {
  try {
    const updatePayload: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (updates.selectedDate !== undefined) updatePayload.selectedDate = updates.selectedDate;
    if (updates.customerName !== undefined) updatePayload.customerName = updates.customerName;
    if (updates.customerPhone !== undefined) updatePayload.customerPhone = updates.customerPhone;
    if (updates.customerEmail !== undefined) updatePayload.customerEmail = updates.customerEmail;
    if (updates.customerNotes !== undefined) updatePayload.customerNotes = updates.customerNotes;
    if (updates.totalAmount !== undefined) updatePayload.totalAmount = updates.totalAmount;
    if (updates.status !== undefined) updatePayload.status = updates.status;
    if (updates.slots !== undefined) updatePayload.slots = updates.slots;
    if (updates.paymentProofUrl !== undefined) updatePayload.paymentProofUrl = updates.paymentProofUrl;

    const updated = await db
      .update(bookings)
      .set(updatePayload)
      .where(eq(bookings.bookingReference, bookingReference))
      .returning();

    // If status is CANCELLED, release slot locks
    if (updates.status === 'CANCELLED' || updates.status === 'REJECTED') {
      await db
        .update(courtSlotLocks)
        .set({ status: 'RELEASED' })
        .where(eq(courtSlotLocks.bookingReference, bookingReference));
    }

    return updated[0] || null;
  } catch (error) {
    console.error('Failed to update booking in Cloud SQL:', error);
    throw new Error('Database update failed.', { cause: error });
  }
}
