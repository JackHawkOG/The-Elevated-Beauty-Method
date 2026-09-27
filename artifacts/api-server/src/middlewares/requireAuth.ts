import { type Request, type Response, type NextFunction } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Extend Request to carry userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      dbUserId?: number;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const auth = getAuth(req);
  const clerkId = auth?.userId;
  if (!clerkId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = clerkId;
  next();
};

// JIT-provision a user row in our DB from Clerk identity
export const jitProvisionUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const auth = getAuth(req);
  const clerkId = auth?.userId;
  if (!clerkId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = clerkId;

  try {
    const existing = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (existing.length === 0) {
      // Session claims do not always include email. Read it from the authenticated
      // Clerk identity rather than trusting a submitted form address.
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const email = clerkUser.primaryEmailAddress?.emailAddress;
      if (!email) {
        res.status(503).json({ error: "We couldn't verify your account email. Please try again." });
        return;
      }
      const displayName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || "New Learner";
      // Multiple first-page requests can reach provisioning at once.
      const [newUser] = await db.insert(usersTable).values({ clerkId, displayName, email })
        .onConflictDoNothing({ target: usersTable.clerkId }).returning({ id: usersTable.id });
      if (newUser) {
        req.dbUserId = newUser.id;
      } else {
        const [provisioned] = await db.select({ id: usersTable.id })
          .from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        req.dbUserId = provisioned?.id;
      }
    } else {
      req.dbUserId = existing[0].id;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to JIT provision user");
    res.status(503).json({ error: "We couldn't prepare your free account. Please try again." });
    return;
  }
  next();
};
