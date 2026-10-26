// Cloudflare Pages Function: POST /api/checkout
// Builds ONE Stripe Checkout page for the whole cart. Needs env var STRIPE_SECRET_KEY (live key, sk_live_...).
const PRODUCTS = {
  jorts:  { name: 'Vinto Jorts',  aud: 80 },
  static: { name: 'Static Hood',  aud: 80, colors: { grey: 'Grey / Olive', black: 'Black' } },
  long:   { name: 'Long Shorts',  aud: 80, colors: { black: 'Black', grey: 'Grey / Olive' } },
  panel:  { name: 'Vinto Panel Pants', aud: 75, colors: { black: 'Black', grey: 'Grey / Olive' } },
  tee:    { name: 'Vinto Baggy Tee',    aud: 55, colors: { black: 'Black', grey: 'Grey / Olive' } },
  sweats: { name: 'Loop Sweats',  aud: 90 },
};
const SIZES = ['S', 'M', 'L', 'XL'];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'STRIPE_SECRET_KEY is not set' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
  if (!items.length) return json({ error: 'Cart is empty' }, 400);

  const origin = new URL(request.url).origin;
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', origin + '/success.html');
  p.set('cancel_url', origin + '/#collection');
  p.set('allow_promotion_codes', 'true');
  p.set('shipping_address_collection[allowed_countries][0]', 'AU');
  p.set('shipping_address_collection[allowed_countries][1]', 'NZ');
  p.set('billing_address_collection', 'auto');
  p.set('custom_text[submit][message]', 'Pre-order: estimated to ship early December 2026. We will email you when your order ships.');

  let n = 0;
  for (const it of items) {
    const prod = PRODUCTS[it.id];
    const qty = Math.min(10, Math.max(1, parseInt(it.qty, 10) || 0));
    if (!prod || !SIZES.includes(it.size) || !qty || (prod.colors && !prod.colors[it.color])) return json({ error: 'Invalid cart item' }, 400);
    p.set(`line_items[${n}][quantity]`, String(qty));
    p.set(`line_items[${n}][price_data][currency]`, 'aud');
    p.set(`line_items[${n}][price_data][unit_amount]`, String(prod.aud * 100));
    p.set(`line_items[${n}][price_data][product_data][name]`, prod.colors ? `${prod.name} (${prod.colors[it.color]}, Size ${it.size})` : `${prod.name} (Size ${it.size})`);
    n++;
  }

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p,
  });
  const d = await r.json();
  if (!r.ok) return json({ error: (d.error && d.error.message) || 'Stripe error' }, 502);
  return json({ url: d.url });
}
