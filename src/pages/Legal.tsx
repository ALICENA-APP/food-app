import type { ReactNode } from 'react'
import { link } from '../lib/router'
import { useCommission } from '../lib/platform'

// Plain-English policy pages. Drafts until they have been reviewed before launch.
const OPERATOR = '[BiteBY operator name and address, to be added before launch]'
const CONTACT = '[contact email, to be added before launch]'

function Page({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className="stack legal">
      <h1>{title}</h1>
      <p className="status small">Draft for review. This page will be finalised before BiteBY launches. Last updated {updated}.</p>
      {children}
      <p className="muted small">
        See also: <a href="/terms" onClick={link('/terms')}>Terms of use</a> · <a href="/privacy" onClick={link('/privacy')}>Privacy</a> ·{' '}
        <a href="/allergens" onClick={link('/allergens')}>Allergens and food safety</a> · <a href="/seller-terms" onClick={link('/seller-terms')}>Seller terms</a>
      </p>
    </article>
  )
}

export function Terms() {
  return (
    <Page title="Terms of use" updated="16 October 2026">
      <section><h2>Who we are</h2><p>BiteBY is run by {OPERATOR}. BiteBY is a marketplace: independent home cooks ("sellers") sell their food to you through the app. The seller is the one selling you the food and is responsible for making it safely and describing it accurately. You can contact us at {CONTACT}.</p></section>
      <section><h2>Your account</h2><p>You need an account to order. Keep your password safe and give accurate details, including a phone number the cook can reach you on if needed. You must be 18 or over to order.</p></section>
      <section><h2>Ordering and paying</h2><p>Each basket is from one seller. You pay the full price, including any delivery fee, when you order. The cook then accepts or declines. If they decline, or don't answer in time, the order is cancelled and you are refunded in full.</p></section>
      <section><h2>Collection and delivery</h2><p>For collection, you get the address once the cook accepts. For delivery, the cook (not BiteBY) brings the food to you. Please be available at the time you chose.</p></section>
      <section><h2>Pay only through BiteBY</h2><p>Always order and pay in the app. If a cook asks you to pay in cash, by bank transfer or any other way outside BiteBY, please don’t, and tell us using “Report a problem” on your order. Orders paid outside BiteBY aren’t covered by our refunds or help. To keep everyone safe, messages can’t include phone numbers, emails, links or bank details, and we may hide them.</p></section>
      <section><h2>Featured cooks</h2><p>Some cooks pay to appear in “Featured cooks” and at the top of search. These spots are always marked “Sponsored”. They don’t affect reviews or ratings.</p></section>
      <section><h2>Cancellations and problems</h2><p>Because food is made to order and perishable, you can't cancel once the cook has accepted, unless they agree. If something is wrong with your order, message the cook in the app first. If that doesn't fix it, contact us and we'll help. This doesn't affect your legal rights.</p></section>
      <section><h2>Reviews</h2><p>Only people who received an order can review it. Reviews must be honest and must not include personal details, abuse or anything unlawful. We may hide reviews that break these rules.</p></section>
      <section><h2>Fair use</h2><p>Don't misuse BiteBY: no fake orders, harassment, or attempts to get around payments. We may suspend accounts that do.</p></section>
      <section><h2>Our responsibility</h2><p>We check sellers before they can sell, but we don't make or inspect the food. Nothing in these terms limits liability that can't be limited by law. These terms are governed by the law of England and Wales.</p></section>
    </Page>
  )
}

export function Privacy() {
  return (
    <Page title="Privacy" updated="16 October 2026">
      <section><h2>Who looks after your data</h2><p>{OPERATOR} is responsible for your personal data on BiteBY. Questions or requests: {CONTACT}.</p></section>
      <section>
        <h2>What we collect and why</h2>
        <ul>
          <li><strong>Account:</strong> your email, name and password (stored securely, never readable by us), so you can sign in.</li>
          <li><strong>Orders:</strong> what you ordered, your phone number, delivery address and notes, so the cook can make and hand over your food, and for our accounts.</li>
          <li><strong>Messages, reviews and saved items:</strong> so you can talk to cooks, share feedback and keep favourites.</li>
          <li><strong>Sellers:</strong> legal name, business type, council registration and home address. The home address is never shown publicly; a customer only sees it after the seller accepts a collection order.</li>
        </ul>
        <p>We use this to run the service (our contract with you), to meet legal duties such as food safety and accounting, and to keep BiteBY safe (our legitimate interests). We don't sell your data and we don't use advertising trackers.</p>
      </section>
      <section><h2>Who we share it with</h2><p>The cook you order from sees your name, phone, order and (for delivery) your address. Our service providers store and process data for us: Supabase (database, UK/EU), Netlify (website hosting) and, once online payments start, Stripe (payments). Where data leaves the UK, it is protected by standard safeguards.</p></section>
      <section><h2>How long we keep it</h2><p>Notifications: 90 days. Order messages: 180 days. Orders and payment records: 6 years, as UK tax law requires. Your account: until you ask us to delete it.</p></section>
      <section><h2>Storage on your device</h2><p>The app stores your sign-in, basket and a few settings on your device so it works properly. These are essential and aren't used for tracking, so there's no cookie banner.</p></section>
      <section><h2>Your rights</h2><p>You can ask to see, correct, delete or move your data, or object to how we use it, by emailing {CONTACT}. You can also complain to the Information Commissioner's Office (ico.org.uk).</p></section>
    </Page>
  )
}

export function AllergenInfo() {
  return (
    <Page title="Allergens and food safety" updated="16 October 2026">
      <section><h2>Every dish lists the 14 allergens</h2><p>Sellers must say, for every dish, whether it contains, may contain, or doesn't contain each of the 14 main allergens: celery, cereals containing gluten, crustaceans, eggs, fish, lupin, milk, molluscs, mustard, tree nuts, peanuts, sesame, soya and sulphites. You'll find them on each dish page and on your order.</p></section>
      <section><h2>Made in home kitchens</h2><p>Food on BiteBY is made in home kitchens that may also handle other allergens. If you have a severe allergy, message the cook before ordering and only order if you're confident it's safe.</p></section>
      <section><h2>Sellers are checked</h2><p>Every seller tells us the council they're registered with as a food business, and our team checks their details before their shop can open. Sellers are responsible for food hygiene and for keeping allergen information up to date. If a recipe changes, the dish comes off sale until they confirm its allergens again.</p></section>
      <section><h2>Report a problem</h2><p>If you think food made you ill or was labelled wrongly, contact us at {CONTACT}. You can also report it to the seller's local council.</p></section>
    </Page>
  )
}

export function SellerTerms() {
  const commission = useCommission()
  return (
    <Page title="Seller terms" updated="16 October 2026">
      <section><h2>Fees</h2><p>No monthly fee. BiteBY keeps {commission} of the food price of each completed order. Delivery fees you charge are all yours. If we change our fee, we’ll tell you at least 30 days before it applies. Payments are made to you through Stripe once online payments are switched on.</p></section>
      <section><h2>Before you sell</h2><p>You must be registered as a food business with your local council (free, at least 28 days before you start), follow food hygiene law, and be approved by the BiteBY team. You're responsible for any tax on your earnings.</p></section>
      <section><h2>Your menu</h2><p>Describe dishes honestly, use your own photos, and list all 14 allergens accurately for every dish. Update them whenever a recipe or ingredient changes. Mark dishes sold out when you can't make them.</p></section>
      <section><h2>Orders</h2><p>Customers pay up front. Accept or decline each order in time. Once you accept, make the food as described and hand it over at the agreed time. If you decline or don't respond, the customer is refunded in full.</p></section>
      <section><h2>Keep orders on BiteBY</h2><p>Every order from a customer you met through BiteBY must be placed and paid in the app, including repeat orders. Don’t ask for cash, bank transfers or payment in any other way, and don’t share phone numbers, emails, links or social media to take orders elsewhere. Messages that do this are hidden and flagged to our team. Shops that take customers or payments off BiteBY may be paused or removed, and we may recover the fees we would have received.</p></section>
      <section><h2>Featured spots</h2><p>You can ask to be featured on the home page and at the top of Explore for a weekly fee. Featured shops are marked “Sponsored”. The BiteBY team approves each request and the number of spots is limited. Being featured never changes your reviews or ratings.</p></section>
      <section><h2>Your privacy</h2><p>Your home address is never shown publicly. A customer sees it only after you accept their collection order.</p></section>
      <section><h2>Reviews and conduct</h2><p>Customers who received an order can review it, and you can reply once. Be courteous. We may pause or remove shops that break these terms, harm customers, or fail food safety checks.</p></section>
    </Page>
  )
}
