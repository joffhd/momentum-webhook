// functions/stripe-webhook.js

const stripe = require('stripe')(process.env.STRIPE_SECRET);

exports.handler = async (event) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sigHeader     = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    // Verify the webhook signature
    stripeEvent = stripe.webhooks.constructEvent(event.body, sigHeader, webhookSecret);
  } catch (err) {
    console.error('⚠️ Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle completed checkouts
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored event type' };
  }

  try {
    // Retrieve the full session to get line items & customer email
    const session = await stripe.checkout.sessions.retrieve(
      stripeEvent.data.object.id,
      { expand: ['line_items', 'customer_details'] }
    );

    // Map your price IDs to credit quantities
    const PACK_MAP = {
      'price_1RrF9XJ5UE8iZKVwKll2NABR':  1,
      'price_1RrG1FJ5UE8iZKVwUfpKQsFc':  3,
      'price_1RrG2vJ5UE8iZKVwHs92vOhJ':  6,
      'price_1RrG47J5UE8iZKVwlnajUKaU': 10
    };
    const priceId      = session.line_items.data[0].price.id;
    const creditsToAdd = PACK_MAP[priceId] || 0;
    if (creditsToAdd === 0) throw new Error(`Unknown price ID: ${priceId}`);

    const buyerEmail = session.customer_details.email;
    if (!buyerEmail) throw new Error('No customer email on session');

    // Look up the Memberstack member by email
    const listRes = await fetch(
      `https://api.memberstack.com/v1/members?email=${encodeURIComponent(buyerEmail)}`,
      {
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
    const member   = members[0];
    const existing = Number(member.customFields['extra-credits'] || 0);
    const updated  = existing + creditsToAdd;

    // Patch the new total back to Memberstack
    await fetch(
      `https://api.memberstack.com/v1/members/${member.id}`,
      {
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

    console.log(`✅ Bumped ${buyerEmail} from ${existing} to ${updated} credits`);
    return { statusCode: 200, body: 'Success' };

  } catch (err) {
    console.error('❌ Handler error:', err);
    return { statusCode: 500, body: `Internal Error: ${err.message}` };
  }
};
