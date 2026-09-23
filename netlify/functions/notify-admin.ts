import { Resend } from 'resend';

const ADMIN_EMAIL = 'danamieratan@gmail.com';

export default async (req: Request) => {
  // Support CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { booking } = body || {};

    if (!booking) {
      return new Response(JSON.stringify({ error: 'Missing booking payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = process.env.RESEND_API_KEY || 're_Y7yjSRh1_C9aR9F4BQmxJFoxdSrTsdLwZ';
    const resend = new Resend(apiKey);

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

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MATCH and SIP <onboarding@resend.dev>';

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

        <div style="padding: 28px;">
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

    const emailResult = await resend.emails.send({
      from: fromEmail,
      to: [ADMIN_EMAIL],
      subject: `🏸 New Booking Confirmed: #${bookingReference} - ${customerName}`,
      html: htmlContent,
      text: textContent,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: emailResult,
        recipient: ADMIN_EMAIL,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error?.message || 'Server error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
};
