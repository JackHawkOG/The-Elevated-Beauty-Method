import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";

function requireDevelopment() {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
    throw new Error("The live Audit test cannot run in a deployment.");
  }
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("The live Audit test requires development Clerk keys.");
  }
  if (!process.env.REPLIT_DEV_DOMAIN?.endsWith(".replit.dev") ||
      !process.env.DATABASE_URL ||
      !process.env.PGHOST ||
      !process.env.PGDATABASE ||
      !process.env.PGUSER) {
    throw new Error("The live Audit test requires the Replit development preview and database.");
  }
  // The PG* variables are injected for this workspace's development database.
  // Refuse a DATABASE_URL override pointing at any other database, even with test Clerk keys.
  const target = new URL(process.env.DATABASE_URL);
  if (target.hostname !== process.env.PGHOST ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE ||
      decodeURIComponent(target.username) !== process.env.PGUSER ||
      (process.env.PGPORT && (target.port || "5432") !== process.env.PGPORT)) {
    throw new Error("DATABASE_URL does not match the workspace development database.");
  }
}

const reflections = (marker: string) => ({
  beautyTrend: `trend ${marker}`,
  masteryGoal: `goal ${marker}`,
  researchTime: `research ${marker}`,
});

async function signIn(page: Page, email: string) {
  await page.goto("/radiant-audit");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/radiant-audit");
  await expect(page.getByRole("button", { name: "Save my Audit" })).toBeVisible();
}

async function save(page: Page, email: string, marker: string) {
  const answers = reflections(marker);
  // The accessible checkbox is visually hidden; click its visible label.
  await page.locator('label[for="routine-skincare-consistency"]').click();
  await page.locator('label[for="values-quality-over-price"]').click();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill(email);
  const response = page.waitForResponse(res =>
    res.url().endsWith("/api/users/me/radiant-audit") &&
    res.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save my Audit" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.locator("main")).toContainText(answers.masteryGoal);
}

async function checkComparison(page: Page, own: string[], other: string[]) {
  await page.goto("/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  const comparison = page.getByRole("region", { name: "How your answers have changed" });
  await expect(comparison).toBeVisible();
  for (const marker of own) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(comparison).toContainText(answer);
    }
  }
  for (const marker of other) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(page.locator("body")).not.toContainText(answer);
    }
  }
  await page.reload();
  await expect(comparison).toBeVisible();
  for (const marker of own) {
    await expect(comparison).toContainText(reflections(marker).masteryGoal);
  }
  for (const marker of other) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(page.locator("body")).not.toContainText(answer);
    }
  }
}

test("two real Clerk members keep saved and retaken Audit comparisons private across account switches", async ({ page }) => {
  test.setTimeout(120_000);
  requireDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const accounts = [
    { email: `audit-a-${tag}+clerk_test@example.com`, markers: [`a-first-${tag}`, `a-retake-${tag}`] },
    { email: `audit-b-${tag}+clerk_test@example.com`, markers: [`b-first-${tag}`, `b-retake-${tag}`] },
  ];
  const created: string[] = [];
  try {
    for (const account of accounts) {
      const user = await client.users.createUser({
        emailAddress: [account.email],
        skipPasswordRequirement: true,
      });
      created.push(user.id);
    }
    await signIn(page, accounts[0].email);
    await save(page, accounts[0].email, accounts[0].markers[0]);
    await page.goto("/radiant-audit");
    await save(page, accounts[0].email, accounts[0].markers[1]);
    await checkComparison(page, accounts[0].markers, accounts[1].markers);

    await clerk.signOut({ page });
    await signIn(page, accounts[1].email);
    await expect(page.locator("body")).not.toContainText(reflections(accounts[0].markers[1]).masteryGoal);
    await save(page, accounts[1].email, accounts[1].markers[0]);
    await page.goto("/radiant-audit");
    await save(page, accounts[1].email, accounts[1].markers[1]);
    await checkComparison(page, accounts[1].markers, accounts[0].markers);

    await clerk.signOut({ page });
    await signIn(page, accounts[0].email);
    await checkComparison(page, accounts[0].markers, accounts[1].markers);
  } finally {
    // Import the DB only after the environment guard. Remove only rows for the
    // newly created Clerk IDs; never touch another member's data.
    if (created.length) {
      const [{ db, pool, radiantAuditHistoryTable, radiantAuditsTable, usersTable }, { eq }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        for (const id of created) {
          await db.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, id));
          await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, id));
          await db.delete(usersTable).where(eq(usersTable.clerkId, id));
        }
      } finally {
        await pool.end();
        await Promise.all(created.map(id => client.users.deleteUser(id)));
      }
    }
  }
});

test("cancel keeps the current Audit; confirming deletes only current and leaves earlier answers after reload", async ({ page }) => {
  test.setTimeout(120_000);
  requireDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = `audit-delete-${tag}+clerk_test@example.com`;
  let userId: string | undefined;
  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
    });
    userId = user.id;
    await signIn(page, email);
    for (const marker of [`first-${tag}`, `second-${tag}`, `current-${tag}`]) {
      if (!marker.startsWith("first")) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
    await expect(page.locator("main")).toContainText(reflections(`current-${tag}`).masteryGoal);

    let deletes = 0;
    page.on("request", request => {
      if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/users/me/radiant-audit") {
        deletes++;
      }
    });
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    await expect(dialog).toContainText("Earlier Audits will stay in your history, but none will become your current Audit.");
    await expect(dialog.getByRole("button", { name: "Permanently delete current Audit" })).toBeVisible();
    expect(deletes).toBe(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    await expect(page.locator("main")).toContainText(reflections(`current-${tag}`).masteryGoal);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);

    await page.goto("/dashboard");
    const dashboardAudit = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your Radiant Audit" }) });
    await expect(dashboardAudit).toContainText("Your reflection is saved.");
    await expect(dashboardAudit.getByRole("link", { name: "Review your Audit" })).toHaveAttribute("href", "/radiant-audit/complete");

    await page.goto("/radiant-audit/complete");
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    const deleted = page.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/users/me/radiant-audit",
    );
    await confirm.getByRole("button", { name: "Permanently delete current Audit" }).click();
    expect((await deleted).status()).toBe(204);
    expect(deletes).toBe(1);
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit", exact: true })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(reflections(`current-${tag}`).masteryGoal);
    await expect(comparison).toContainText("you have no current Audit");
    await expect(comparison.getByRole("heading", { name: /^Latest ·/ })).toHaveCount(0);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);

    for (const [index, marker] of [[0, `second-${tag}`], [1, `first-${tag}`]] as const) {
      await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index });
      await expect(comparison).toContainText(reflections(marker).masteryGoal);
      await expect(comparison).toContainText(reflections(marker).beautyTrend);
      await expect(comparison).toContainText(reflections(marker).researchTime);
    }

    await page.reload();
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /^Latest ·/ })).toHaveCount(0);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
    await expect(comparison).toContainText(reflections(`first-${tag}`).masteryGoal);
    await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index: 0 });
    await expect(comparison).toContainText(reflections(`second-${tag}`).masteryGoal);
    await expect(page.locator("main")).not.toContainText(reflections(`current-${tag}`).masteryGoal);

    await page.goto("/dashboard");
    await expect(dashboardAudit).toContainText("Begin with the scorecard and check-in worksheet");
    await expect(dashboardAudit.getByRole("link", { name: "Complete your Audit" })).toHaveAttribute("href", "/radiant-audit");
    await expect(dashboardAudit).not.toContainText("Your reflection is saved.");
    await page.reload();
    await expect(dashboardAudit).toContainText("Begin with the scorecard and check-in worksheet");
    await expect(dashboardAudit.getByRole("link", { name: "Complete your Audit" })).toHaveAttribute("href", "/radiant-audit");
  } finally {
    if (userId) {
      // Remove only this test's account data in the development database.
      try {
        const [{ db, pool, radiantAuditHistoryTable, radiantAuditsTable, usersTable }, { eq }] =
          await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
        try {
          await db.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, userId));
          await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, userId));
          await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
        } finally {
          await pool.end();
        }
      } finally {
        await client.users.deleteUser(userId);
      }
    }
  }
});