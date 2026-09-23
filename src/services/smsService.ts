import { ConfirmedBooking } from '../types';

export const ADMIN_SMS_RECIPIENT = '+639175012200';
export const SEMAPHORE_API_URL = 'https://api.semaphore.co/api/v4/messages';

/**
 * Formats the SMS text payload exactly as requested:
 * "NEW MATCH&SIP BOOKING! Ref: #[bookingReference] | Player: [customerName] ([customerPhone]) | Date: [bookingDate] | Total: ₱[totalAmount]"
 */
export function formatBookingSmsMessage(booking: ConfirmedBooking): string {
  const customerName = booking.customer?.fullName || 'Guest Player';
  const customerPhone = booking.customer?.phoneNumber || 'N/A';
  const bookingDate = booking.selectedDate;
  const bookingReference = booking.bookingReference;
  const totalAmount = booking.totalAmount;

  return `NEW MATCH&SIP BOOKING! Ref: #${bookingReference} | Player: ${customerName} (${customerPhone}) | Date: ${bookingDate} | Total: ₱${totalAmount}`;
}

/**
 * Dispatches an automated SMS notification to the admin recipient on new court bookings.
 *
 * Fail-Safe Handler:
 * Wrapped inside a comprehensive try/catch block so that even if the text message
 * send fails (e.g., missing API key, network error, CORS, or Semaphore downtime),
 * the customer's booking reservation in Cloud Firestore still completes successfully
 * without throwing an error to the user.
 */
export async function sendAdminBookingSms(
  booking: ConfirmedBooking
): Promise<{ success: boolean; message?: string; error?: string; data?: unknown }> {
  try {
    const textMessage = formatBookingSmsMessage(booking);
    const recipient = ADMIN_SMS_RECIPIENT;

    // 1. Try sending via full-stack server proxy endpoint (/api/send-sms)
    // to protect the API key and ensure clean server-to-server delivery without CORS
    try {
      const serverResponse = await fetch('/api/send-sms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient,
          message: textMessage,
          bookingReference: booking.bookingReference,
        }),
      });

      if (serverResponse.ok) {
        const data = await serverResponse.json();
        console.log('[SMS Service] Admin booking SMS dispatched via server proxy:', data);
        return { success: true, data };
      }
    } catch (serverErr) {
      console.warn('[SMS Service] Server proxy unreachable, attempting fallback:', serverErr);
    }

    // 2. Direct fallback call to Semaphore API using fetch
    const apiKey =
      (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SEMAPHORE_API_KEY ||
      (import.meta as unknown as { env?: Record<string, string> }).env?.SEMAPHORE_API_KEY ||
      '';

    if (!apiKey) {
      console.info(
        '[SMS Service] SEMAPHORE_API_KEY not configured. Admin SMS logged safely. Payload:',
        textMessage
      );
      return {
        success: false,
        message: 'SEMAPHORE_API_KEY is not configured in .env',
      };
    }

    const directResponse = await fetch(SEMAPHORE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apikey: apiKey,
        number: recipient,
        message: textMessage,
      }),
    });

    const result = await directResponse.json().catch(() => ({}));
    console.log('[SMS Service] Direct Semaphore API response:', result);
    return { success: directResponse.ok, data: result };
  } catch (err: unknown) {
    // Fail-Safe Handler: Log warning, never throw to user
    console.warn(
      '[SMS Service] Fail-safe caught SMS dispatch error (booking remains unaffected):',
      err instanceof Error ? err.message : err
    );
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown SMS dispatch error',
    };
  }
}
