import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
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
      // Create a minimal user row — displayName and email can be updated later
      const email = (auth as any)?.sessionClaims?.email ?? `user_${clerkId}@portal.app`;
      const displayName = (auth as any)?.sessionClaims?.name ?? "New Learner";
      const [newUser] = await db.insert(usersTable).values({ clerkId, displayName, email }).returning();
      req.dbUserId = newUser.id;
    } else {
      req.dbUserId = existing[0].id;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to JIT provision user");
  }
  next();
};
