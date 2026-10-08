// Outgoing email — currently used for exactly one thing: the payment receipt sent
// to a user the moment an admin grants/renews their subscription from the admin
// dashboard (see lib/admin.js, POST /users/:id/subscription). There is no payment
// gateway webhook in this app (payments are UPI, verified by a human), so "automatic"
// here means "fires the instant the admin action that represents a verified payment
// succeeds" — not "fires the instant money moves," which this app has no way to see.
//
// Configure via env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   (required — if any are missing,
//                                                  sendInvoiceEmail no-ops and logs)
//   SMTP_FROM                                     (optional, defaults to SMTP_USER)
// For Gmail: host smtp.gmail.com, port 587, user is the Gmail address, pass is a
// 16-character Google "App Password" (not the normal account password — Gmail
// rejects plain-password SMTP logins).
const nodemailer = require('nodemailer');

const APP_NAME = process.env.APP_NAME || 'ITC Resume';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'intellify25@gmail.com';

let transporter; // built lazily, cached — null means "checked, not configured"
function getTransporter() {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[mailer] SMTP_HOST/SMTP_USER/SMTP_PASS not set — invoice emails will be skipped.');
    transporter = null;
    return transporter;
  }
  const port = parseInt(SMTP_PORT, 10) || 587;
  transporter = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  return transporter;
}

const fmtDate = ms => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fire-and-forget by design: a failed email must never undo or block the subscription
// grant that already happened. Callers should not await this on the critical path of
// the HTTP response if they want the admin action to stay fast; it's safe to await
// since send failures are caught here, but a slow SMTP server will slow the response.
async function sendInvoiceEmail({ to, name, plan, label, price, currency, credits, startDate, endDate }) {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'smtp_not_configured' };
  if (!to) return { sent: false, reason: 'no_recipient' };
  const invoiceNo = 'INV-' + new Date(startDate).toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  const amountStr = currency + price;
  const subject = `${APP_NAME} — Payment receipt (${label} plan)`;
  const text = [
    `${APP_NAME} — Payment Receipt`, '',
    `Invoice: ${invoiceNo}`, `Date: ${fmtDate(Date.now())}`, `Billed to: ${name || to} (${to})`, '',
    `Plan: ${label}`, `AI credits: ${credits}`, `Billing period: ${fmtDate(startDate)} – ${fmtDate(endDate)}`,
    `Payment method: UPI`, `Amount paid: ${amountStr}`, '',
    `Your plan is now active. Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">
    <h2 style="margin:0 0 2px">${esc(APP_NAME)}</h2>
    <p style="color:#666;margin:0 0 18px">Payment receipt</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:5px 0;color:#666">Invoice</td><td style="padding:5px 0;text-align:right">${esc(invoiceNo)}</td></tr>
      <tr><td style="padding:5px 0;color:#666">Date</td><td style="padding:5px 0;text-align:right">${fmtDate(Date.now())}</td></tr>
      <tr><td style="padding:5px 0;color:#666">Billed to</td><td style="padding:5px 0;text-align:right">${esc(name || to)}</td></tr>
      <tr><td style="padding:5px 0;color:#666">Plan</td><td style="padding:5px 0;text-align:right">${esc(label)}</td></tr>
      <tr><td style="padding:5px 0;color:#666">AI credits</td><td style="padding:5px 0;text-align:right">${esc(credits)}</td></tr>
      <tr><td style="padding:5px 0;color:#666">Billing period</td><td style="padding:5px 0;text-align:right">${fmtDate(startDate)} – ${fmtDate(endDate)}</td></tr>
      <tr><td style="padding:5px 0;color:#666">Payment method</td><td style="padding:5px 0;text-align:right">UPI</td></tr>
      <tr style="font-weight:700;border-top:1px solid #ddd"><td style="padding:10px 0 0">Amount paid</td><td style="padding:10px 0 0;text-align:right">${esc(amountStr)}</td></tr>
    </table>
    <p style="color:#666;font-size:12.5px;margin-top:20px">Your plan is now active. Questions? Reply to this email or write to ${esc(SUPPORT_EMAIL)}.</p>
  </div>`;
  try {
    await t.sendMail({ from: `"${APP_NAME}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`, to, subject, text, html });
    return { sent: true, invoiceNo };
  } catch (e) {
    console.error('[mailer] Failed to send invoice email to', to, e.message);
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = { sendInvoiceEmail };
