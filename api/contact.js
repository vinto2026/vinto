// Vercel Serverless Function: POST /api/contact  (same logic as functions/api/contact.js)
// Needs: RESEND_API_KEY and CONTACT_EMAIL_TO (falls back to ORDER_EMAIL_TO). Optional: CONTACT_EMAIL_FROM, SUPABASE_URL + SUPABASE_SECRET_KEY to keep a copy.
const crypto = globalThis.crypto || require('crypto').webcrypto;   // older Node versions on Vercel

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 200;
const sha = async (s) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
// Database (Supabase) with the SECRET key: this runs on the server only and is never sent to the browser.
const secretKey = (env) => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
const db = (env) => {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, ''), key = secretKey(env);
  if (!url || !key) return null;
  return (path, init = {}) =>
    fetch(url + '/rest/v1/' + path, { ...init, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(init.headers || {}) } });
};
const countOf = (r) => { const m = /\/(\d+)$/.exec(r.headers.get('content-range') || ''); return m ? parseInt(m[1], 10) : 0; };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// POST /api/contact  { name, email, message }
// Emails the message to you (reply goes straight to the customer) and keeps a copy in the private contact_messages table.
async function contact(body, env, meta) {
  const to = env.CONTACT_EMAIL_TO || env.ORDER_EMAIL_TO;
  if (!env.RESEND_API_KEY || !to) return [503, { error: 'The contact form is not connected yet.' }];
  if (body.website) return [200, { ok: true }];
  const name = clean(body.name, 100), email = clean(body.email, 200).toLowerCase(), message = cleanText(body.message, 4000);
  if (!name) return [400, { error: 'Enter your name.' }];
  if (!isEmail(email)) return [400, { error: 'Enter a valid email address.' }];
  if (message.length < 5) return [400, { error: 'Write a message first.' }];

  const q = db(env);
  let rowId = null;
  if (q) {
    const ipHash = (await sha(secretKey(env).slice(-16) + '|' + meta.ip)).slice(0, 32);
    let r = await q('contact_messages?select=id&ip_hash=eq.' + ipHash + '&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 3600e3).toISOString()), { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    if (r.ok && countOf(r) >= 5) return [429, { error: 'Too many messages from this connection. Try again in an hour.' }];
    r = await q('contact_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name, email, message, ip_hash: ipHash, email_status: 'pending' }) });
    if (r.ok) rowId = ((await r.json())[0] || {}).id || null;
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.CONTACT_EMAIL_FROM || env.ORDER_EMAIL_FROM || 'VINTO <onboarding@resend.dev>',
      to: to.split(',').map((x) => x.trim()).filter(Boolean),
      reply_to: email,
      subject: 'VINTO contact: ' + name,
      text: 'From: ' + name + ' <' + email + '>\n\n' + message,
      html: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111"><p style="color:#555;margin:0 0 12px">From <b>' + esc(name) + '</b> &lt;' + esc(email) + '&gt;</p><p style="white-space:pre-wrap;margin:0">' + esc(message) + '</p></div>',
    }),
  });
  if (q && rowId) await q('contact_messages?id=eq.' + rowId, { method: 'PATCH', body: JSON.stringify({ email_status: r.ok ? 'sent' : 'failed' }) });
  if (!r.ok) return [502, { error: 'Your message could not be sent. Email us directly instead.' }];
  return [200, { ok: true }];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const meta = { ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', ua: req.headers['user-agent'] || '', host: req.headers.host || '' };
  try {
    const [status, out] = await contact(body, process.env, meta);
    res.status(status).json(out);
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong. Try again shortly.' });
  }
};
