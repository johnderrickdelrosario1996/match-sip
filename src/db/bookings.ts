import { supabase, isSupabaseConfigured, isTableMissingError } from '../lib/supabase.ts';

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

let hasWarnedTableMissing = false;

function warnTableMissingOnce() {
  if (!hasWarnedTableMissing) {
    hasWarnedTableMissing = true;
    console.warn(
      `[Supabase Notice] Table 'public.bookings' or 'public.court_slot_locks' is not created in Supabase yet. ` +
      `Please execute 'supabase-schema.sql' in your Supabase SQL Editor. ` +
      `The app will operate smoothly in resilient mode in the meantime.`
    );
  }
}

/**
 * Normalizes a database row from Supabase (supporting both snake_case and camelCase)
 */
export function normalizeBookingRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    bookingReference: row.booking_reference ?? row.bookingReference ?? '',
    selectedDate: row.selected_date ?? row.selectedDate ?? '',
    paymentMethod: row.payment_method ?? row.paymentMethod ?? 'GCash (PayMongo)',
    customerName: row.customer_name ?? row.customerName ?? '',
    customerPhone: row.customer_phone ?? row.customerPhone ?? '',
    customerEmail: row.customer_email ?? row.customerEmail ?? '',
    customerNotes: row.customer_notes ?? row.customerNotes ?? '',
    slots: Array.isArray(row.slots)
      ? row.slots
      : typeof row.slots === 'string'
      ? (() => {
          try {
            return JSON.parse(row.slots);
          } catch {
            return [];
          }
        })()
      : [],
    totalAmount: Number(row.total_amount ?? row.totalAmount) || 0,
    paymentProofUrl: row.payment_proof_url ?? row.paymentProofUrl ?? '',
    status: row.status || 'BOOKED',
    confirmedAt: row.confirmed_at ?? row.confirmedAt ?? '',
    bookedAt: row.booked_at ?? row.bookedAt ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? '',
  };
}

/**
 * Fetch bookings from Supabase ordered by creation time descending
 */
export async function getAllBookings(limitCount = 250) {
  if (!isSupabaseConfigured) {
    return [];
  }

  try {
    let { data, error } = await supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limitCount);

    if (error && error.message.includes('created_at')) {
      const fallback = await supabase
        .from('bookings')
        .select('*')
        .limit(limitCount);
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isTableMissingError(error)) {
        warnTableMissingOnce();
        return [];
      }
      console.error('Failed to query bookings from Supabase:', error);
      throw new Error(error.message || 'Database query for bookings failed.');
    }

    return (data || []).map(normalizeBookingRow);
  } catch (error: any) {
    if (isTableMissingError(error)) {
      warnTableMissingOnce();
      return [];
    }
    console.error('Failed to query bookings from Supabase:', error);
    throw new Error('Database query for bookings failed. Please try again later.', { cause: error });
  }
}

/**
 * Fetch bookings for a specific reservation date using Supabase syntax
 */
export async function getBookingsByDate(selectedDate: string) {
  if (!isSupabaseConfigured) {
    return [];
  }

  try {
    let { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('selected_date', selectedDate);

    if (error && error.message.includes('selected_date')) {
      const fallback = await supabase
        .from('bookings')
        .select('*')
        .eq('selectedDate', selectedDate);
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isTableMissingError(error)) {
        warnTableMissingOnce();
        return [];
      }
      console.error('Failed to query bookings by date from Supabase:', error);
      throw new Error(error.message || 'Database query by date failed.');
    }

    return (data || []).map(normalizeBookingRow);
  } catch (error: any) {
    if (isTableMissingError(error)) {
      warnTableMissingOnce();
      return [];
    }
    console.error('Failed to query bookings by date from Supabase:', error);
    throw new Error('Database query by date failed.', { cause: error });
  }
}

/**
 * Fetch a single booking by bookingReference using Supabase syntax
 */
export async function getBookingByReference(bookingReference: string) {
  if (!isSupabaseConfigured) {
    return null;
  }

  try {
    let { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_reference', bookingReference)
      .maybeSingle();

    if (!data && (error?.message?.includes('booking_reference') || !error)) {
      const fallback = await supabase
        .from('bookings')
        .select('*')
        .eq('bookingReference', bookingReference)
        .maybeSingle();
      if (fallback.data) {
        data = fallback.data;
        error = null;
      }
    }

    if (error) {
      if (isTableMissingError(error)) {
        return null;
      }
      console.error('Failed to query booking by reference from Supabase:', error);
      throw new Error('Database query by booking reference failed.', { cause: error });
    }

    return data ? normalizeBookingRow(data) : null;
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return null;
    }
    console.error('Failed to query booking by reference from Supabase:', error);
    throw new Error('Database query by booking reference failed.', { cause: error });
  }
}

/**
 * Create or save a confirmed booking with atomic slot locks using Supabase syntax
 */
export async function saveBookingWithLocks(bookingData: BookingInput) {
  const now = new Date();
  const nowIso = now.toISOString();

  if (!isSupabaseConfigured) {
    return normalizeBookingRow(bookingData);
  }

  try {
    // 1. Verify and create locks for each slot to prevent double bookings
    for (const slot of bookingData.slots) {
      const timeLabel = slot.timeLabel || '';
      const match = timeLabel.match(/(\d{1,2}):(\d{2})/);
      const timeKey = match ? `${match[1].padStart(2, '0')}${match[2]}` : '0800';
      const cleanCourt = (slot.courtId || 'court-1').toLowerCase().trim();
      const dateStr = (slot.date || bookingData.selectedDate || '').trim();
      const lockId = `${dateStr}_${cleanCourt}_${timeKey}`;

      // Check if an active slot lock already exists in Supabase
      const { data: existingLocks, error: lockCheckErr } = await supabase
        .from('court_slot_locks')
        .select('*')
        .eq('lock_id', lockId)
        .eq('status', 'BOOKED');

      if (!lockCheckErr && existingLocks && existingLocks.length > 0) {
        const lockRef = existingLocks[0].booking_reference ?? existingLocks[0].bookingReference;
        if (lockRef && lockRef !== bookingData.bookingReference) {
          throw new Error(
            `DOUBLE_BOOKING_PREVENTED: Slot "${slot.courtName || 'Court'} (${slot.timeLabel || ''})" was just booked by another player (#${lockRef}).`
          );
        }
      }

      // Upsert slot lock via Supabase
      const lockPayload = {
        lock_id: lockId,
        booking_reference: bookingData.bookingReference,
        customer_name: bookingData.customerName,
        date: dateStr,
        court_id: slot.courtId || 'court-1',
        court_name: slot.courtName || '',
        time_label: slot.timeLabel || '',
        status: 'BOOKED',
        locked_at: nowIso,
      };

      const { error: lockUpsertErr } = await supabase
        .from('court_slot_locks')
        .upsert(lockPayload, { onConflict: 'lock_id' });

      if (lockUpsertErr && !isTableMissingError(lockUpsertErr)) {
        console.warn('Court slot lock upsert notice:', lockUpsertErr);
      }
    }

    // 2. Insert or update the booking record in Supabase
    const bookingPayload = {
      booking_reference: bookingData.bookingReference,
      selected_date: bookingData.selectedDate,
      payment_method: bookingData.paymentMethod || 'GCash (PayMongo)',
      customer_name: bookingData.customerName,
      customer_phone: bookingData.customerPhone,
      customer_email: bookingData.customerEmail || '',
      customer_notes: bookingData.customerNotes || '',
      slots: bookingData.slots,
      total_amount: Number(bookingData.totalAmount) || 0,
      payment_proof_url: bookingData.paymentProofUrl || '',
      status: bookingData.status || 'BOOKED',
      confirmed_at: bookingData.confirmedAt || nowIso,
      booked_at: bookingData.bookedAt || nowIso,
      updated_at: nowIso,
    };

    let { data, error } = await supabase
      .from('bookings')
      .upsert(bookingPayload, { onConflict: 'booking_reference' })
      .select()
      .maybeSingle();

    if (error && error.message.includes('booking_reference')) {
      // Retry with camelCase keys if table was defined with camelCase
      const camelPayload = {
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
        updatedAt: nowIso,
      };
      const fallback = await supabase
        .from('bookings')
        .upsert(camelPayload, { onConflict: 'bookingReference' })
        .select()
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isTableMissingError(error)) {
        warnTableMissingOnce();
        return normalizeBookingRow(bookingPayload);
      }
      console.error('Failed to save booking to Supabase:', error);
      throw new Error(error.message || 'Database insert for booking failed.');
    }

    return normalizeBookingRow(data || bookingPayload);
  } catch (error: any) {
    if (error?.message && error.message.includes('DOUBLE_BOOKING_PREVENTED')) {
      throw error;
    }
    if (isTableMissingError(error)) {
      warnTableMissingOnce();
      return normalizeBookingRow(bookingData);
    }
    console.error('Failed to save booking to Supabase:', error);
    throw new Error(error.message || 'Database operation for booking failed.', { cause: error });
  }
}

/**
 * Delete a booking and release its slot locks from Supabase
 */
export async function deleteBookingByReference(bookingReference: string) {
  if (!isSupabaseConfigured) {
    return { bookingReference };
  }

  try {
    // 1. Release or delete slot locks
    await supabase
      .from('court_slot_locks')
      .delete()
      .eq('booking_reference', bookingReference);

    // 2. Delete the booking from Supabase
    let { data, error } = await supabase
      .from('bookings')
      .delete()
      .eq('booking_reference', bookingReference)
      .select();

    if (error && error.message.includes('booking_reference')) {
      const fallback = await supabase
        .from('bookings')
        .delete()
        .eq('bookingReference', bookingReference)
        .select();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isTableMissingError(error)) {
        return { bookingReference };
      }
      console.error('Failed to delete booking from Supabase:', error);
      throw new Error(error.message || 'Database deletion failed.');
    }

    return data && data[0] ? normalizeBookingRow(data[0]) : { bookingReference };
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return { bookingReference };
    }
    console.error('Failed to delete booking from Supabase:', error);
    throw new Error('Database deletion failed.', { cause: error });
  }
}

/**
 * Update an existing booking in Supabase
 */
export async function updateBookingFields(
  bookingReference: string,
  updates: Partial<BookingInput>
) {
  if (!isSupabaseConfigured) {
    return { bookingReference, ...updates };
  }

  try {
    const nowIso = new Date().toISOString();
    const updatePayload: Record<string, any> = {
      updated_at: nowIso,
    };

    if (updates.selectedDate !== undefined) updatePayload.selected_date = updates.selectedDate;
    if (updates.customerName !== undefined) updatePayload.customer_name = updates.customerName;
    if (updates.customerPhone !== undefined) updatePayload.customer_phone = updates.customerPhone;
    if (updates.customerEmail !== undefined) updatePayload.customer_email = updates.customerEmail;
    if (updates.customerNotes !== undefined) updatePayload.customer_notes = updates.customerNotes;
    if (updates.totalAmount !== undefined) updatePayload.total_amount = updates.totalAmount;
    if (updates.status !== undefined) updatePayload.status = updates.status;
    if (updates.slots !== undefined) updatePayload.slots = updates.slots;
    if (updates.paymentProofUrl !== undefined) updatePayload.payment_proof_url = updates.paymentProofUrl;

    let { data, error } = await supabase
      .from('bookings')
      .update(updatePayload)
      .eq('booking_reference', bookingReference)
      .select()
      .maybeSingle();

    if (error && error.message.includes('booking_reference')) {
      const camelPayload: Record<string, any> = {
        updatedAt: nowIso,
      };
      if (updates.selectedDate !== undefined) camelPayload.selectedDate = updates.selectedDate;
      if (updates.customerName !== undefined) camelPayload.customerName = updates.customerName;
      if (updates.customerPhone !== undefined) camelPayload.customerPhone = updates.customerPhone;
      if (updates.customerEmail !== undefined) camelPayload.customerEmail = updates.customerEmail;
      if (updates.customerNotes !== undefined) camelPayload.customerNotes = updates.customerNotes;
      if (updates.totalAmount !== undefined) camelPayload.totalAmount = updates.totalAmount;
      if (updates.status !== undefined) camelPayload.status = updates.status;
      if (updates.slots !== undefined) camelPayload.slots = updates.slots;
      if (updates.paymentProofUrl !== undefined) camelPayload.paymentProofUrl = updates.paymentProofUrl;

      const fallback = await supabase
        .from('bookings')
        .update(camelPayload)
        .eq('bookingReference', bookingReference)
        .select()
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isTableMissingError(error)) {
        return { bookingReference, ...updates };
      }
      console.error('Failed to update booking in Supabase:', error);
      throw new Error(error.message || 'Database update failed.');
    }

    // If status is CANCELLED or REJECTED, release slot locks
    if (updates.status === 'CANCELLED' || updates.status === 'REJECTED') {
      await supabase
        .from('court_slot_locks')
        .update({ status: 'RELEASED' })
        .eq('booking_reference', bookingReference);
    }

    return data ? normalizeBookingRow(data) : { bookingReference, ...updates };
  } catch (error: any) {
    if (isTableMissingError(error)) {
      return { bookingReference, ...updates };
    }
    console.error('Failed to update booking in Supabase:', error);
    throw new Error('Database update failed.', { cause: error });
  }
}
