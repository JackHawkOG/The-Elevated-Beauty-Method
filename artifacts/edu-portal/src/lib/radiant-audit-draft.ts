import type { RadiantAuditSubmission } from "@/components/radiant-audit-form";

const key = "tebm:radiant-audit:signed-in-draft";
const lifetime = 24 * 60 * 60 * 1000;
const receiptWindow = 7 * lifetime;

function safeAttempt(startedAt: unknown, now = Date.now()): boolean {
  return typeof startedAt === "number" && Number.isFinite(startedAt) &&
    startedAt > 0 && startedAt <= now && now - startedAt < receiptWindow;
}

function signature(answers: RadiantAuditSubmission): string {
  return JSON.stringify({
    routineChecks: answers.routineChecks,
    valuesChecks: answers.valuesChecks,
    beautyTrend: answers.beautyTrend.trim(),
    masteryGoal: answers.masteryGoal.trim(),
    researchTime: answers.researchTime.trim(),
  });
}

export function clearAuditDraft(accountId?: string): void {
  if (accountId) {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      try {
        if ((JSON.parse(raw) as { owner?: unknown }).owner !== accountId) return;
      } catch { /* Remove an unreadable record. */ }
    }
  }
  window.localStorage.removeItem(key);
}

export function clearAuditDraftOnSignOut(accountId?: string): boolean {
  if (!accountId) return true;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const record = JSON.parse(raw) as { owner?: string; onlineSynced?: boolean };
      if (record.owner === accountId && record.onlineSynced !== true &&
          !window.confirm("Your unfinished Audit has not been saved online yet. Signing out will discard these answers from this browser. Sign out anyway?")) {
        return false;
      }
    }
    clearAuditDraft(accountId);
  } catch {
    // Storage can be disabled; signing out must still proceed.
  }
  return true;
}

function parseAuditDraft(raw: string, now: number): { owner: string; answers: RadiantAuditSubmission } {
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== "object") throw new Error("Invalid draft");
  const { owner, expiresAt, answers } = record as Record<string, unknown>;
  if (typeof owner !== "string" || !owner ||
      typeof expiresAt !== "number" || !Number.isFinite(expiresAt) ||
      expiresAt <= now || expiresAt > now + lifetime) throw new Error("Invalid expiry or owner");
  if (!answers || typeof answers !== "object") throw new Error("Invalid answers");
  const audit = answers as Record<string, unknown>;
  if (typeof audit.email !== "string" ||
      !Array.isArray(audit.routineChecks) || !audit.routineChecks.every(item => typeof item === "string") ||
      !Array.isArray(audit.valuesChecks) || !audit.valuesChecks.every(item => typeof item === "string") ||
      typeof audit.beautyTrend !== "string" || typeof audit.masteryGoal !== "string" ||
      typeof audit.researchTime !== "string") throw new Error("Invalid answers");
  return { owner, answers: audit as RadiantAuditSubmission };
}

export function pruneInvalidAuditDraft(): void {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) parseAuditDraft(raw, Date.now());
  } catch {
    // Cleanup does not require knowing the signed-in account; keep valid drafts for their owner.
    try { clearAuditDraft(); } catch { /* Storage may be disabled. */ }
  }
}

export function readAuditDraft(accountId: string): RadiantAuditSubmission | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const { owner, answers } = parseAuditDraft(raw, Date.now());
    // A shared browser must never expose one member's answers to another account.
    if (owner !== accountId) {
      clearAuditDraft();
      return null;
    }
    return answers;
  } catch {
    // Corrupt drafts cannot be trusted as account-scoped data.
    try { clearAuditDraft(); } catch { /* Storage may be disabled. */ }
    return null;
  }
}

export function auditDraftWrittenAt(accountId: string): number | null {
  if (!readAuditDraft(accountId)) return null;
  try {
    const record = JSON.parse(window.localStorage.getItem(key)!) as { expiresAt: number };
    return record.expiresAt - lifetime;
  } catch {
    return null;
  }
}

export function writeAuditDraft(accountId: string, answers: RadiantAuditSubmission): void {
  const existing = readAuditDraft(accountId);
  const raw = existing ? JSON.parse(window.localStorage.getItem(key)!) as { submissionId?: unknown; submissionStartedAt?: unknown; onlineSynced?: boolean } : null;
  const unchanged = !!existing && signature(existing) === signature(answers);
  const submissionId = unchanged &&
    typeof raw?.submissionId === "string" ? raw.submissionId : undefined;
  window.localStorage.setItem(key, JSON.stringify({
    owner: accountId,
    expiresAt: Date.now() + lifetime,
    answers,
    onlineSynced: unchanged && raw?.onlineSynced === true,
    submissionId,
    // Editing an unconfirmed attempt must not turn its old age into a fresh window.
    submissionStartedAt: raw?.submissionStartedAt ?? (raw?.submissionId ? null : raw?.submissionStartedAt),
  }));
}

export function markAuditDraftOnline(accountId: string, answers: RadiantAuditSubmission): void {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const record = JSON.parse(raw) as { owner?: string; answers?: RadiantAuditSubmission; onlineSynced?: boolean };
    if (record.owner !== accountId || !record.answers || signature(record.answers) !== signature(answers)) return;
    window.localStorage.setItem(key, JSON.stringify({ ...record, onlineSynced: true }));
  } catch {
    // A storage failure leaves the draft conservatively unconfirmed.
  }
}

export function getAuditSubmissionId(accountId: string, answers: RadiantAuditSubmission): { id: string; startedAt: number } | null {
  const existing = readAuditDraft(accountId);
  const raw = existing ? JSON.parse(window.localStorage.getItem(key)!) as { submissionId?: unknown; submissionStartedAt?: unknown } : null;
  // Missing timestamps on older attempts are unknown, not new attempts.
  if (raw && (raw.submissionId || raw.submissionStartedAt !== undefined) &&
      !safeAttempt(raw.submissionStartedAt)) return null;
  if (existing && signature(existing) === signature(answers) && typeof raw?.submissionId === "string") {
    return { id: raw.submissionId, startedAt: raw.submissionStartedAt as number };
  }
  const startedAt = typeof raw?.submissionStartedAt === "number" ? raw.submissionStartedAt : Date.now();
  return { id: startAuditSubmission(accountId, answers, startedAt), startedAt };
}

export function startAuditSubmission(accountId: string, answers: RadiantAuditSubmission, startedAt = Date.now()): string {
  const submissionId = crypto.randomUUID();
  window.localStorage.setItem(key, JSON.stringify({
    owner: accountId,
    expiresAt: Date.now() + lifetime,
    answers,
    submissionId,
    submissionStartedAt: startedAt,
  }));
  return submissionId;
}
