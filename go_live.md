# Going live (no Netlify, no server)

This is a plain static site. Payments use Stripe Payment Links, so there is no secret key and no backend.

1. Stripe Dashboard, Test mode OFF: Payment links > New, one per product (Jorts, Static Hood, Loop Sweats), in AUD.
   Turn on: adjustable quantity, a Size dropdown custom field, shipping address collection (Australia), promo codes.
2. In each link's "After payment" settings, redirect to https://YOUR-DOMAIN/success.html
3. In index.html find `const LINKS={` and replace each test URL with the matching live URL.
4. Upload this folder to any static host. Place one small real order to confirm.

## Combined cart checkout (several products in one payment)

Stripe Payment Links can only sell one fixed product each, so the cart uses a tiny function that builds one
Stripe Checkout page for the whole cart (sizes, quantities, AUD, Australian shipping, promo codes).

- Cloudflare Pages: keep the `functions/` folder. Settings > Variables and Secrets > add `STRIPE_SECRET_KEY` (sk_live_...).
- Vercel: keep the `api/` folder and add the same `STRIPE_SECRET_KEY` environment variable.
- Prices live in the function (`PRODUCTS`), keep them equal to the prices in index.html.
- Until it is deployed, the cart shows a message and offers the old single-product Stripe links instead.
