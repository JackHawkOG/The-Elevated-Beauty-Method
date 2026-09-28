import type { RadiantAuditSubmission } from "@/components/radiant-audit-form";

const key = "tebm:radiant-audit:pending";
export type PendingAudit = RadiantAuditSubmission & { submissionId?: string; stagedAt?: number };
const receiptWindowMs = 7 * 24 * 60 * 60 * 1000;

export function canAutoRetryPendingAudit(audit: PendingAudit, now = Date.now()): boolean {
  return typeof audit.stagedAt === "number" && Number.isFinite(audit.stagedAt) &&
    audit.stagedAt > 0 && audit.stagedAt <= now &&
    now - audit.stagedAt < receiptWindowMs;
}

export function readPendingAudit(): PendingAudit | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const audit = value as Record<string, unknown>;
    if (typeof audit.email !== "string" ||
        !Array.isArray(audit.routineChecks) || !audit.routineChecks.every(item => typeof item === "string") ||
        !Array.isArray(audit.valuesChecks) || !audit.valuesChecks.every(item => typeof item === "string") ||
        typeof audit.beautyTrend !== "string" || typeof audit.masteryGoal !== "string" ||
        typeof audit.researchTime !== "string") return null;
    return audit as PendingAudit;
  } catch {
    return null;
  }
}

export function stageAudit(audit: PendingAudit): PendingAudit {
  const staged = {
    ...audit,
    submissionId: audit.submissionId ?? crypto.randomUUID(),
    // An older entry without a timestamp must remain unconfirmed, not gain a new window.
    stagedAt: audit.submissionId ? audit.stagedAt : Date.now(),
  };
  window.sessionStorage.setItem(key, JSON.stringify(staged));
  return staged;
}

export function restartPendingAudit(audit: PendingAudit): PendingAudit {
  return stageAudit({ ...audit, submissionId: undefined, stagedAt: undefined });
}

export function clearPendingAudit(): void {
  window.sessionStorage.removeItem(key);
}

export function isAuditReadyToSave(audit: RadiantAuditSubmission): boolean {
  return !!audit.email.trim() &&
    !!audit.beautyTrend.trim() &&
    !!audit.masteryGoal.trim() &&
    !!audit.researchTime.trim();
}
