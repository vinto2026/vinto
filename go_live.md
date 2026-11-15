# VINTO site

A static site (index.html + assets) with a few small server functions. No build step.
Upload the whole folder to your host the same way as before.

## What is where

- `index.html`: the whole page. Products, prices and Stripe links are near the bottom, in `const LINKS` and `const P`.
- `assets/js/vinto3d.js`: the 3D engine (product films, the spinning lineup, the product viewer).
- `assets/products/`: product photos. Files with `-3d-` in the name are only used by the 3D engine.
- `api/` (Vercel) and `functions/api/` (Cloudflare Pages): the server functions. Both folders do the same thing; your host uses the one it understands.
  - `checkout`: one Stripe Checkout page for the whole cart
  - `order-email` (Vercel only): emails you each paid order
  - `config`: tells the page which features below are connected
  - `sms-signup`: saves an SMS signup and texts the discount code
  - `contact`: emails you a contact-form message
- `setup/database.sql`: creates your private database tables (see step 1 below).
- `success.html`: the thank-you page.

## Prices live in three places. Keep them equal.

1. `const P` in `index.html` (what the page shows)
2. `PRODUCTS` in `api/checkout.js` and `functions/api/checkout.js` (what the cart charges)
3. Each Stripe Payment Link in `const LINKS` (what "Pre-order now" charges). These prices are set inside Stripe.

Current prices (AUD): Distressed Zip Up 65, Fadeaway Tracksuit 120, Vinto Jorts 60, Static Hood 60,
Long Shorts 80, Vinto Panel Pants 75, Pipeline Track 120.

---

# Switching on SMS signup, accounts and the contact form

These three features are built in but stay hidden until their service is connected, so visitors never see a dead button.
You connect a service by adding its keys as **environment variables** on your host, then redeploying.
Nothing in the code needs editing.

| Feature | Service you need | Shows up when these variables exist |
|---|---|---|
| Contact form sends you email | Resend (you already use it for order emails) | `RESEND_API_KEY` + `ORDER_EMAIL_TO` (or `CONTACT_EMAIL_TO`) |
| Sign in / sign up, saved details | Supabase (free tier) | `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` |
| Private database of signups | Supabase | `SUPABASE_URL` + `SUPABASE_SECRET_KEY` |
| "10% off" SMS pop-up | Twilio (paid per text) + Supabase | the Supabase pair above + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |

Until the contact form is connected it still works: it opens the visitor's email app with the message filled in.

## Step 1. Database and accounts (Supabase)

**Done on 15 Nov 2026:** the Supabase project `vinto` exists (Sydney region, in "vinto2026's Org") and the three tables are created and checked:

- `sms_signups`: every phone number that signed up, when, and whether the text was sent
- `contact_messages`: every contact-form message
- `profiles`: each customer's saved name, mobile and usual size

Still to do in the Supabase dashboard (supabase.com/dashboard, project `vinto`):

1. **Project Settings > API Keys**: copy the **secret** key (starts `sb_secret_`). It goes into your host as `SUPABASE_SECRET_KEY` and nowhere else.
   Never paste it into `index.html` or a chat.
2. **Authentication > URL Configuration**: set **Site URL** to `https://YOUR-DOMAIN` and add `https://YOUR-DOMAIN/**` under **Redirect URLs**.
3. **Authentication > Sign In / Providers**: turn on each sign-in option you want. The site shows a "Continue with ..." button for every one that is on.
   - **Google**: in Google Cloud Console create an OAuth client (type "Web application"), add the callback URL that Supabase shows you
     as an authorised redirect URI, then paste the client ID and secret into Supabase.
   - **Apple, Facebook and others**: same idea, each needs its own developer account with that company.
4. **Email sign-up needs your own email sender.** Supabase's built-in email only delivers to your own team's addresses, so customers
   signing up with email and password will not get their confirmation or password-reset emails until you add one.
   **Authentication > Emails > SMTP Settings**: enter Resend's SMTP details (Resend needs your own domain verified to send to customers).
   Google sign-in does not need this.

**Only you can see the signup database.** The tables for signups and messages have no access from the website at all:
the page cannot read them, and neither can a signed-in customer. You view them by logging in to Supabase:
**Table Editor > sms_signups** (export to CSV from there), **Table Editor > contact_messages**, and
**Authentication > Users** for everyone with an account. Orders stay in Stripe.

## Step 2. SMS (Twilio)

1. Make an account at twilio.com and get an **Australian mobile number that can send SMS**. Twilio may ask for your business details first.
2. Copy your **Account SID**, **Auth Token** and the number (written like `+614...`).
3. A number is the simple choice because replies work, so "Reply STOP" opts people out automatically.
   A sender name like "VINTO" instead of a number has to be registered in Australia before use, and cannot receive replies.

What the visitor gets, once, per phone number:

> VINTO: Thanks for signing up. Use code VINTO10 for 10% off your first order at YOUR-DOMAIN. Reply STOP to opt out.

Built-in limits so nobody can run up your SMS bill: one text per number, 5 signups per hour per connection, 300 per day in total.

## Step 3. The discount code (Stripe)

In Stripe: **Product catalogue > Coupons > New**: 10% off. Then add a **promotion code** to it named `VINTO10`,
and tick the option that limits it to a customer's first order. Customers type it into the promo box at checkout.

## Step 4. Add the variables and redeploy

Vercel: Settings > Environment Variables. Cloudflare Pages: Settings > Variables and Secrets.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://jtpmfvfhrrmslrblqbze.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_UwbSv-F454kR-_-6ZhtM7A_6XLdgG3q` (safe to be public) |
| `SUPABASE_SECRET_KEY` | the secret key from Step 1 (keep private) |
| `TWILIO_ACCOUNT_SID` | starts with `AC` |
| `TWILIO_AUTH_TOKEN` | from the Twilio console (keep private) |
| `TWILIO_FROM` | your Twilio number, like `+61480000000` (or a Messaging Service SID starting `MG`) |
| `CONTACT_EMAIL_TO` | optional: where contact messages go. Defaults to `ORDER_EMAIL_TO` |
| `SMS_CODE` | optional: the code that is texted. Defaults to `VINTO10` |
| `SMS_COUNTRIES` | optional: `AU` by default. Set to `AU,NZ` to accept New Zealand mobiles too, once you have confirmed your Twilio sender can reach NZ |
| `SMS_DAILY_CAP` | optional: most texts in 24 hours. Defaults to `300` |

Already set from before: `STRIPE_SECRET_KEY`, and for order emails `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ORDER_EMAIL_TO`.

After redeploying, open `https://YOUR-DOMAIN/api/config`. You should see `"sms":true`, `"contact":true` and an `"accounts"` entry.
Then sign up with your own phone once to check the text arrives.

## Marketing texts: the rules

In Australia marketing texts need the person's consent, must say who they are from, and must offer a way to stop.
The pop-up covers these: the consent box starts unticked, the exact wording they agreed to is stored with each signup,
the text names VINTO, and it ends with "Reply STOP to opt out". Only text people on this list. This is general information, not legal advice.

---

## Going live checklist

1. Stripe Dashboard, Test mode OFF: one Payment Link per product, in AUD, at the prices above.
2. In each link's "After payment" settings, redirect to `https://YOUR-DOMAIN/success.html`
3. In `index.html` find `const LINKS={` and check each URL is the live link for that product.
4. `STRIPE_SECRET_KEY` (sk_live_...) is set on your host.
5. Upload this folder and place one small real order to confirm.

## Adding a product to the 3D views

Add it to `const P` with a front photo (and a back photo if you have one) as transparent `.webp` files, add its id to `ORDER`,
and add a card for it in the "Shop all" grid. The lineup and the product viewer pick it up from there.

The fleece shown in the 3D close-ups is drawn to match the inside-fabric photo (a pilled cotton fleece). Its colour per piece is set by
`fl:` in `const P` (see `const FL` just above it: charcoal, grey, off-white).

The back of the Distressed Zip Up in 3D (`distressed-zip-3d-back.webp`) is a plain stand-in built from the front photo.
Replace that file with a real cut-out back photo when you have one.
