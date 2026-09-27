import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { useGetMembershipOffer, useGetMyMembership, useGetConfirmedMembershipCounts, useCreateMembershipCheckout, useCreateMembershipPortal, getGetMembershipOfferQueryKey, getGetMyMembershipQueryKey, getGetConfirmedMembershipCountsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { trackConfirmedMembershipReturn, trackMembershipCheckoutStarted } from "@/lib/analytics";

export default function MembershipPage() {
  const { user } = useUser();
  const isOwner = user?.publicMetadata.role === "owner" || user?.publicMetadata.role === "admin";
  const queryClient = useQueryClient();
  const counts = useGetConfirmedMembershipCounts({ query: { queryKey: getGetConfirmedMembershipCountsQueryKey(), enabled: isOwner, staleTime: 30000, refetchInterval: 60000 } });
  const { data: offer, isLoading, isError } = useGetMembershipOffer({
    query: { queryKey: getGetMembershipOfferQueryKey(), refetchInterval: 15000, staleTime: 5000 },
  });
  const { data: mine, isError: membershipError, isPending: membershipPending } = useGetMyMembership({
    query: { queryKey: getGetMyMembershipQueryKey(), refetchInterval: 10000, refetchOnMount: "always", refetchOnWindowFocus: "always" },
  });
  const checkout = useCreateMembershipCheckout();
  const portal = useCreateMembershipPortal();
  const [error, setError] = useState("");
  const founding = offer?.phase === "open" && offer.foundingAvailable;
  const canBuy = offer?.phase !== "upcoming" && Boolean(offer);

  useEffect(() => {
    trackConfirmedMembershipReturn(mine?.membership);
  }, [mine?.membership?.kind, mine?.membership?.status]);

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
      trackMembershipCheckoutStarted(kind);
      window.location.assign(result.url);
    } catch (err) {
      queryClient.invalidateQueries({ queryKey: getGetMembershipOfferQueryKey() });
      setError(err instanceof Error ? err.message : "Checkout could not be started. Please try again.");
    }
  }

  async function manage() {
    setError("");
    try {
      const result = await portal.mutateAsync();
      window.location.assign(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing is temporarily unavailable.");
    }
  }

  return <AppLayout>
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <h1 className="font-serif text-4xl">The Elevated Method</h1>
      <p className="text-muted-foreground">Monthly membership is $48/month. During the October 1–7 founding window, $24/month is available only while one of the first 50 places can still be reserved at checkout.</p>
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
