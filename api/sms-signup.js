// Vercel Serverless Function: POST /api/sms-signup  (same logic as functions/api/sms-signup.js)
// Needs: SUPABASE_URL, SUPABASE_SECRET_KEY. Optional: SMS_CODE (default VINTO10), SMS_COUNTRIES (default AU; AU,NZ adds New Zealand).
// Optional texting: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a Twilio number like +614... or a Messaging Service SID), SMS_DAILY_CAP (default 300).
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

const COUNTRIES = { AU: { cc: '61', re: /^4\d{8}$/ }, NZ: { cc: '64', re: /^2\d{7,9}$/ } };   // mobiles only

// Turns what the visitor typed into +614XXXXXXXX / +642XXXXXXXX, or null if it is not an allowed mobile number.
function normalisePhone(raw, country, allowed) {
  const s = String(raw || '').trim(), digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  let intl = s.startsWith('+') ? digits : digits.startsWith('00') ? digits.slice(2) : null;
  if (!intl) for (const c of allowed) if (digits.startsWith(COUNTRIES[c].cc) && COUNTRIES[c].re.test(digits.slice(COUNTRIES[c].cc.length))) intl = digits;
  if (intl) {
    for (const c of allowed) {
      const cc = COUNTRIES[c].cc;
      if (intl.startsWith(cc)) { const nat = intl.slice(cc.length).replace(/^0/, ''); return COUNTRIES[c].re.test(nat) ? '+' + cc + nat : null; }
    }
    return null;
  }
  if (!allowed.includes(country)) return null;
  const nat = digits.replace(/^0/, '');
  return COUNTRIES[country].re.test(nat) ? '+' + COUNTRIES[country].cc + nat : null;
}

// POST /api/sms-signup  { phone, country, consent, source, page }
// Saves the number in the private sms_signups table and returns the discount code to show on screen.
// If Twilio is set up, the code is also texted (once per number).
async function smsSignup(body, env, meta) {
  const q = db(env);
  if (!q) return [503, { error: 'Signup is not connected yet.' }];
  const code = clean(env.SMS_CODE, 30) || 'VINTO10';
  const texting = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  if (body.website) return [200, { ok: true, code }];                // hidden field: only bots fill it in
  if (body.consent !== true) return [400, { error: 'Tick the box to agree to texts from VINTO.' }];
  const allowed = (env.SMS_COUNTRIES || 'AU').toUpperCase().split(',').map((s) => s.trim()).filter((c) => COUNTRIES[c]);
  const phone = normalisePhone(body.phone, clean(body.country, 2).toUpperCase(), allowed.length ? allowed : ['AU']);
  if (!phone) return [400, { error: 'Enter a valid mobile number.' }];

  const enc = encodeURIComponent, head = { method: 'HEAD', headers: { Prefer: 'count=exact' } };
  let r = await q('sms_signups?select=id,sms_status&phone=eq.' + enc(phone));
  if (!r.ok) return [502, { error: 'Could not reach the signup list. Try again shortly.' }];
  let row = (await r.json())[0];
  if (row && (row.sms_status === 'sent' || !texting)) return [200, { ok: true, already: true, code, texted: row.sms_status === 'sent' }];   // one text per number

  const ipHash = (await sha(secretKey(env).slice(-16) + '|' + meta.ip)).slice(0, 32);
  if (!row) {
    // limits, so nobody can use this form to run up your SMS bill
    r = await q('sms_signups?select=id&ip_hash=eq.' + ipHash + '&created_at=gte.' + enc(new Date(Date.now() - 3600e3).toISOString()), head);
    if (r.ok && countOf(r) >= 5) return [429, { error: 'Too many signups from this connection. Try again in an hour.' }];
    if (texting) {                                                     // daily cap only matters when texts cost money
      const cap = Math.max(1, parseInt(env.SMS_DAILY_CAP, 10) || 300);
      r = await q('sms_signups?select=id&created_at=gte.' + enc(new Date(Date.now() - 86400e3).toISOString()), head);
      if (r.ok && countOf(r) >= cap) return [429, { error: 'Signup is busy right now. Try again tomorrow.' }];
    }

    r = await q('sms_signups', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        phone, country: phone.startsWith('+64') ? 'NZ' : 'AU', consent: true,
        consent_text: clean(body.consentText, 300), source: clean(body.source, 40) || 'popup', page: clean(body.page, 200),
        ip_hash: ipHash, user_agent: clean(meta.ua, 300), sms_status: texting ? 'pending' : 'shown_on_site',
      }),
    });
    if (r.status === 409) return [200, { ok: true, already: true, code }];
    if (!r.ok) return [502, { error: 'Could not save your signup. Try again shortly.' }];
    row = (await r.json())[0];
  }
  if (!texting) return [200, { ok: true, code, texted: false }];

  const text = 'VINTO: Thanks for signing up. Use code ' + code + ' for 10% off your first order at ' + meta.host + '. Reply STOP to opt out.';
  const p = new URLSearchParams({ To: phone, Body: text });
  if (/^MG[0-9a-f]{32}$/i.test(env.TWILIO_FROM)) p.set('MessagingServiceSid', env.TWILIO_FROM); else p.set('From', env.TWILIO_FROM);
  const t = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID + '/Messages.json', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p,
  });
  const td = await t.json().catch(() => ({}));
  const patch = t.ok
    ? { sms_status: 'sent', sms_sid: clean(td.sid, 64), sms_error: null, sent_at: new Date().toISOString() }
    : { sms_status: 'failed', sms_error: clean(td.message || 'Twilio error ' + t.status, 300) };
  await q('sms_signups?id=eq.' + row.id, { method: 'PATCH', body: JSON.stringify(patch) });
  return [200, { ok: true, code, texted: t.ok }];                    // the code is shown on screen either way
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const meta = { ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', ua: req.headers['user-agent'] || '', host: req.headers.host || '' };
  try {
    const [status, out] = await smsSignup(body, process.env, meta);
    res.status(status).json(out);
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong. Try again shortly.' });
  }
};
