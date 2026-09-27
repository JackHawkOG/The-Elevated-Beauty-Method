import { useState } from "react";
import { Link } from "wouter";
import { useGetMembershipOffer, useGetMyMembership, useCreateMembershipCheckout, useCreateMembershipPortal, getGetMembershipOfferQueryKey, getGetMyMembershipQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";

export default function MembershipPage() {
  const queryClient = useQueryClient();
  const { data: offer, isLoading, isError } = useGetMembershipOffer({
    query: { queryKey: getGetMembershipOfferQueryKey(), refetchInterval: 15000, staleTime: 5000 },
  });
  const { data: mine } = useGetMyMembership({ query: { queryKey: getGetMyMembershipQueryKey(), refetchInterval: 10000 } });
  const checkout = useCreateMembershipCheckout();
  const portal = useCreateMembershipPortal();
  const [error, setError] = useState("");
  const founding = offer?.phase === "open" && offer.foundingAvailable;
  const canBuy = offer?.phase !== "upcoming" && Boolean(offer);

  async function begin(kind: "founding" | "standard") {
    setError("");
    try {
      const result = await checkout.mutateAsync({ data: { kind } });
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
      {mine?.membership ? <div className="rounded-2xl border border-primary/40 bg-card p-6">
        {mine.membership.status === "confirmed" ? <>
          <p className="font-semibold">Your {mine.membership.kind === "founding" ? "Founding Member" : "Elevated Method"} membership is active.</p>
          <Button className="mt-4" onClick={manage} disabled={portal.isPending}>Manage billing or cancel</Button>
        </> : <>
          <p className="font-semibold">Your checkout is awaiting payment confirmation.</p>
          <p className="mt-2 text-sm text-muted-foreground">If you have already paid, this page will update shortly. Otherwise, you can return to your existing checkout.</p>
          <Button className="mt-4" onClick={() => begin(mine.membership!.kind)} disabled={checkout.isPending}>Continue checkout</Button>
        </>}
      </div> : <>
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