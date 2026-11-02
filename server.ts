import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { Resend } from 'resend';
import { getMaintenanceStatus, setMaintenanceStatus } from './src/db/settings.ts';
import {
  getAllBookings,
  getBookingsByDate,
  getBookingByReference,
  saveBookingWithLocks,
  deleteBookingByReference,
  updateBookingFields,
  holdSlotsWithTtl,
  releaseSlotHold,
} from './src/db/bookings.ts';
import {
  recordAnalyticsEvent,
  getAnalyticsLogs,
  purgeOldAnalyticsLogs,
  deleteAnalyticsLogById,
} from './src/db/analytics.ts';
import {
  duplicateBookingProtection,
  bookingsReadLimiter,
  bookingsWriteLimiter,
} from './src/middleware/rateLimiter.ts';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ADMIN_PIN = '0912';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'danamieratan@gmail.com';
const BUILD_TIME = Date.now();

// Resend Email Client
function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

// Global Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust reverse proxy (Cloud Run, load balancers)
app.set('trust proxy', 1);

// Active Server-Sent Events (SSE) connections for instant maintenance status synchronization
const sseClients = new Set<Response>();

function broadcastMaintenanceStatus(maintenanceMode: boolean, message?: string) {
  const payload = `data: ${JSON.stringify({
    maintenanceMode,
    message: message || '',
    timestamp: Date.now(),
  })}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// -------------------------------------------------------------
// 1. SYSTEM STATUS & MAINTENANCE API (Dual-Layer Server-Side Guard)
// -------------------------------------------------------------

/**
 * Public lightweight status endpoint.
 * Returns current maintenance mode state and message.
 */
app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const status = await getMaintenanceStatus();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.json({
      success: true,
      maintenanceMode: status.enabled,
      message: status.message,
      updatedAt: status.updatedAt,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      maintenanceMode: false,
      error: err.message || 'Failed to query system status',
    });
  }
});

/**
 * Real-Time SSE Stream for instant lockout / restoration across all connected devices.
 */
app.get('/api/status/stream', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sseClients.add(res);

  // Send current state immediately on connect
  try {
    const status = await getMaintenanceStatus();
    res.write(
      `data: ${JSON.stringify({
        maintenanceMode: status.enabled,
        message: status.message,
        timestamp: Date.now(),
      })}\n\n`
    );
  } catch {
    res.write(
      `data: ${JSON.stringify({
        maintenanceMode: false,
        timestamp: Date.now(),
      })}\n\n`
    );
  }

  // Heartbeat ping every 25 seconds to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/**
 * Toggle maintenance mode (requires Admin PIN 0912 and confirmation phrase CONFIRM).
 */
app.post('/api/maintenance/toggle', async (req: Request, res: Response) => {
  try {
    const { enabled, pin, confirmation, message } = req.body || {};
    const headerPin = req.headers['x-admin-pin'] as string;
    const providedPin = (pin || headerPin || '').trim();
    const providedConfirm = (confirmation || '').trim().toUpperCase();

    // 1. PIN verification
    if (providedPin !== ADMIN_PIN) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid Admin PIN code.',
      });
    }

    // 2. Explicit confirmation verification
    if (providedConfirm !== 'CONFIRM') {
      return res.status(400).json({
        success: false,
        error: 'Confirmation phrase "CONFIRM" is required to toggle maintenance mode.',
      });
    }

    const targetEnabled = Boolean(enabled);
    const updated = await setMaintenanceStatus(targetEnabled, message);

    // Broadcast instant update to all connected SSE browser tabs & devices
    broadcastMaintenanceStatus(updated.enabled, updated.message);

    console.log(
      `[MAINTENANCE] Maintenance mode toggled to: ${updated.enabled} at ${updated.updatedAt}`
    );

    return res.json({
      success: true,
      maintenanceMode: updated.enabled,
      message: updated.message,
      updatedAt: updated.updatedAt,
    });
  } catch (err: any) {
    console.error('[MAINTENANCE] Error toggling maintenance mode:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to update maintenance state',
    });
  }
});

// Middleware to strictly reject any booking / hold actions when maintenance mode is active
const enforceMaintenanceBlock = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getMaintenanceStatus();
    if (status.enabled) {
      return res.status(503).json({
        success: false,
        maintenanceMode: true,
        error:
          status.message ||
          'MATCH & SIP is currently under maintenance. Online court reservations are temporarily paused.',
      });
    }
    next();
  } catch {
    next();
  }
};

// -------------------------------------------------------------
// 2. BOOKINGS & SLOT LOCKS API
// -------------------------------------------------------------

/**
 * Fetch bookings (filtered by date or limit)
 */
app.get('/api/bookings', bookingsReadLimiter(180, 60000), async (req: Request, res: Response) => {
  try {
    const { date, limit } = req.query;
    if (typeof date === 'string' && date.trim()) {
      const bookings = await getBookingsByDate(date.trim());
      return res.json({ success: true, bookings });
    }

    const limitNum = typeof limit === 'string' ? parseInt(limit, 10) : 250;
    const bookings = await getAllBookings(isNaN(limitNum) ? 250 : limitNum);
    return res.json({ success: true, bookings });
  } catch (err: any) {
    console.error('[API] Error fetching bookings:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to query bookings',
    });
  }
});

/**
 * Save new confirmed booking with database-level concurrency locks
 */
app.post(
  '/api/bookings',
  enforceMaintenanceBlock,
  duplicateBookingProtection,
  bookingsWriteLimiter(30, 60000),
  async (req: Request, res: Response) => {
    try {
      const bookingData = req.body;
      if (!bookingData || !bookingData.bookingReference) {
        return res.status(400).json({
          success: false,
          error: 'Missing required booking data or booking reference.',
        });
      }

      const saved = await saveBookingWithLocks(bookingData);
      return res.json({
        success: true,
        booking: saved,
      });
    } catch (err: any) {
      const msg = err.message || '';
      if (
        msg.includes('DOUBLE_BOOKING_PREVENTED') ||
        msg.includes('SLOT_HELD_IN_PROGRESS') ||
        msg.includes('Slot conflict')
      ) {
        return res.status(409).json({
          success: false,
          error: msg,
        });
      }

      console.error('[API] Error saving booking:', err);
      return res.status(500).json({
        success: false,
        error: msg || 'Failed to save booking to database.',
      });
    }
  }
);

/**
 * Update an existing booking
 */
app.put('/api/bookings/:id', bookingsWriteLimiter(40, 60000), async (req: Request, res: Response) => {
  try {
    const bookingRef = req.params.id;
    const updates = req.body;
    const updated = await updateBookingFields(bookingRef, updates);
    return res.json({ success: true, booking: updated });
  } catch (err: any) {
    console.error('[API] Error updating booking:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to update booking',
    });
  }
});

/**
 * Delete a booking and release its slot locks
 */
app.delete('/api/bookings/:id', bookingsWriteLimiter(40, 60000), async (req: Request, res: Response) => {
  try {
    const bookingRef = req.params.id;
    const deleted = await deleteBookingByReference(bookingRef);
    return res.json({ success: true, booking: deleted });
  } catch (err: any) {
    console.error('[API] Error deleting booking:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to delete booking',
    });
  }
});

/**
 * Hold court slots with TTL (5-minute hold during checkout)
 */
app.post('/api/slots/hold', enforceMaintenanceBlock, async (req: Request, res: Response) => {
  try {
    const { bookingReference, selectedDate, slots, customerName, ttlSeconds } = req.body || {};
    if (!bookingReference || !selectedDate || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters for slot hold.',
      });
    }

    const holdResult = await holdSlotsWithTtl(
      bookingReference,
      selectedDate,
      slots,
      customerName || '',
      ttlSeconds || 300
    );

    return res.json({ success: true, ...holdResult });
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('DOUBLE_BOOKING_PREVENTED') || msg.includes('SLOT_HELD_IN_PROGRESS')) {
      return res.status(409).json({
        success: false,
        error: msg,
      });
    }

    return res.status(500).json({
      success: false,
      error: msg || 'Failed to acquire slot lock',
    });
  }
});

/**
 * Release temporary slot hold
 */
app.post('/api/slots/release', async (req: Request, res: Response) => {
  try {
    const { bookingReference } = req.body || {};
    if (bookingReference) {
      await releaseSlotHold(bookingReference);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.json({ success: true, warning: err.message });
  }
});

// -------------------------------------------------------------
// 3. CHECKOUT & PAYMENT INTEGRATIONS
// -------------------------------------------------------------

app.post('/api/create-checkout', enforceMaintenanceBlock, async (req: Request, res: Response) => {
  try {
    const { booking } = req.body || {};
    if (!booking || !booking.bookingReference) {
      return res.status(400).json({
        success: false,
        error: 'Missing booking details for checkout initialization.',
      });
    }

    // Default to InstaPay QR checkout for MATCH&SIP
    return res.json({
      success: true,
      checkoutUrl: '',
      qrCodeUrl: '/assets/images/INSTAPAY QR CODE.jpg',
      bookingReference: booking.bookingReference,
      provider: 'INSTAPAY_QR',
      isLive: true,
    });
  } catch (err: any) {
    console.error('[CHECKOUT] Error creating checkout:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to create payment checkout.',
    });
  }
});

app.post('/api/payment/simulate-pay', async (req: Request, res: Response) => {
  try {
    const { bookingReference } = req.body || {};
    if (!bookingReference) {
      return res.status(400).json({ success: false, error: 'Missing bookingReference' });
    }

    await updateBookingFields(bookingReference, { status: 'BOOKED' });
    return res.json({ success: true, bookingReference });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/payment/status/:ref', async (req: Request, res: Response) => {
  try {
    const booking = await getBookingByReference(req.params.ref);
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    return res.json({
      success: true,
      bookingReference: booking.bookingReference,
      status: booking.status,
      isBooked: booking.status === 'BOOKED' || booking.status === 'CONFIRMED',
      selectedDate: booking.selectedDate,
      customer: {
        fullName: booking.customerName,
        phoneNumber: booking.customerPhone,
        email: booking.customerEmail,
        notes: booking.customerNotes,
      },
      slots: booking.slots,
      totalAmount: booking.totalAmount,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// 4. EMAIL NOTIFICATIONS (Resend)
// -------------------------------------------------------------

app.post('/api/notify-admin', async (req: Request, res: Response) => {
  try {
    const { booking } = req.body || {};
    if (!booking) {
      return res.status(400).json({ success: false, error: 'Missing booking payload' });
    }

    const resend = getResendClient();
    if (!resend) {
      console.warn('[EMAIL] RESEND_API_KEY not configured, skipping dispatch');
      return res.json({
        success: true,
        message: 'Notification skipped (RESEND_API_KEY not set)',
      });
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MATCH and SIP <onboarding@resend.dev>';
    const slotsSummary = (booking.slots || [])
      .map((s: any) => `${s.courtName || 'Court'}: ${s.timeLabel || ''}`)
      .join(', ');

    const result = await resend.emails.send({
      from: fromEmail,
      to: ADMIN_EMAIL,
      subject: `🎾 New Court Reservation: #${booking.bookingReference} (${booking.selectedDate})`,
      html: `
        <div style="background-color: #5E2CB2; color: #ffffff; padding: 24px; border-radius: 16px; font-family: sans-serif; max-width: 550px; margin: 0 auto;">
          <h2 style="color: #00C6FF; margin-top: 0;">MATCH & SIP New Reservation</h2>
          <p>A new court booking has been confirmed:</p>
          <div style="background: rgba(255,255,255,0.1); padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 4px 0;"><strong>Reference:</strong> #${booking.bookingReference}</p>
            <p style="margin: 4px 0;"><strong>Player:</strong> ${booking.customer?.fullName || booking.customerName}</p>
            <p style="margin: 4px 0;"><strong>Phone:</strong> ${booking.customer?.phoneNumber || booking.customerPhone}</p>
            <p style="margin: 4px 0;"><strong>Date:</strong> ${booking.selectedDate}</p>
            <p style="margin: 4px 0;"><strong>Slots:</strong> ${slotsSummary}</p>
            <p style="margin: 4px 0;"><strong>Total:</strong> ₱${booking.totalAmount}</p>
            <p style="margin: 4px 0;"><strong>Status:</strong> ${booking.status || 'BOOKED'}</p>
          </div>
        </div>
      `,
    });

    if (result.error) {
      console.error('[EMAIL] Resend send error:', result.error);
      return res.status(400).json({ success: false, error: result.error.message });
    }

    return res.json({ success: true, message: `Notification sent to ${ADMIN_EMAIL}` });
  } catch (err: any) {
    console.error('[EMAIL] Error dispatching notification:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Direct Test Email Endpoint for Diagnostics
app.post('/api/test-email', async (_req: Request, res: Response) => {
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
      recipient: ADMIN_EMAIL,
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

// -------------------------------------------------------------
// 5. VERSION & DEPLOYMENT CHECK
// -------------------------------------------------------------

app.get('/api/version', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.json({
    version: '1.0.0',
    buildTime: BUILD_TIME,
    timestamp: new Date().toISOString(),
  });
});

// -------------------------------------------------------------
// 6. VISITOR ANALYTICS & AUDIT LOGS
// -------------------------------------------------------------

app.post('/api/analytics/track', async (req: Request, res: Response) => {
  try {
    const { action } = req.body || {};
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown';
    const userAgent = req.headers['user-agent'] || '';

    await recordAnalyticsEvent({
      ipAddress: ip,
      action: action || 'page_view',
      userAgent,
    });

    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
});

app.get('/api/analytics', async (req: Request, res: Response) => {
  try {
    const adminPin = req.headers['x-admin-pin'] as string;
    if (adminPin?.trim() !== ADMIN_PIN) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
    }

    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 250;
    const logs = await getAnalyticsLogs(isNaN(limit) ? 250 : limit);

    return res.json({
      logs,
      metrics: {
        totalEvents: logs.length,
        uniqueIps: new Set(logs.map((l: any) => l.ipAddress)).size,
        bookingActions: logs.filter((l: any) => l.action?.includes('booking')).length,
        slotInteractions: logs.filter((l: any) => l.action?.includes('slot')).length,
        topActions: [],
        topIps: [],
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to query analytics' });
  }
});

// Global unhandled error handler middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[UNHANDLED SERVER ERROR]', err);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: err.message || 'Internal server error occurred.',
    });
  }
});

// -------------------------------------------------------------
// 7. DEV SERVER / PRODUCTION STATIC ASSET SERVING
// -------------------------------------------------------------

async function startServer() {
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.argv[1]?.endsWith('.cjs')) ||
    Boolean(process.argv[1]?.includes('dist'));

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader(
              'Cache-Control',
              'no-cache, no-store, must-revalidate, max-age=0, proxy-revalidate'
            );
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate, max-age=0, proxy-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MATCH&SIP] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
