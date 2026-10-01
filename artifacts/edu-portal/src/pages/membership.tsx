import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { useGetMembershipOffer, useGetMyMembership, useGetConfirmedMembershipCounts, useGetMembershipCheckoutCleanupAlerts, useGetMembershipReconciliationAlerts, useRetryMembershipCheckoutCleanup, useCreateMembershipCheckout, useCreateMembershipPortal, getGetMembershipOfferQueryKey, getGetMyMembershipQueryKey, getGetConfirmedMembershipCountsQueryKey, getGetMembershipCheckoutCleanupAlertsQueryKey, getGetMembershipReconciliationAlertsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { trackConfirmedMembershipReturn, trackMembershipCheckoutStarted } from "@/lib/analytics";
import { stripeBillingPortalUrl } from "@/lib/stripe-billing-portal-url";

function stripeCheckoutUrl(value: unknown): string {
  const message = "Checkout could not be started. Please try again.";
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || !/^https:\/\//i.test(value)) {
    throw new Error(message);
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // Treat malformed URLs the same as unexpected destinations.
  }
  throw new Error(message);
}

export default function MembershipPage() {
  const { user } = useUser();
  const isOwner = user?.publicMetadata.role === "owner" || user?.publicMetadata.role === "admin";
  const queryClient = useQueryClient();
  const counts = useGetConfirmedMembershipCounts({ query: { queryKey: getGetConfirmedMembershipCountsQueryKey(), enabled: isOwner, staleTime: 30000, refetchInterval: 60000 } });
  const cleanupAlerts = useGetMembershipCheckoutCleanupAlerts({ query: { queryKey: getGetMembershipCheckoutCleanupAlertsQueryKey(), enabled: isOwner, refetchInterval: 60000, refetchOnWindowFocus: "always" } });
  const reconciliationAlerts = useGetMembershipReconciliationAlerts({ query: { queryKey: getGetMembershipReconciliationAlertsQueryKey(), enabled: isOwner, refetchInterval: 60000, refetchOnWindowFocus: "always" } });
  const { data: offer, isLoading, isError } = useGetMembershipOffer({
    query: { queryKey: getGetMembershipOfferQueryKey(), refetchInterval: 15000, staleTime: 5000 },
  });
  const { data: mine, isError: membershipError, isPending: membershipPending } = useGetMyMembership({
    query: { queryKey: [...getGetMyMembershipQueryKey(), user?.id], enabled: Boolean(user), refetchInterval: 10000, refetchOnMount: "always", refetchOnWindowFocus: "always" },
  });
  const checkout = useCreateMembershipCheckout();
  const portal = useCreateMembershipPortal();
  const retryCleanup = useRetryMembershipCheckoutCleanup();
  const [retryingSession, setRetryingSession] = useState<string | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [cleanupError, setCleanupError] = useState("");
  const [error, setError] = useState("");
  const founding = offer?.phase === "open" && offer.foundingAvailable;
  const canBuy = offer?.phase !== "upcoming" && Boolean(offer);

  useEffect(() => {
    if (!membershipError) trackConfirmedMembershipReturn(mine?.membership);
  }, [mine?.membership?.kind, mine?.membership?.status, mine?.membership?.checkoutSessionId, membershipError]);

  useEffect(() => {
    const refreshAfterPortal = () => {
      queryClient.invalidateQueries({ queryKey: getGetMyMembershipQueryKey() });
    };
    window.addEventListener("pageshow", refreshAfterPortal);
    return () => window.removeEventListener("pageshow", refreshAfterPortal);
  }, [queryClient]);

  async function begin(kind: "founding" | "standard") {
    setError("");
    try {
      const result = await checkout.mutateAsync({ data: { kind } });
      const checkoutUrl = stripeCheckoutUrl(result?.url);
      trackMembershipCheckoutStarted(kind);
      window.location.assign(checkoutUrl);
    } catch (err) {
      queryClient.invalidateQueries({ queryKey: getGetMembershipOfferQueryKey() });
      setError(err instanceof Error ? err.message : "Checkout could not be started. Please try again.");
    }
  }

  async function manage() {
    setError("");
    try {
      const result = await portal.mutateAsync();
      window.location.assign(stripeBillingPortalUrl(result?.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing is temporarily unavailable.");
    }
  }

  async function retrySession(sessionId: string) {
    setRetryingSession(sessionId);
    setCleanupError("");
    setCleanupMessage("");
    try {
      await retryCleanup.mutateAsync({ sessionId });
      setCleanupMessage(`Cleanup resolved for ${sessionId}.`);
    } catch {
      setCleanupError(`Cleanup retry failed for ${sessionId}. The alert remains queued; please try again later.`);
      setRetryingSession(null);
      return;
    }
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetMembershipCheckoutCleanupAlertsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetConfirmedMembershipCountsQueryKey() }),
    ]);
    setRetryingSession(null);
  }

  return <AppLayout>
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <h1 className="font-serif text-4xl">The Elevated Method</h1>
      <p className="text-muted-foreground">Monthly membership is $48/month. During the October 1–7 founding window, $24/month is available only while one of the first 50 places can still be reserved at checkout.</p>
      {isOwner && (cleanupAlerts.isError
        ? <p role="alert" className="rounded-2xl border border-destructive p-4 text-destructive">Checkout cleanup alerts are unavailable. Check server logs for failed expiration retries.</p>
        : cleanupAlerts.data?.total ? <section role="alert" className="rounded-2xl border border-destructive bg-card p-6">
          <h2 className="font-serif text-2xl">Checkout cleanup needs attention</h2>
          <p className="mt-2">{cleanupAlerts.data.total} checkout {cleanupAlerts.data.total === 1 ? "session has" : "sessions have"} remained queued for over 10 minutes. Check the session status in Stripe or retry the server check. Paid and completed checkouts will not be expired.</p>
          <ul className="mt-3 space-y-2 text-sm">
            {cleanupAlerts.data.sessions.map(session => <li key={session.sessionId} className="flex flex-wrap items-center gap-2">
              <code>{session.sessionId}</code> · queued {new Date(session.queuedAt).toLocaleString()}
              <Button size="sm" variant="outline" disabled={retryingSession !== null} onClick={() => retrySession(session.sessionId)}>
                {retryingSession === session.sessionId ? "Retrying…" : "Retry cleanup"}
              </Button>
            </li>)}
          </ul>
          {cleanupAlerts.data.total > cleanupAlerts.data.sessions.length && <p className="mt-2 text-sm">Showing the oldest 100 sessions. Check server logs for the remaining failures.</p>}
        </section> : null)}
      {isOwner && (reconciliationAlerts.isError
        ? <p role="alert" className="rounded-2xl border border-destructive p-4 text-destructive">Billing review alerts are unavailable. Check server logs for reconciliation failures.</p>
        : reconciliationAlerts.data?.total ? <section role="alert" className="rounded-2xl border border-destructive bg-card p-6">
          <h2 className="font-serif text-2xl">Founding billing reviews need attention</h2>
          <p className="mt-2">{reconciliationAlerts.data.total} founding {reconciliationAlerts.data.total === 1 ? "subscription has" : "subscriptions have"} failed review at least three times in a row. Check the subscription in Stripe and server logs; the server will keep retrying.</p>
          <ul className="mt-3 space-y-1 text-sm">
            {reconciliationAlerts.data.subscriptions.map(subscription => <li key={subscription.subscriptionId}><code>{subscription.subscriptionId}</code> · {subscription.consecutiveFailures} failed reviews · first failed {new Date(subscription.firstFailedAt).toLocaleString()} · last failed {new Date(subscription.lastFailedAt).toLocaleString()}</li>)}
          </ul>
          {reconciliationAlerts.data.total > reconciliationAlerts.data.subscriptions.length && <p className="mt-2 text-sm">Showing the latest 100 subscriptions. Check server logs for the remaining failures.</p>}
        </section> : null)}
      {isOwner && !reconciliationAlerts.isError && reconciliationAlerts.data?.sweepFailure && <section role="alert" className="rounded-2xl border border-destructive bg-card p-6">
        <h2 className="font-serif text-2xl">Membership review sweep needs attention</h2>
        <p className="mt-2">The membership review sweep could not complete {reconciliationAlerts.data.sweepFailure.consecutiveFailures} times in a row. Founding memberships may not have been checked. This is a review service outage, not evidence of a member payment problem.</p>
        <p className="mt-2 text-sm">First failed {new Date(reconciliationAlerts.data.sweepFailure.firstFailedAt).toLocaleString()} · last failed {new Date(reconciliationAlerts.data.sweepFailure.lastFailedAt).toLocaleString()}.</p>
        <p className="mt-2 text-sm">Check the database and Stripe connection in server logs. The server keeps retrying; a completed sweep clears this warning automatically.</p>
      </section>}
      {isOwner && !reconciliationAlerts.isError && reconciliationAlerts.data?.subscriptionsAvailable === false && <p role="alert" className="text-destructive">Individual billing review alerts cannot be checked while the database is unavailable.</p>}
      {isOwner && cleanupError && <p role="alert" className="text-destructive">{cleanupError}</p>}
      {isOwner && cleanupMessage && <p role="status">{cleanupMessage}</p>}
      {isOwner && <section aria-label="Paid enrollment counts" className="rounded-2xl border border-border bg-card p-6">
        <h2 className="font-serif text-2xl">Paid enrollments · owner view</h2>
        <p className="mt-2 text-sm text-muted-foreground">Currently confirmed membership records, including buyers who never returned from Stripe checkout. Pending and forfeited memberships are not included.</p>
        {counts.isPending ? <p className="mt-4">Loading confirmed counts…</p> : counts.isError ? <p role="alert" className="mt-4">Confirmed counts are unavailable right now.</p> : <div className="mt-4 grid grid-cols-2 gap-4">
          <div><p className="text-sm text-muted-foreground">Founding</p><p className="text-3xl font-semibold">{counts.data.founding}</p></div>
          <div><p className="text-sm text-muted-foreground">Standard</p><p className="text-3xl font-semibold">{counts.data.standard}</p></div>
        </div>}
        <p className="mt-4 text-sm text-muted-foreground">Compare these server-confirmed totals with the browser funnel events <code>membership_checkout_started</code> and <code>membership_enrollment_confirmed</code> in analytics. Checkout-start and confirmed-return event counts are not guaranteed to match these totals: a buyer can close the tab before returning, and browser tracking can be blocked. No member details are sent to analytics.</p>
      </section>}
      {membershipError && <p role="alert" className="text-destructive">Your membership status could not be checked. Please try again later.</p>}
      {!membershipError && mine?.membership ? <div className="rounded-2xl border border-primary/40 bg-card p-6">
        {mine.membership.status === "confirmed" ? <>
          <p className="font-semibold">Your {mine.membership.kind === "founding" ? "Founding Member" : "Elevated Method"} membership is {mine.membership.cancellationDate ? "active until your scheduled cancellation." : "active."}</p>
          {mine.membership.cancellationDate && <p className="mt-2 text-sm text-muted-foreground">
            Your cancellation takes effect on {new Date(mine.membership.cancellationDate).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}. You keep access until then.
          </p>}
          <Button className="mt-4" onClick={manage} disabled={portal.isPending}>Manage billing or cancel</Button>
        </> : mine.membership.status === "forfeited" ? <>
          <p className="font-semibold">Your {mine.membership.kind === "founding" ? "Founding Member" : "Elevated Method"} membership has ended.</p>
          <p className="mt-2 text-sm text-muted-foreground">Access is no longer active. A Founding Member place cannot be restored after it is forfeited.</p>
        </> : <>
          <p className="font-semibold">Your checkout is awaiting payment confirmation.</p>
          <p className="mt-2 text-sm text-muted-foreground">If you have already paid, this page will update shortly. Otherwise, you can return to your existing checkout.</p>
          <Button className="mt-4" onClick={() => begin(mine.membership!.kind)} disabled={checkout.isPending}>Continue checkout</Button>
        </>}
      </div> : null}
      {!membershipError && !membershipPending && (!mine?.membership || mine.membership.status === "forfeited") && <>
        {isLoading && <p>Checking availability…</p>}
        {isError && <p role="alert">Enrollment availability could not be checked. Please try again later.</p>}
        {offer?.phase === "upcoming" && <p>Enrollment opens October 1, 2026 at 9 AM Central. Founding enrollment closes October 7 at 11:59 PM Central.</p>}
        {offer?.phase === "closed" && <p>The founding enrollment window has closed. Standard membership remains available.</p>}
        {offer?.phase === "open" && !founding && <p>Founding places are all claimed or reserved. Standard membership remains available.</p>}
        {founding && <div className="rounded-2xl border border-primary/40 bg-card p-6">
          <h2 className="font-serif text-2xl">Founding Member · $24/month</h2>
          <p className="mt-2 text-sm text-muted-foreground">A place is reserved only when checkout starts, subject to availability. The rate stays locked while your account remains in good standing. Three consecutive monthly payment failures remove founding status. Cancelling removes it at the end of the paid period.</p>
          <Button className="mt-4" onClick={() => begin("founding")} disabled={checkout.isPending}>Continue to secure checkout</Button>
        </div>}
        {canBuy && <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="font-serif text-2xl">Standard · $48/month</h2>
          <Button className="mt-4" variant="outline" onClick={() => begin("standard")} disabled={checkout.isPending}>Join at the standard rate</Button>
        </div>}
        <p className="text-sm text-muted-foreground">Checkout is hosted by Stripe. You can manage or cancel your membership from this page afterward.</p>
      </>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Link href="/dashboard" className="text-primary underline">Back to dashboard</Link>
    </div>
  </AppLayout>;
}
