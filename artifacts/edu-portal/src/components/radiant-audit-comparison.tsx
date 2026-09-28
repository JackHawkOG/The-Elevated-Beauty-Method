import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getRadiantAuditHistory,
  getGetRadiantAuditHistoryQueryKey,
  useClearRadiantAuditHistory,
  useDeleteRadiantAuditHistoryEntry,
} from "@workspace/api-client-react";
import type { RadiantAudit, RadiantAuditHistoryEntry } from "@workspace/api-client-react";
import { announceHistoryChange } from "@/lib/radiant-audit-history-sync";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const routineLabels: Record<string, string> = {
  "skincare-consistency": "Skincare consistency",
  "makeup-application-confidence": "Makeup application confidence",
  "product-spending": "Product spending",
  "trend-chasing-behavior": "Trend-chasing behavior",
  "time-spent-on-beauty-daily": "Time spent on beauty daily",
};

const valuesLabels: Record<string, string> = {
  "quality-over-price": "Quality over price",
  "one-method-mastered": "One method, mastered",
  "professional-results": "Professional results",
  "authentic-expression": "Authentic expression",
  "lasting-investment": "Lasting investment",
};

function dateLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
}

function Answers({ audit }: { audit: RadiantAudit }) {
  return (
    <div className="space-y-5 text-sm">
      <div>
        <p className="font-medium">Current beauty routine · {audit.routineScore} / 5</p>
        <p className="mt-1 text-muted-foreground">
          {audit.routineChecks.map(check => routineLabels[check] ?? check).join(", ") || "No statements checked"}
        </p>
      </div>
      <div>
        <p className="font-medium">The Elevated Woman check-in · {audit.valuesScore} / 5</p>
        <p className="mt-1 text-muted-foreground">
          {audit.valuesChecks.map(check => valuesLabels[check] ?? check).join(", ") || "No questions checked"}
        </p>
      </div>
      {([
        ["The beauty trend I follow most", audit.beautyTrend],
        ["What I most want to master", audit.masteryGoal],
        ["Time researching products each week", audit.researchTime],
      ] as const).map(([label, answer]) => (
        <div key={label}>
          <p className="font-medium">{label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{answer}</p>
        </div>
      ))}
    </div>
  );
}

export function RadiantAuditComparison({
  latest,
  history,
  accountId,
  historyRefreshFailed = false,
}: {
  latest: RadiantAudit | null;
  history: RadiantAuditHistoryEntry[];
  accountId: string;
  historyRefreshFailed?: boolean;
}) {
  const storageKey = `radiant-audit:comparison:${accountId}`;
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored !== null && /^\d+$/.test(stored) ? Number(stored) : null;
    } catch {
      return null;
    }
  });
  const [confirmation, setConfirmation] = useState<{ kind: "selected"; entry: RadiantAuditHistoryEntry } | { kind: "all" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const queryClient = useQueryClient();
  const deleteEntry = useDeleteRadiantAuditHistoryEntry();
  const clearHistory = useClearRadiantAuditHistory();
  const deleting = deleteEntry.isPending || clearHistory.isPending || checking;
  const staleSelection = selectedId !== null && !history.some(entry => entry.id === selectedId);
  const earlier = staleSelection ? undefined : (history.find(entry => entry.id === selectedId) ?? history[0]);
  const confirmedEntryAvailable = confirmation?.kind !== "selected" || history.some(entry => entry.id === confirmation.entry.id);

  async function confirmDeletion() {
    if (!confirmation || !confirmedEntryAvailable || historyRefreshFailed) return;
    setError(null);
    const key = getGetRadiantAuditHistoryQueryKey();
    const target = confirmation;
    try {
      if (target.kind === "all") {
        await clearHistory.mutateAsync();
        queryClient.setQueryData<RadiantAuditHistoryEntry[]>(key, []);
      } else {
        const id = target.entry.id;
        await deleteEntry.mutateAsync({ id });
        queryClient.setQueryData<RadiantAuditHistoryEntry[]>(key, entries => entries?.filter(entry => entry.id !== id));
      }
      void queryClient.invalidateQueries({ queryKey: key });
    } catch {
      setChecking(true);
      try {
        // The server may have committed the deletion before its reply was lost.
        // Bypass the cached list to verify the actual state before suggesting a retry.
        const serverHistory = await getRadiantAuditHistory();
        queryClient.setQueryData(key, serverHistory);
        if (target.kind === "all" ? serverHistory.length > 0 : serverHistory.some(entry => entry.id === target.entry.id)) {
          setError("We couldn't delete your earlier Audit. Please try again.");
          return;
        }
      } catch {
        setError("We couldn't confirm whether your earlier Audit was deleted. Please refresh to check before trying again.");
        return;
      } finally {
        setChecking(false);
      }
    }
    announceHistoryChange(accountId);
    try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
    setSelectedId(null);
    setNotice(target.kind === "all"
      ? latest ? "Earlier Audit history cleared. Your latest Audit is still saved." : "Earlier Audit history cleared. You have no current Audit."
      : latest ? "Earlier submission deleted. Your latest Audit is still saved." : "Earlier submission deleted. You have no current Audit.");
    setConfirmation(null);
  }

  const confirmationDialog = (
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !deleting) setConfirmation(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.kind === "all" ? "Clear all earlier Audits?" : "Delete this earlier Audit?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.kind === "all"
              ? `All earlier submissions and their written reflections will be permanently deleted. ${latest ? "Your latest Audit will remain saved." : "You have no current Audit."}`
              : confirmation?.kind === "selected"
                ? `The earlier submission from ${dateLabel(confirmation.entry.completedAt)} (ID ${confirmation.entry.id}) and its written reflections will be permanently deleted. ${latest ? "Your latest Audit will remain saved." : "You have no current Audit."}`
                : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!confirmedEntryAvailable && <p className="text-sm text-destructive" role="alert">That submission is no longer in your history. Close this window and choose another submission.</p>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting || historyRefreshFailed || !confirmedEntryAvailable || error?.startsWith("We couldn't confirm")}
            onClick={event => { event.preventDefault(); void confirmDeletion(); }}
          >
            {deleting ? "Deleting…" : confirmation?.kind === "all" ? "Clear earlier history" : "Delete earlier Audit"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (!history.length) {
    return (
      <div className="mt-8">
        <p className="text-sm text-muted-foreground">No earlier Audits remain. Retake your Audit to compare your answers over time.</p>
        {staleSelection && <p className="mt-2 text-sm text-muted-foreground" role="status">That earlier Audit is no longer in your history.</p>}
        {notice && <p className="mt-2 text-sm" role="status">{notice}</p>}
        {confirmationDialog}
      </div>
    );
  }

  return (
    <section className="mt-10 border-t border-border pt-8" aria-labelledby="audit-history-heading">
      <h2 id="audit-history-heading" className="font-serif text-2xl">How your answers have changed</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {latest ? "Compare your latest reflection with any earlier submission." : "Your earlier submissions remain saved, but you have no current Audit. Complete a new Audit to compare answers again."} Only you can see these answers.
      </p>
      <label htmlFor="earlier-audit" className="mt-5 block text-sm font-medium">Compare with</label>
      <select
        id="earlier-audit"
        className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2 text-foreground sm:w-auto"
        value={earlier?.id ?? ""}
        onChange={event => {
          const id = Number(event.target.value);
          setSelectedId(id);
          try {
            sessionStorage.setItem(storageKey, String(id));
          } catch {
            // Selection still works for this page when storage is unavailable.
          }
        }}
      >
        {staleSelection && <option value="" disabled>Choose an earlier Audit</option>}
        {history.map((entry, index) => (
          <option key={entry.id} value={entry.id}>
            {dateLabel(entry.completedAt)}{index === history.length - 1 ? " · First Audit" : ""}
          </option>
        ))}
      </select>
      {staleSelection && <p className="mt-2 text-sm text-muted-foreground" role="status">That earlier Audit is no longer in your history. Choose another submission to continue.</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button type="button" variant="outline" disabled={!earlier || deleting || historyRefreshFailed} onClick={() => { if (earlier) { setError(null); setConfirmation({ kind: "selected", entry: earlier }); } }}>
          Delete selected earlier Audit
        </Button>
        <Button type="button" variant="outline" disabled={historyRefreshFailed} onClick={() => { setError(null); setConfirmation({ kind: "all" }); }}>
          Clear earlier history
        </Button>
      </div>
      {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {earlier && <div className={`mt-5 grid gap-4 ${latest ? "sm:grid-cols-2" : ""}`}>
        <div className="min-w-0 rounded-2xl border border-border p-5">
          <h3 className="mb-5 font-serif text-xl">Earlier · {dateLabel(earlier.completedAt)}</h3>
          <Answers audit={earlier} />
        </div>
        {latest && (
          <div className="min-w-0 rounded-2xl border border-primary/40 bg-primary/[0.04] p-5">
            <h3 className="mb-5 font-serif text-xl">Latest · {dateLabel(latest.completedAt)}</h3>
            <Answers audit={latest} />
          </div>
        )}
      </div>}
      {confirmationDialog}
    </section>
  );
}
