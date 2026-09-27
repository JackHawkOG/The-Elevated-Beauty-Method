import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetRadiantAuditHistoryQueryKey,
  useClearRadiantAuditHistory,
  useDeleteRadiantAuditHistoryEntry,
} from "@workspace/api-client-react";
import type { RadiantAudit, RadiantAuditHistoryEntry } from "@workspace/api-client-react";
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
}: {
  latest: RadiantAudit | null;
  history: RadiantAuditHistoryEntry[];
  accountId: string;
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
  const [confirmation, setConfirmation] = useState<"selected" | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const deleteEntry = useDeleteRadiantAuditHistoryEntry();
  const clearHistory = useClearRadiantAuditHistory();
  const deleting = deleteEntry.isPending || clearHistory.isPending;
  const earlier = history.find(entry => entry.id === selectedId) ?? history[0];

  async function confirmDeletion() {
    if (!confirmation || (confirmation === "selected" && !earlier)) return;
    setError(null);
    const key = getGetRadiantAuditHistoryQueryKey();
    try {
      if (confirmation === "all") {
        await clearHistory.mutateAsync();
        queryClient.setQueryData<RadiantAuditHistoryEntry[]>(key, []);
        try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
        setSelectedId(null);
        setNotice(latest ? "Earlier Audit history cleared. Your latest Audit is still saved." : "Earlier Audit history cleared. You have no current Audit.");
      } else if (earlier) {
        const id = earlier.id;
        await deleteEntry.mutateAsync({ id });
        queryClient.setQueryData<RadiantAuditHistoryEntry[]>(key, entries => entries?.filter(entry => entry.id !== id));
        try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
        setSelectedId(null);
        setNotice(latest ? "Earlier submission deleted. Your latest Audit is still saved." : "Earlier submission deleted. You have no current Audit.");
      }
      setConfirmation(null);
      void queryClient.invalidateQueries({ queryKey: key });
    } catch {
      setError("We couldn't delete your earlier Audit. Please try again.");
    }
  }

  if (!earlier) {
    return (
      <div className="mt-8">
        <p className="text-sm text-muted-foreground">Retake your Audit to compare your answers over time.</p>
        {notice && <p className="mt-2 text-sm" role="status">{notice}</p>}
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
        value={earlier.id}
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
        {history.map((entry, index) => (
          <option key={entry.id} value={entry.id}>
            {dateLabel(entry.completedAt)}{index === history.length - 1 ? " · First Audit" : ""}
          </option>
        ))}
      </select>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button type="button" variant="outline" onClick={() => { setError(null); setConfirmation("selected"); }}>
          Delete selected earlier Audit
        </Button>
        <Button type="button" variant="outline" onClick={() => { setError(null); setConfirmation("all"); }}>
          Clear earlier history
        </Button>
      </div>
      {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className={`mt-5 grid gap-4 ${latest ? "sm:grid-cols-2" : ""}`}>
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
      </div>
      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !deleting) setConfirmation(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation === "all" ? "Clear all earlier Audits?" : "Delete this earlier Audit?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "all"
                ? `All earlier submissions and their written reflections will be permanently deleted. ${latest ? "Your latest Audit will remain saved." : "You have no current Audit."}`
                : `The earlier submission from ${dateLabel(earlier.completedAt)} and its written reflections will be permanently deleted. ${latest ? "Your latest Audit will remain saved." : "You have no current Audit."}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={event => { event.preventDefault(); void confirmDeletion(); }}
            >
              {deleting ? "Deleting…" : confirmation === "all" ? "Clear earlier history" : "Delete earlier Audit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
