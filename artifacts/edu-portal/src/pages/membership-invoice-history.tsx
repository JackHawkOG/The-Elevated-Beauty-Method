import { useState } from "react";
import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { useGetPendingMembershipInvoiceHistory, getGetPendingMembershipInvoiceHistoryQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import NotFound from "@/pages/not-found";

function History({ userId }: { userId: string }) {
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const after = cursors[page];
  const params = after === undefined ? undefined : { after };
  const q = useGetPendingMembershipInvoiceHistory(params, {
    query: {
      queryKey: [...getGetPendingMembershipInvoiceHistoryQueryKey(params), userId],
      gcTime: 0,
      staleTime: 0,
      retry: false,
      refetchInterval: 60000,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  const data = q.isError ? undefined : q.data;
  const next = data?.nextCursor ?? null;

  function firstPage() {
    setCursors([undefined]);
    setPage(0);
    if (page === 0) void q.refetch();
  }
  function goNext() {
    if (next === null) return;
    setCursors(c => [...c.slice(0, page + 1), next]);
    setPage(page + 1);
  }

  return <AppLayout>
    <div className="mx-auto max-w-3xl space-y-6 py-10">
      <h1 className="font-serif text-4xl">Pending invoice history</h1>
      <p className="text-muted-foreground">Read-only staff view of forfeited founding memberships still awaiting invoice history. Access remains ended for these members. Missing history is not proof of payment failure.</p>
      <section aria-label="How to read this list" className="rounded-2xl border border-border bg-card p-6 text-sm space-y-2">
        <p><strong>Retry attempts</strong> counts failed invoice-history attempts, including the initial attempt.</p>
        <p>A private staff notice appears after eight failed attempts (roughly 32 hours on the current retry schedule) and clears after successful history recovery. If notices cannot be checked, recovery is not confirmed.</p>
        <p><strong>Next retry</strong> is when the record becomes eligible. The automatic sweep runs roughly every 15 minutes, so the actual retry may be later. No date means no retry time is recorded, not that the record is resolved.</p>
        <p><strong>Subscription</strong> shown as unavailable means no subscription identifier is available.</p>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" data-testid="button-refresh" onClick={firstPage} disabled={q.isFetching}>{q.isFetching ? "Refreshing…" : "Refresh from first page"}</Button>
        <span className="text-sm text-muted-foreground" data-testid="text-page">Page {page + 1} · up to 50 per page</span>
      </div>
      {q.isPending && <div role="status" aria-label="Loading" className="space-y-3" data-testid="state-loading">
        {[0, 1, 2].map(i => <div key={i} className="h-20 animate-pulse rounded-2xl border border-border bg-card" />)}
      </div>}
      {q.isError && <div role="alert" className="rounded-2xl border border-destructive p-4" data-testid="state-error">
        <p className="text-destructive">Invoice history could not be loaded. No records are shown until it loads successfully.</p>
        <Button className="mt-3" size="sm" variant="outline" data-testid="button-retry" onClick={() => void q.refetch()}>Try again</Button>
      </div>}
      {data && data.memberships.length === 0 && <div className="rounded-2xl border border-border bg-card p-6" data-testid="state-empty">
        <h2 className="font-serif text-2xl">{page === 0 ? "Nothing awaiting invoice history" : "No records on this page"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{page === 0 ? "No forfeited founding memberships are currently waiting. This list refreshes automatically." : "Records here may have been reconciled since the previous page loaded. Return to the first page."}</p>
      </div>}
      {data && data.memberships.length > 0 && <ul className="space-y-3">
        {data.memberships.map(m => <li key={m.checkoutId} data-testid={`row-checkout-${m.checkoutId}`} className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">Checkout <code>{m.checkoutId}</code></p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Member</dt><dd><code className="break-all">{m.memberId}</code></dd></div>
            <div><dt className="text-muted-foreground">Subscription</dt><dd>{m.subscriptionId ? <code className="break-all">{m.subscriptionId}</code> : "No subscription identifier available"}</dd></div>
            <div><dt className="text-muted-foreground">Failed attempts</dt><dd className="text-2xl font-semibold">{m.retryAttempts}</dd></div>
            <div><dt className="text-muted-foreground">Next retry eligibility</dt><dd>{m.nextRetryAt ? new Date(m.nextRetryAt).toLocaleString() : "No retry time recorded"}</dd></div>
          </dl>
        </li>)}
      </ul>}
      {data && (page > 0 || next !== null) && <div className="flex gap-3">
        <Button variant="outline" size="sm" data-testid="button-previous" disabled={page === 0 || q.isFetching} onClick={() => setPage(page - 1)}>Previous page</Button>
        <Button variant="outline" size="sm" data-testid="button-next" disabled={next === null || q.isFetching} onClick={goNext}>Next page</Button>
      </div>}
      <Link href="/membership" className="text-primary underline">Back to membership</Link>
    </div>
  </AppLayout>;
}

export default function MembershipInvoiceHistoryPage() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  const role = user?.publicMetadata.role;
  if (!user || (role !== "owner" && role !== "admin")) return <NotFound />;
  return <History key={user.id} userId={user.id} />;
}
