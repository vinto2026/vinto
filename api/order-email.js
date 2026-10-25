// Vercel Serverless Function: POST /api/order-email
// Stripe calls this after every paid checkout. It emails you (and/or your shipping place) the order.
// Env vars needed: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, ORDER_EMAIL_TO
// Optional: ORDER_EMAIL_FROM (default uses Resend's test sender)
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: false } };

const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const verify = (raw, header, secret) => {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((x) => x.split('=')));
  const t = parts.t;
  const sigs = header.split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + raw.toString('utf8')).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
};

const SHIP_NOTE = 'PRE-ORDER: hold until stock is ready. Estimated shipping early December 2026.';

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur) => (cur || 'aud').toUpperCase() + ' $' + (cents / 100).toFixed(2);

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, ORDER_EMAIL_TO } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !RESEND_API_KEY || !ORDER_EMAIL_TO)
    return res.status(500).send('Missing environment variables');

  const raw = await readRaw(req);
  if (!verify(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) return res.status(400).send('Bad signature');

  const event = JSON.parse(raw.toString('utf8'));
  if (event.type !== 'checkout.session.completed') return res.status(200).send('ignored');
  const s = event.data.object;
  if (s.payment_status === 'unpaid') return res.status(200).send('not paid');

  // Get the items that were bought
  const li = await fetch('https://api.stripe.com/v1/checkout/sessions/' + s.id + '/line_items?limit=100', {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  const liData = await li.json();
  if (!li.ok) return res.status(502).send('Could not load items');
  const items = liData.data || [];

  const cd = s.customer_details || {};
  const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const a = ship.address || cd.address || {};
  const addr = [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean);
  const name = ship.name || cd.name || '';
  const cur = s.currency;
  const discount = s.total_details && s.total_details.amount_discount;

  const rows = items
    .map((i) => `<tr><td style="padding:6px 12px 6px 0">${esc(i.quantity)} x</td><td style="padding:6px 12px 6px 0"><b>${esc(i.description)}</b></td><td style="padding:6px 0;text-align:right">${money(i.amount_total, cur)}</td></tr>`)
    .join('');

  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
<h2 style="margin:0 0 4px">New VINTO order</h2>
<p style="margin:0 0 12px;padding:8px 12px;background:#fff3cd;color:#664d03;font-weight:bold">${esc(SHIP_NOTE)}</p>
<p style="margin:0 0 16px;color:#555">Order ${esc(s.id.slice(-8))}</p>
<table style="border-collapse:collapse;width:100%;max-width:520px">${rows}
<tr><td colspan="2" style="padding-top:10px;border-top:1px solid #ddd"><b>Total</b></td><td style="padding-top:10px;border-top:1px solid #ddd;text-align:right"><b>${money(s.amount_total, cur)}</b></td></tr></table>
${discount ? `<p style="color:#555">Promo discount applied: ${money(discount, cur)}</p>` : ''}
<h3 style="margin:20px 0 6px">Ship to</h3>
<p style="margin:0">${esc(name)}<br>${addr.map(esc).join('<br>')}</p>
<h3 style="margin:20px 0 6px">Customer</h3>
<p style="margin:0">${esc(cd.email || '')}${cd.phone ? '<br>' + esc(cd.phone) : ''}</p>
</div>`;

  const text =
    SHIP_NOTE + '\n\nNew VINTO order ' + s.id.slice(-8) + '\n\n' +
    items.map((i) => i.quantity + ' x ' + i.description + ' (' + money(i.amount_total, cur) + ')').join('\n') +
    '\n\nTotal: ' + money(s.amount_total, cur) +
    '\n\nShip to:\n' + [name].concat(addr).join('\n') +
    '\n\nCustomer: ' + (cd.email || '') + (cd.phone ? ' ' + cd.phone : '');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.ORDER_EMAIL_FROM || 'VINTO Orders <onboarding@resend.dev>',
      to: ORDER_EMAIL_TO.split(',').map((x) => x.trim()).filter(Boolean),
      reply_to: cd.email || undefined,
      subject: 'PRE-ORDER: New VINTO order: ' + items.map((i) => i.quantity + ' x ' + i.description).join(', ').slice(0, 150),
      html,
      text,
    }),
  });
  if (!r.ok) return res.status(502).send('Email failed: ' + (await r.text()));
  res.status(200).send('ok');
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
