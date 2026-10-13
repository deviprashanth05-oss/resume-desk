// Razorpay Standard Checkout — order creation + payment-signature verification.
// This is what makes subscription crediting automatic: unlike the manual UPI screen
// (QR code + "send us a screenshot"), a payment made through this flow is verified
// server-side via HMAC signature and grants the subscription immediately, with no
// admin action required. Falls back to null/false everywhere if the two env vars
// (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) aren't set, so a missing config fails loud
// and clear rather than silently granting unverified credits.
const Razorpay = require('razorpay');
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let client; // lazy singleton, undefined until first getClient() call
function getClient() {
  if (client !== undefined) return client;
  if (!KEY_ID || !KEY_SECRET) {
    console.warn('[razorpay] RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set — automatic card/UPI checkout is disabled.');
    client = null;
    return client;
  }
  client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return client;
}

// Per Razorpay's documented scheme: HMAC-SHA256("order_id|payment_id", key_secret)
// must equal the razorpay_signature the frontend got back from the checkout modal.
// This is what proves the payment is real and wasn't forged by a tampered client
// request (e.g. someone calling /verify directly with a fake order/payment id).
function verifySignature(orderId, paymentId, signature) {
  if (!KEY_SECRET || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(orderId + '|' + paymentId).digest('hex');
  // timing-safe compare
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { getClient, verifySignature, KEY_ID, isConfigured: () => !!(KEY_ID && KEY_SECRET) };
