import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

async function credentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!hostname || !token) throw new Error("Stripe connection identity is unavailable");
  const response = await fetch(`https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Stripe connection unavailable (${response.status})`);
  const data = await response.json() as { items?: { settings?: { secret?: string; webhook_secret?: string } }[] };
  const settings = data.items?.[0]?.settings;
  if (!settings?.secret) throw new Error("Stripe connection has no secret key");
  return { secretKey: settings.secret, webhookSecret: settings.webhook_secret };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await credentials();
  return new Stripe(secretKey);
}

// Live browser fixtures must never create subscriptions in a production Stripe account.
export async function getTestStripeClient(): Promise<Stripe> {
  const { secretKey } = await credentials();
  if (!secretKey.startsWith("sk_test_")) throw new Error("Membership fixtures require Stripe test mode.");
  return new Stripe(secretKey);
}

export async function getStripeSync(): Promise<StripeSync> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for Stripe");
  const { secretKey, webhookSecret } = await credentials();
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? "",
  });
}