import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { Resend } from 'resend';

dotenv.config({ override: true });

const app = express();
const PORT = 3000;
// Strictly lock admin notifications exclusively to danamieratan@gmail.com
const ADMIN_EMAIL = 'danamieratan@gmail.com';

app.use(express.json({ limit: '10mb' }));

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

// API Health Check & Resend Configuration Status
app.get('/api/health', (req, res) => {
  const currentKey = process.env.RESEND_API_KEY?.trim();
  const currentFrom = process.env.RESEND_FROM_EMAIL?.trim() || 'MATCH and SIP <onboarding@resend.dev>';
  
  res.json({
    status: 'ok',
    resendConfigured: !!currentKey,
    activeSender: currentFrom,
    maskedApiKey: getMaskedKey(currentKey),
    adminEmail: ADMIN_EMAIL,
  });
});

// Admin Booking Notification Endpoint
app.post('/api/notify-admin', async (req, res) => {
  try {
    const { booking } = req.body;

    if (!booking || !booking.bookingReference) {
      return res.status(400).json({
        success: false,
        error: 'Invalid booking data provided.',
      });
    }

    const resend = getResendClient();
    if (!resend) {
      console.warn(
        `[MATCH&SIP] RESEND_API_KEY is not configured in environment. Skipping email dispatch to ${ADMIN_EMAIL}.`
      );
      return res.json({
        success: false,
        skipped: true,
        message:
          'RESEND_API_KEY environment variable is not configured. Please add RESEND_API_KEY in Settings to enable live email delivery.',
      });
    }

    const {
      customer,
      slots = [],
      totalAmount,
      selectedDate,
      bookingReference,
      paymentMethod,
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

    const fromEmail =
      process.env.RESEND_FROM_EMAIL || 'MATCH and SIP <onboarding@resend.dev>';

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>New Court Reservation Confirmed</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 24px 0; background-color: #431E82; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #FFFFFF;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #5E2CB2; border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
        
        <!-- Header Banner -->
        <div style="background: linear-gradient(135deg, #4A1E94 0%, #5E2CB2 100%); padding: 32px 28px 24px; border-bottom: 2px solid #00C6FF;">
          <div style="display: inline-block; background-color: #00C6FF; color: #000000; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; padding: 4px 12px; border-radius: 9999px; margin-bottom: 12px;">
            NEW BOOKING ALERT
          </div>
          <h1 style="margin: 0; font-size: 26px; font-weight: 900; color: #FFFFFF; letter-spacing: -0.02em;">
            MATCH<span style="color: #00C6FF;">&amp;</span>SIP
          </h1>
          <p style="margin: 6px 0 0; color: rgba(255,255,255,0.75); font-size: 14px;">
            A new court reservation has just been confirmed and stored in Cloud Firestore.
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
                <td style="padding: 6px 0; color: rgba(255,255,255,0.6);">Payment:</td>
                <td style="padding: 6px 0; color: #FFFFFF; font-weight: 600;">${paymentMethod || 'InstaPay QR'}</td>
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
                    Total Amount Paid / Due
                  </span>
                  <span style="font-size: 12px; color: #00C6FF;">Status: Confirmed</span>
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
NEW BOOKING ALERT - MATCH&SIP
=============================
Reference Code: #${bookingReference}
Date: ${selectedDate || 'Today'}

CUSTOMER DETAILS:
- Name: ${customerName}
- Phone Number: ${customerPhone}
- Payment Method: ${paymentMethod || 'InstaPay QR'}

RESERVED SLOTS:
${slotsListText}

TOTAL AMOUNT: ${formattedAmount}
STATUS: Confirmed
`;

    const emailResponse = await resend.emails.send({
      from: fromEmail,
      to: ADMIN_EMAIL,
      subject: `🏸 New Booking Confirmed: #${bookingReference} - ${customerName}`,
      html: htmlContent,
      text: textContent,
    });

    if (emailResponse.error) {
      console.error('[MATCH&SIP] Resend API error sending admin notification:', emailResponse.error);
      return res.status(400).json({
        success: false,
        error: emailResponse.error.message,
        details: emailResponse.error,
      });
    }

    console.log('[MATCH&SIP] Admin notification email sent successfully:', emailResponse);

    return res.json({
      success: true,
      data: emailResponse,
      recipient: ADMIN_EMAIL,
    });
  } catch (err: any) {
    console.error('[MATCH&SIP] Error sending admin notification email:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to send notification email',
    });
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
