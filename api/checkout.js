// Vercel Serverless Function: POST /api/checkout  (same logic as functions/api/checkout.js)
// Needs env var STRIPE_SECRET_KEY (live key, sk_live_...).
const PRODUCTS = {
  zip:    { name: 'Distressed Zip Up', aud: 65 },
  fadeaway: { name: 'Fadeaway Tracksuit, Hoodie + Pants', aud: 120 },
  jorts:  { name: 'Vinto Jorts',  aud: 60 },
  static: { name: 'Static Hood',  aud: 60, colors: { grey: 'Grey / Olive', black: 'Black' } },
  long:   { name: 'Long Shorts',  aud: 80, colors: { black: 'Black', grey: 'Grey / Olive' } },
  panel:  { name: 'Vinto Panel Pants', aud: 75, colors: { black: 'Black', grey: 'Grey / Olive' } },
  tracksuit: { name: 'Pipeline Track, Static Hood + Vinto Jorts', aud: 120 },
};
const SIZES = ['S', 'M', 'L', 'XL'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY is not set' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 20) : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });

  const origin = 'https://' + req.headers.host;
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', origin + '/success.html');
  p.set('cancel_url', origin + '/#collection');
  p.set('allow_promotion_codes', 'true');
  p.set('shipping_address_collection[allowed_countries][0]', 'AU');
  p.set('shipping_address_collection[allowed_countries][1]', 'NZ');
  p.set('billing_address_collection', 'auto');
  p.set('custom_text[submit][message]', 'Pre-order: estimated to ship early December 2026. We will email you when your order ships.');
  // signed-in customers: prefill their email and tag the order with their account id
  const acct = req.body || {};
  if (typeof acct.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(acct.email) && acct.email.length <= 200) p.set('customer_email', acct.email);
  if (typeof acct.uid === 'string' && /^[0-9a-f-]{36}$/i.test(acct.uid)) p.set('client_reference_id', acct.uid);

  let n = 0;
  for (const it of items) {
    const prod = PRODUCTS[it.id];
    const qty = Math.min(10, Math.max(1, parseInt(it.qty, 10) || 0));
    if (!prod || !SIZES.includes(it.size) || !qty || (prod.colors && !prod.colors[it.color])) return res.status(400).json({ error: 'Invalid cart item' });
    p.set(`line_items[${n}][quantity]`, String(qty));
    p.set(`line_items[${n}][price_data][currency]`, 'aud');
    p.set(`line_items[${n}][price_data][unit_amount]`, String(prod.aud * 100));
    p.set(`line_items[${n}][price_data][product_data][name]`, prod.colors ? `${prod.name} (${prod.colors[it.color]}, Size ${it.size})` : `${prod.name} (Size ${it.size})`);
    n++;
  }

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p,
  });
  const d = await r.json();
  if (!r.ok) {
    const k = process.env.STRIPE_SECRET_KEY || '';
    const hint = ' [key in use: ' + k.slice(0, 3) + '...' + k.slice(-4) + ']';
    return res.status(502).json({ error: ((d.error && d.error.message) || 'Stripe error') + hint });
  }
  res.status(200).json({ url: d.url });
};
