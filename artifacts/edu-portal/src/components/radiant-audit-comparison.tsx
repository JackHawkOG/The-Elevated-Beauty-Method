import { useState } from "react";
import type { RadiantAudit, RadiantAuditHistoryEntry } from "@workspace/api-client-react";

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
  latest: RadiantAudit;
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
  const earlier = history.find(entry => entry.id === selectedId) ?? history[0];

  if (!earlier) {
    return <p className="mt-8 text-sm text-muted-foreground">Retake your Audit to compare your answers over time.</p>;
  }

  return (
    <section className="mt-10 border-t border-border pt-8" aria-labelledby="audit-history-heading">
      <h2 id="audit-history-heading" className="font-serif text-2xl">How your answers have changed</h2>
      <p className="mt-2 text-sm text-muted-foreground">Compare your latest reflection with any earlier submission. Only you can see these answers.</p>
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
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-border p-5">
          <h3 className="mb-5 font-serif text-xl">Earlier · {dateLabel(earlier.completedAt)}</h3>
          <Answers audit={earlier} />
        </div>
        <div className="min-w-0 rounded-2xl border border-primary/40 bg-primary/[0.04] p-5">
          <h3 className="mb-5 font-serif text-xl">Latest · {dateLabel(latest.completedAt)}</h3>
          <Answers audit={latest} />
        </div>
      </div>
    </section>
  );
}