// functions/stripe-webhook.js

// ⚠️ Use the exact Netlify var names:
//   STRIPE_SECRET
//   STRIPE_WEBHOOK_SECRET
//   MEMBERSTACK_SECRET
const stripe = require('stripe')(process.env.STRIPE_SECRET);

exports.handler = async (event, context) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sigHeader     = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sigHeader, webhookSecret);
  } catch (err) {
    console.error('⚠️ Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignoring event type' };
  }

  try {
    const sessionId = stripeEvent.data.object.id;

    // 1) Retrieve full session
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'customer_details']
    });

    // 2) Buyer’s email
    const buyerEmail = session.customer_details.email;
    if (!buyerEmail) throw new Error('No customer email on session');

    // 3) Map price → credits
    const priceId = session.line_items.data[0].price.id;
    const PACK_MAP = {
      'price_1RrF9XJ5UE8iZKVwKll2NABR':  1,
      'price_1RrG1FJ5UE8iZKVwUfpKQsFc':  3,
      'price_1RrG2vJ5UE8iZKVwHs92vOhJ':  6,
      'price_1RrG47J5UE8iZKVwlnajUKaU': 10
    };
    const creditsToAdd = PACK_MAP[priceId] || 0;
    if (creditsToAdd === 0) throw new Error(`Unknown price ID: ${priceId}`);

    // 4) Lookup member in Memberstack
    const listRes = await fetch(
      `https://api.memberstack.com/v1/members?email=${encodeURIComponent(buyerEmail)}`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MEMBERSTACK_SECRET}`
        }
      }
    );
    const members = await listRes.json();
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(`No Memberstack member found for ${buyerEmail}`);
    }
    const member = members[0];

    // 5) Compute new credits total
    const existing = Number(member.customFields?.['extra-credits'] || 0);
    const updated  = existing + creditsToAdd;

    // 6) PATCH the new total
    await fetch(
      `https://api.memberstack.com/v1/members/${member.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MEMBERSTACK_SECRET}`
        },
        body: JSON.stringify({
          customFields: { 'extra-credits': updated }
        })
      }
    );

    console.log(`✅ ${buyerEmail}: ${existing} → ${updated} credits`);
    return { statusCode: 200, body: 'Success' };

  } catch (err) {
    console.error('❌ Handler error:', err);
    return { statusCode: 500, body: `Internal Error: ${err.message}` };
  }
};
