import type { RadiantAuditSubmission } from "@/components/radiant-audit-form";

const key = "tebm:radiant-audit:pending";

export function readPendingAudit(): RadiantAuditSubmission | null {
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
    return audit as RadiantAuditSubmission;
  } catch {
    return null;
  }
}

export function stageAudit(audit: RadiantAuditSubmission): void {
  window.sessionStorage.setItem(key, JSON.stringify(audit));
}

export function clearPendingAudit(): void {
  window.sessionStorage.removeItem(key);
}