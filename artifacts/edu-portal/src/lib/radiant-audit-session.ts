import type { RadiantAuditSubmission } from "@/components/radiant-audit-form";

const key = "tebm:radiant-audit:pending";
type PendingAudit = RadiantAuditSubmission & { submissionId?: string };

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
  const staged = { ...audit, submissionId: audit.submissionId ?? crypto.randomUUID() };
  window.sessionStorage.setItem(key, JSON.stringify(staged));
  return staged;
}

export function clearPendingAudit(): void {
  window.sessionStorage.removeItem(key);
}