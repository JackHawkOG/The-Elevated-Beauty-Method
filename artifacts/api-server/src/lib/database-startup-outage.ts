import type { RequestHandler } from "express";
import { membershipSweepHealth } from "./membership-sweep-health";
import { logger } from "./logger";
import { pool } from "@workspace/db";
import { DrizzleQueryError } from "drizzle-orm";

const CONNECTION_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "08000", "08001", "08003", "08004",
  "08006", "08007", "08P01", "57P01", "57P02", "57P03",
]);

export function isDatabaseConnectionFailure(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if ("code" in error && CONNECTION_CODES.has(String(error.code))) return true;
  // db.execute wraps the driver error. Only follow known database wrappers;
  // do not infer an outage from arbitrary application errors or query text.
  if (error instanceof DrizzleQueryError) return isDatabaseConnectionFailure(error.cause, seen);
  if (error instanceof AggregateError) return error.errors.some(cause => isDatabaseConnectionFailure(cause, seen));
  // pg can also report a severed connection without a code.
  return error instanceof Error &&
    /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/.test(error.message);
}

let databaseStartupPending = false;
export const databaseStartupGuard: RequestHandler = (req, res, next) => {
  if (!databaseStartupPending) return next();
  // The existing reconciliation route performs Clerk staff verification.
  // No normal reads/writes or Stripe webhooks may run before schema setup.
  if (req.path === "/api/membership/reconciliation-alerts" && req.method === "GET") return next();
  if (req.path === "/api/healthz" && req.method === "GET") {
    res.status(200).json({ status: "degraded", databaseAvailable: false });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.status(503).json({ error: "Service temporarily unavailable during database startup" });
};

/**
 * Return false only for a confirmed database connectivity failure. Incompatible
 * schemas and Stripe/configuration errors remain fatal, as they were before.
 */
export async function tryDatabaseStartup(
  initialize: () => Promise<void>,
  probeDatabase: () => Promise<unknown> = () => pool.query("SELECT 1"),
): Promise<boolean> {
  try {
    await initialize();
    databaseStartupPending = false;
    return true;
  } catch (error) {
    if (!isDatabaseConnectionFailure(error)) throw error;
    // Initialization also contacts Stripe: a network failure there must not
    // be mislabeled as a database outage or change its existing fatal behavior.
    try {
      await probeDatabase();
    } catch (probeError) {
      if (!isDatabaseConnectionFailure(probeError)) throw error;
      databaseStartupPending = true;
      await membershipSweepHealth.failed();
      logger.warn("Database startup unavailable; only protected operational health is being served");
      return false;
    }
    throw error;
  }
}