import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { Resend } from 'resend';
import QRCode from 'qrcode';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import { getUsers, getOrCreateUser } from './src/db/users.ts';
import {
  getAllBookings,
  getBookingsByDate,
  getBookingByReference,
  saveBookingWithLocks,
  deleteBookingByReference,
  updateBookingFields,
} from './src/db/bookings.ts';
import {
  bookingsReadLimiter,
  bookingsWriteLimiter,
  duplicateBookingProtection,
} from './src/middleware/rateLimiter.ts';

dotenv.config({ override: true });

const app = express();
const PORT = 3000;
// Strictly lock admin notifications exclusively to danamieratan@gmail.com
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'danamieratan@gmail.com';

// Capture raw body for webhook HMAC-SHA256 signature verification
app.use(
  express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Lazy Resend client initialization with dynamic key tracking
let cachedApiKey = '';
let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return null;
  if (!resendClient || cachedApiKey !== key) {
    cachedApiKey = key;
    resendClient = new Resend(key);
  }
  return resendClient;
}

// Helper to mask API key for safe verification
function getMaskedKey(key?: string): string {
  if (!key) return 'none';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 5)}...${trimmed.slice(-4)}`;
}

/**
 * Shared Admin Notification Email Sender
 */
async function sendAdminNotification(booking: any) {
  try {
    const resend = getResendClient();
    if (!resend) {
      console.warn(
        `[MATCH&SIP] RESEND_API_KEY is not configured in environment. Skipping email dispatch to ${ADMIN_EMAIL}.`
      );
      return { success: false, skipped: true };
    }

    const {
      customer,
      slots = [],
      totalAmount,
      selectedDate,
      bookingReference,
      paymentMethod = 'GCash (PayMongo)',
      status = 'BOOKED',
    } = booking;

    const customerName = customer?.fullName || 'Guest Customer';
    const customerPhone = customer?.phoneNumber || 'Not provided';

    const formattedAmount =
      typeof totalAmount === 'number'
        ? `₱${totalAmount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`
        : `₱${totalAmount || '0.00'}`;

    const slotsListText = slots
      .map((s: any) => `• ${s.courtName || 'Court'} - ${s.timeLabel || ''} (₱${s.price || 0})`)
      .join('\n');

    const slotsHtmlRows = slots
      .map(
        (s: any) => `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">
          <td style="padding: 10px 14px; font-weight: 600; color: #FFFFFF;">${s.courtName || 'Court'}</td>
          <td style="padding: 10px 14px; color: #00C6FF; font-family: monospace;">${s.timeLabel || ''}</td>
          <td style="padding: 10px 14px; text-align: right; color: #FFFFFF; font-weight: bold;">₱${s.price || 0}</td>
        </tr>`
      )
      .join('');

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MATCH and SIP <onboarding@resend.dev>';

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Court Reservation Confirmed (GCash)</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 24px 0; background-color: #431E82; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #FFFFFF;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #5E2CB2; border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
        
        <!-- Header Banner -->
        <div style="background: linear-gradient(135deg, #00C6FF 0%, #0B63CE 100%); padding: 32px 28px 24px;">
          <div style="display: inline-block; background-color: #000000; color: #00C6FF; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; padding: 4px 12px; border-radius: 9999px; margin-bottom: 12px;">
            GCASH PAYMENT VERIFIED • ${status}
          </div>
          <h1 style="margin: 0; font-size: 26px; font-weight: 900; color: #FFFFFF; letter-spacing: -0.02em;">
            MATCH<span style="color: #ffd200;">&amp;</span>SIP
          </h1>
          <p style="margin: 6px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">
            A new automated GCash court reservation has been verified and permanently updated to <strong>BOOKED</strong> in Cloud Firestore.
          </p>
        </div>

        <!-- Reference Banner -->
        <div style="background-color: rgba(0, 198, 255, 0.08); padding: 18px 28px; border-bottom: 1px solid rgba(0, 198, 255, 0.2);">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td>
                <span style="font-size: 11px; text-transform: uppercase; color: #00C6FF; font-weight: 700; letter-spacing: 0.05em; display: block;">Reference Code</span>
                <span style="font-size: 20px; font-weight: 900; color: #FFFFFF; font-family: monospace; letter-spacing: 0.05em;">#${bookingReference}</span>
              </td>
              <td style="text-align: right;">
                <span style="font-size: 11px; text-transform: uppercase; color: rgba(255,255,255,0.6); font-weight: 700; display: block;">Date</span>
                <span style="font-size: 14px; font-weight: 700; color: #FFFFFF;">${selectedDate || 'Today'}</span>
              </td>
            </tr>
          </table>
        </div>

        <!-- Body Details -->
        <div style="padding: 28px;">
          <!-- Customer Info Box -->
          <div style="background-color: rgba(0,0,0,0.18); border-radius: 14px; border: 1px solid rgba(255,255,255,0.1); padding: 20px; margin-bottom: 24px;">
            <h3 style="margin: 0 0 14px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #00C6FF; font-weight: 800;">
              Customer Details
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.6); width: 35%;">Customer Name:</td>
                <td style="padding: 6px 0; color: #FFFFFF; font-weight: 700;">${customerName}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.6);">Phone Number:</td>
                <td style="padding: 6px 0; color: #00C6FF; font-weight: 700;">${customerPhone}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.6);">Payment Gateway:</td>
                <td style="padding: 6px 0; color: #00C6FF; font-weight: 700;">${paymentMethod}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: rgba(255,255,255,0.6);">Status:</td>
                <td style="padding: 6px 0; color: #10B981; font-weight: 800;">${status}</td>
              </tr>
            </table>
          </div>

          <!-- Reserved Slots Table -->
          <h3 style="margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #00C6FF; font-weight: 800;">
            Reserved Court Slots (${slots.length})
          </h3>
          <div style="background-color: rgba(0,0,0,0.18); border-radius: 14px; border: 1px solid rgba(255,255,255,0.1); overflow: hidden; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="background-color: rgba(255,255,255,0.06); text-align: left; font-size: 11px; text-transform: uppercase; color: rgba(255,255,255,0.5);">
                  <th style="padding: 10px 14px;">Court</th>
                  <th style="padding: 10px 14px;">Time</th>
                  <th style="padding: 10px 14px; text-align: right;">Rate</th>
                </tr>
              </thead>
              <tbody>
                ${slotsHtmlRows}
              </tbody>
            </table>
          </div>

          <!-- Total Price Highlight Box -->
          <div style="background: linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(94,44,178,0.4) 100%); border: 1px solid #00C6FF; border-radius: 14px; padding: 18px 22px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td>
                  <span style="font-size: 11px; text-transform: uppercase; color: rgba(255,255,255,0.7); font-weight: 800; letter-spacing: 0.08em; display: block;">
                    Total Amount Verified
                  </span>
                  <span style="font-size: 12px; color: #10B981; font-weight: 700;">Status: ${status}</span>
                </td>
                <td style="text-align: right; font-size: 26px; font-weight: 900; color: #FFFFFF; text-shadow: 0 2px 10px rgba(0,198,255,0.4);">
                  ${formattedAmount}
                </td>
              </tr>
            </table>
          </div>

        </div>

        <!-- Footer Note -->
        <div style="background-color: rgba(0,0,0,0.25); padding: 18px 28px; text-align: center; border-top: 1px solid rgba(255,255,255,0.1); font-size: 12px; color: rgba(255,255,255,0.5);">
          Automated Admin Notification · MATCH&SIP Court Management System
        </div>

      </div>
    </body>
    </html>
    `;

    const textContent = `
NEW GCASH BOOKING CONFIRMED - MATCH&SIP
=======================================
Reference Code: #${bookingReference}
Date: ${selectedDate || 'Today'}
Status: ${status}

CUSTOMER DETAILS:
- Name: ${customerName}
- Phone Number: ${customerPhone}
- Payment: ${paymentMethod}

RESERVED SLOTS:
${slotsListText}

TOTAL AMOUNT: ${formattedAmount}
`;

    const emailResponse = await resend.emails.send({
      from: fromEmail,
      to: ADMIN_EMAIL,
      subject: `🏸 GCash Payment Verified: #${bookingReference} - ${customerName}`,
      html: htmlContent,
      text: textContent,
    });

    console.log('[MATCH&SIP] Admin notification email sent successfully:', emailResponse);
    return { success: true, data: emailResponse };
  } catch (err) {
    console.error('[MATCH&SIP] Error in sendAdminNotification:', err);
    return { success: false, error: err };
  }
}

// API Health Check & Configuration Status
app.get('/api/health', (req, res) => {
  const currentKey = process.env.RESEND_API_KEY?.trim();
  const currentFrom = process.env.RESEND_FROM_EMAIL?.trim() || 'MATCH and SIP <onboarding@resend.dev>';
  const paymongoKey = process.env.PAYMONGO_SECRET_KEY?.trim();
  const webhookKey = process.env.PAYMONGO_WEBHOOK_SECRET_KEY?.trim();

  res.json({
    status: 'ok',
    resendConfigured: !!currentKey,
    activeSender: currentFrom,
    maskedApiKey: getMaskedKey(currentKey),
    paymongoConfigured: !!paymongoKey,
    maskedPaymongoKey: getMaskedKey(paymongoKey),
    webhookConfigured: !!webhookKey,
    adminEmail: ADMIN_EMAIL,
    timestamp: new Date().toISOString(),
  });
});

// Admin Booking Notification Endpoint
app.post('/api/notify-admin', async (req, res) => {
  try {
    const { booking } = req.body;
    if (!booking || !booking.bookingReference) {
      return res.status(400).json({ success: false, error: 'Invalid booking data provided.' });
    }

    const result = await sendAdminNotification(booking);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Cloud SQL & Firebase Auth User Endpoints
 */
app.get('/api/users', requireAuth, async (req: AuthRequest, res) => {
  try {
    const allUsers = await getUsers();
    res.json({ success: true, users: allUsers });
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch users' });
  }
});

app.post('/api/users/sync', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email || '';
    if (!uid) {
      return res.status(400).json({ error: 'User UID missing from token' });
    }
    const syncedUser = await getOrCreateUser(uid, email);
    res.json({ success: true, user: syncedUser });
  } catch (error: any) {
    console.error('Failed to sync user:', error);
    res.status(500).json({ error: error.message || 'Failed to sync user' });
  }
});

/**
 * Cloud SQL Bookings API
 */
app.get('/api/sql/bookings', bookingsReadLimiter(120, 60000), async (req, res) => {
  try {
    const limitCount = req.query.limit ? Number(req.query.limit) : 250;
    const date = req.query.date as string | undefined;
    let results;
    if (date) {
      results = await getBookingsByDate(date);
    } else {
      results = await getAllBookings(limitCount);
    }
    res.json({ success: true, bookings: results });
  } catch (error: any) {
    console.error('Failed to fetch bookings from Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch bookings' });
  }
});

app.get('/api/sql/bookings/:reference', bookingsReadLimiter(120, 60000), async (req, res) => {
  try {
    const { reference } = req.params;
    const booking = await getBookingByReference(reference);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ success: true, booking });
  } catch (error: any) {
    console.error('Failed to fetch booking from Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch booking' });
  }
});

app.post(
  '/api/sql/bookings',
  bookingsWriteLimiter(20, 60000),
  duplicateBookingProtection,
  async (req, res) => {
    try {
      const bookingInput = req.body;
      if (!bookingInput || !bookingInput.bookingReference || !bookingInput.selectedDate) {
        return res.status(400).json({ error: 'bookingReference and selectedDate are required' });
      }
      const result = await saveBookingWithLocks(bookingInput);
      res.json({ success: true, booking: result });
    } catch (error: any) {
      console.error('Failed to save booking to Cloud SQL:', error);
      const isConflict = error?.message?.includes('DOUBLE_BOOKING_PREVENTED');
      res.status(isConflict ? 409 : 500).json({ error: error.message || 'Failed to save booking' });
    }
  }
);

app.put('/api/sql/bookings/:reference', bookingsWriteLimiter(20, 60000), async (req, res) => {
  try {
    const { reference } = req.params;
    const updates = req.body;
    const updated = await updateBookingFields(reference, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ success: true, booking: updated });
  } catch (error: any) {
    console.error('Failed to update booking in Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to update booking' });
  }
});

app.delete('/api/sql/bookings/:reference', bookingsWriteLimiter(20, 60000), async (req, res) => {
  try {
    const { reference } = req.params;
    const deleted = await deleteBookingByReference(reference);
    res.json({ success: true, deletedBooking: deleted });
  } catch (error: any) {
    console.error('Failed to delete booking in Cloud SQL:', error);
    res.status(500).json({ error: error.message || 'Failed to delete booking' });
  }
});

/**
 * 1. CHECKOUT CREATION API (/api/create-checkout)
 * Integrates PayMongo Checkout Session or Source when user clicks BOOK RESERVATION.
 * Generates GCash checkout URL & dynamic QR code, and holds the booking in Firestore.
 */
app.post(
  '/api/create-checkout',
  bookingsWriteLimiter(20, 60000),
  duplicateBookingProtection,
  async (req, res) => {
  try {
    const { booking } = req.body;
    if (!booking || !booking.bookingReference || !booking.totalAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required booking parameters (bookingReference, totalAmount).',
      });
    }

    const {
      bookingReference,
      selectedDate,
      customer,
      slots = [],
      totalAmount,
    } = booking;

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
    const baseUrl =
      process.env.APP_URL?.replace(/\/$/, '') ||
      `${protocol}://${host}`;

    // Secure the reservation with initial status 'PENDING' in Cloud SQL
    try {
      await saveBookingWithLocks({
        bookingReference,
        selectedDate,
        paymentMethod: 'GCash (PayMongo)',
        customerName: customer?.fullName || 'Customer',
        customerPhone: customer?.phoneNumber || '',
        customerEmail: customer?.email || '',
        customerNotes: customer?.notes || '',
        slots: slots.map((s: any) => ({
          slotId: s.slotId,
          courtId: s.courtId,
          courtName: s.courtName,
          timeLabel: s.timeLabel,
          date: s.date || selectedDate,
          price: s.price,
        })),
        totalAmount: Number(totalAmount),
        status: 'PENDING',
      });
    } catch (sqlErr) {
      console.warn('[MATCH&SIP] Initial booking setup in Cloud SQL notice:', sqlErr);
    }

    const paymongoSecretKey = process.env.PAYMONGO_SECRET_KEY?.trim();

    // IF PayMongo Secret Key is configured, make real API call to PayMongo
    if (paymongoSecretKey) {
      try {
        console.log(`[MATCH&SIP] Creating PayMongo Checkout Session for #${bookingReference} (₱${totalAmount})`);
        
        // Build line items for PayMongo
        const lineItems = slots.length > 0
          ? slots.map((s: any) => ({
              name: `${s.courtName} (${s.timeLabel})`,
              amount: Math.round(Number(s.price) * 100), // amount in centavos
              currency: 'PHP',
              quantity: 1,
            }))
          : [
              {
                name: `MATCH&SIP Court Booking #${bookingReference}`,
                amount: Math.round(Number(totalAmount) * 100),
                currency: 'PHP',
                quantity: 1,
              },
            ];

        const paymongoPayload = {
          data: {
            attributes: {
              send_email_receipt: false,
              show_description: true,
              show_line_items: true,
              payment_method_types: ['gcash'],
              description: `MATCH&SIP Court Booking #${bookingReference} - ${selectedDate}`,
              line_items: lineItems,
              reference_number: bookingReference,
              success_url: `${baseUrl}/payment/success?reference=${bookingReference}&gateway=paymongo`,
              cancel_url: `${baseUrl}/?cancelled=true&reference=${bookingReference}`,
              metadata: {
                bookingReference,
                selectedDate,
                customerName: customer?.fullName,
                customerPhone: customer?.phoneNumber,
              },
            },
          },
        };

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(paymongoSecretKey + ':').toString('base64')}`,
          },
          body: JSON.stringify(paymongoPayload),
        });

        const paymongoData = await response.json();

        if (response.ok && paymongoData?.data?.attributes?.checkout_url) {
          const checkoutUrl = paymongoData.data.attributes.checkout_url;
          // Generate crisp dynamic QR code data URL
          const qrCodeUrl = await QRCode.toDataURL(checkoutUrl, {
            margin: 2,
            width: 320,
            color: { dark: '#000000', light: '#ffffff' },
          });

          return res.json({
            success: true,
            checkoutUrl,
            qrCodeUrl,
            bookingReference,
            provider: 'paymongo',
            isLive: true,
            sessionId: paymongoData.data.id,
          });
        } else {
          console.warn('[MATCH&SIP] PayMongo API returned error, falling back to simulated sandbox:', paymongoData);
        }
      } catch (paymongoErr) {
        console.error('[MATCH&SIP] PayMongo request exception:', paymongoErr);
      }
    }

    // High-fidelity fallback / Sandbox mode:
    // Generates a dedicated GCash authorization gateway checkout URL and dynamic QR code
    const checkoutPageUrl = `/checkout/gcash-pay?reference=${bookingReference}`;
    const fullCheckoutUrl = `${baseUrl}${checkoutPageUrl}`;
    const qrCodeUrl = await QRCode.toDataURL(fullCheckoutUrl, {
      margin: 2,
      width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });

    return res.json({
      success: true,
      checkoutUrl: checkoutPageUrl,
      fullCheckoutUrl,
      qrCodeUrl,
      bookingReference,
      provider: 'paymongo-sandbox',
      isLive: false,
      message: 'Checkout session created. Use QR code or button to complete GCash authorization.',
    });
  } catch (err: any) {
    console.error('[MATCH&SIP] Error in /api/create-checkout:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to create payment checkout session.',
    });
  }
});

/**
 * Helper to verify PayMongo Webhook Signature (HMAC-SHA256)
 */
function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secretKey: string
): boolean {
  if (!signatureHeader || !secretKey) return false;
  try {
    const parts = signatureHeader.split(',');
    let timestamp = '';
    let testSig = '';
    let liveSig = '';

    for (const part of parts) {
      const [key, val] = part.trim().split('=');
      if (key === 't') timestamp = val;
      if (key === 'te') testSig = val;
      if (key === 'li') liveSig = val;
    }

    if (!timestamp) return false;

    const signaturePayload = `${timestamp}.${rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', secretKey)
      .update(signaturePayload)
      .digest('hex');

    if (testSig && crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(testSig))) {
      return true;
    }
    if (liveSig && crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(liveSig))) {
      return true;
    }
    return false;
  } catch (err) {
    console.error('[MATCH&SIP] Webhook signature verification error:', err);
    return false;
  }
}

/**
 * 2. BACKEND WEBHOOK INTEGRATION (/api/webhooks/payment)
 * Receives real-time POST events from PayMongo (e.g. checkout_session.payment.paid, source.chargeable).
 * Verifies signature, updates booking in Firestore to 'BOOKED', and alerts admin.
 */
app.post('/api/webhooks/payment', async (req: any, res) => {
  try {
    const signatureHeader =
      (req.headers['paymongo-signature'] as string) ||
      (req.headers['Paymongo-Signature'] as string) ||
      '';
    const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET_KEY?.trim();

    // Verify event signature when webhook secret is provided
    if (webhookSecret) {
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const isValid = verifyWebhookSignature(rawBody, signatureHeader, webhookSecret);
      if (!isValid) {
        console.warn('[MATCH&SIP] Webhook signature verification failed.');
        return res.status(401).json({ error: 'Invalid webhook signature.' });
      }
      console.log('[MATCH&SIP] PayMongo webhook signature successfully verified.');
    } else {
      console.log('[MATCH&SIP] PAYMONGO_WEBHOOK_SECRET_KEY not set. Processing webhook payload.');
    }

    const payload = req.body;
    const eventType = payload?.data?.attributes?.type || payload?.type || 'payment.paid';
    console.log(`[MATCH&SIP] Processing payment webhook event: ${eventType}`);

    // Extract booking reference from diverse PayMongo payload shapes
    const eventData = payload?.data?.attributes?.data || payload?.data || {};
    const metadata =
      eventData?.attributes?.metadata ||
      payload?.data?.attributes?.metadata ||
      payload?.metadata ||
      {};

    let bookingReference =
      metadata?.bookingReference ||
      eventData?.attributes?.reference_number ||
      payload?.bookingReference ||
      '';

    // If still not found, check description for MS-XXXXXX
    if (!bookingReference) {
      const description =
        eventData?.attributes?.description || payload?.data?.attributes?.description || '';
      const match = description.match(/MS-\d{6}/);
      if (match) {
        bookingReference = match[0];
      }
    }

    if (!bookingReference) {
      console.warn('[MATCH&SIP] Webhook received but no booking reference found in payload.');
      return res.status(200).json({ received: true, note: 'No bookingReference identified' });
    }

    console.log(`[MATCH&SIP] Payment confirmed for booking reference: #${bookingReference}`);

    // Automatically update reservation status in Cloud SQL to 'BOOKED'
    await updateBookingFields(bookingReference, {
      status: 'BOOKED',
      paymentMethod: 'GCash (PayMongo)',
    });

    const bookingData = await getBookingByReference(bookingReference);
    if (bookingData) {
      await sendAdminNotification({
        bookingReference: bookingData.bookingReference,
        selectedDate: bookingData.selectedDate,
        totalAmount: bookingData.totalAmount,
        status: 'BOOKED',
        customer: {
          fullName: bookingData.customerName,
          phoneNumber: bookingData.customerPhone,
          email: bookingData.customerEmail,
        },
        slots: bookingData.slots,
      });
    }

    console.log(`[MATCH&SIP] Booking #${bookingReference} successfully updated to BOOKED in Cloud SQL.`);

    return res.status(200).json({
      received: true,
      status: 'BOOKED',
      bookingReference,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[MATCH&SIP] Error in /api/webhooks/payment:', err);
    return res.status(500).json({ error: err.message || 'Webhook processing failed.' });
  }
});

/**
 * 3. SIMULATE GCASH PAYMENT (For testing & sandbox instant approval)
 */
app.post('/api/payment/simulate-pay', async (req, res) => {
  try {
    const { bookingReference } = req.body;
    if (!bookingReference) {
      return res.status(400).json({ success: false, error: 'bookingReference is required.' });
    }

    console.log(`[MATCH&SIP] Simulating GCash payment approval for #${bookingReference}`);
    await updateBookingFields(bookingReference, {
      status: 'BOOKED',
      paymentMethod: 'GCash (PayMongo)',
    });

    const bookingData = await getBookingByReference(bookingReference);
    if (bookingData) {
      await sendAdminNotification({
        bookingReference: bookingData.bookingReference,
        selectedDate: bookingData.selectedDate,
        totalAmount: bookingData.totalAmount,
        status: 'BOOKED',
        customer: {
          fullName: bookingData.customerName,
          phoneNumber: bookingData.customerPhone,
          email: bookingData.customerEmail,
        },
        slots: bookingData.slots,
      });
    }

    return res.json({
      success: true,
      status: 'BOOKED',
      bookingReference,
      message: `Reservation #${bookingReference} status updated to BOOKED in Cloud SQL.`,
    });
  } catch (err: any) {
    console.error('[MATCH&SIP] Error simulating payment:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 4. GET BOOKING PAYMENT STATUS (/api/payment/status/:reference)
 */
app.get('/api/payment/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference parameter required' });
    }

    const booking = await getBookingByReference(reference);

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    return res.json({
      success: true,
      bookingReference: reference,
      status: booking.status || 'PENDING',
      isBooked: booking.status === 'BOOKED',
      totalAmount: booking.totalAmount,
      customer: {
        fullName: booking.customerName,
        phoneNumber: booking.customerPhone,
        email: booking.customerEmail || '',
        notes: booking.customerNotes || '',
      },
      selectedDate: booking.selectedDate,
      slots: booking.slots,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Direct Test Email Endpoint for Diagnostics
app.post('/api/test-email', async (req, res) => {
  try {
    const resend = getResendClient();
    if (!resend) {
      return res.status(400).json({
        success: false,
        error: 'RESEND_API_KEY is not configured in environment variables.',
      });
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MATCH and SIP <onboarding@resend.dev>';
    const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });

    const result = await resend.emails.send({
      from: fromEmail,
      to: ADMIN_EMAIL,
      subject: `🔔 MATCH&SIP Admin Notification Test (${now})`,
      html: `
        <div style="background-color: #5E2CB2; color: #ffffff; padding: 24px; border-radius: 16px; font-family: sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #00C6FF; margin-top: 0;">MATCH&SIP Test Email</h2>
          <p>This is a live test email confirming that your Resend automated booking notification system is working properly.</p>
          <div style="background: rgba(255,255,255,0.1); padding: 14px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Recipient:</strong> ${ADMIN_EMAIL}</p>
            <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${now}</p>
            <p style="margin: 4px 0;"><strong>Sender:</strong> ${fromEmail}</p>
          </div>
          <p style="font-size: 12px; color: #B3A2DB;">If you see this in your Spam or Junk folder, click <strong>"Not Spam"</strong> so future real-time customer booking alerts arrive straight to your Primary Inbox!</p>
        </div>
      `,
      text: `MATCH&SIP Test Email\n\nThis confirms your Resend integration is functioning.\nRecipient: ${ADMIN_EMAIL}\nTimestamp: ${now}`,
    });

    if (result.error) {
      console.error('[MATCH&SIP] Resend test email error:', result.error);
      return res.status(400).json({
        success: false,
        error: result.error.message,
        details: result.error,
      });
    }

    return res.json({
      success: true,
      message: `Test email sent successfully to ${ADMIN_EMAIL}`,
      data: result,
    });
  } catch (err: any) {
    console.error('[MATCH&SIP] Error sending test email:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to send test email',
    });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
