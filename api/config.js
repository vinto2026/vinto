// Vercel Serverless Function: GET /api/config  (same logic as functions/api/config.js)
// Reads (all optional): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM,
//   SMS_COUNTRIES, RESEND_API_KEY, CONTACT_EMAIL_TO / ORDER_EMAIL_TO. Features switch on by themselves once their variables exist.
// Tells the page which features are switched on. Only public values are returned here.
function siteConfig(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const pub = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
  const hasDb = !!(url && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY));
  const countries = (env.SMS_COUNTRIES || 'AU').toUpperCase().split(',').map((s) => s.trim()).filter((c) => c === 'AU' || c === 'NZ');
  return {
    sms: hasDb,                                                       // pop-up shows the code on screen and saves the number
    smsText: !!(hasDb && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM),   // also texts it (optional, paid)
    smsCountries: countries.length ? countries : ['AU'],
    accounts: url && pub ? { url, key: pub } : null,
    contact: !!(env.RESEND_API_KEY && (env.CONTACT_EMAIL_TO || env.ORDER_EMAIL_TO)),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Cache-Control', 'no-store');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const meta = { ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', ua: req.headers['user-agent'] || '', host: req.headers.host || '' };
  try {
    res.status(200).json(siteConfig(process.env));
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong. Try again shortly.' });
  }
};
