import { useState, type FormEvent } from "react";
import { useUser } from "@clerk/react";
import { useLookupRoutineGuideRecords, useRemoveRoutineGuideRecords, type GuideRecordReview } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGuidePageMeta } from "@/lib/guide-page-meta";

export function GuideRecordForm() {
  const [email, setEmail] = useState("");
  const [review, setReview] = useState<GuideRecordReview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lookup = useLookupRoutineGuideRecords();
  const remove = useRemoveRoutineGuideRecords();
  const pending = lookup.isPending || remove.isPending;
  async function find(event: FormEvent) {
    event.preventDefault();
    setReview(null); setConfirmation(""); setMessage(""); setError("");
    try {
      setReview(await lookup.mutateAsync({ data: { email: email.trim().toLowerCase() } }));
    } catch {
      setError("Could not look up guide records. No records were removed. Try the lookup again.");
    }
  }
  async function erase(event: FormEvent) {
    event.preventDefault();
    if (!review || confirmation !== review.email || pending) return;
    setError(""); setMessage("");
    try {
      const result = await remove.mutateAsync({ data: { email: review.email, confirmationEmail: confirmation, revision: review.revision } });
      if (result.erased !== true || result.email !== review.email) throw new Error("Unconfirmed removal");
      setMessage(`Local guide records for ${result.email} were removed. No email was sent. Resend’s separate records are not confirmed erased.`);
      setReview(null); setConfirmation("");
    } catch {
      setReview(null); setConfirmation("");
      setError("Removal was not confirmed. Records may have changed, a delivery may still be active, or the service may be unavailable. Look up the address again before retrying; do not assume it was removed.");
    }
  }
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-serif text-3xl">Guide record removal</h1>
      <p className="text-muted-foreground">Handle requests received at hello@elevatedbeautymethod.com. Verify the requester’s right to this address before removing anything. This tool only reviews and removes routine-guide records.</p>
      <form onSubmit={find} className="space-y-3 rounded-xl border bg-card p-6">
        <label htmlFor="guide-record-email" className="block text-sm font-medium">Requested email address</label>
        <Input id="guide-record-email" type="email" required maxLength={254} autoComplete="off" value={email} disabled={pending} onChange={event => { setEmail(event.target.value); setReview(null); setConfirmation(""); setError(""); setMessage(""); }} />
        <Button type="submit" disabled={pending}>{lookup.isPending ? "Looking up…" : "Look up guide records"}</Button>
      </form>
      {review && <section className="space-y-4 rounded-xl border bg-card p-6" aria-label="Guide records found">
        <h2 className="font-serif text-xl">Records for {review.email}</h2>
        <p>{review.claims} consent records · {review.deliveries} delivery/retry records · {review.emailCounters} hashed email counters</p>
        <p className="text-sm text-muted-foreground">Includes all stored routine-guide versions. Shared hashed IP counters are not address-specific and expire separately. Accounts, subscriptions, Audit answers, and all other data are untouched.</p>
        {review.activeDelivery ? <p role="alert">A delivery attempt is still active. Wait and look up this address again before removing its records.</p>
          : review.claims + review.deliveries + review.emailCounters === 0 ? <p>No local guide records were found for this address.</p>
          : <form onSubmit={erase} className="space-y-3">
            <label htmlFor="guide-record-confirm" className="block text-sm font-medium">Type {review.email} to confirm permanent guide-only removal</label>
            <Input id="guide-record-confirm" autoComplete="off" value={confirmation} disabled={pending} onChange={event => setConfirmation(event.target.value)} />
            <Button type="submit" variant="destructive" disabled={pending || confirmation !== review.email}>{remove.isPending ? "Removing…" : "Permanently remove guide records"}</Button>
          </form>}
      </section>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {message && <p role="status">{message}</p>}
      <p className="text-sm text-muted-foreground">Resend may retain its own email and delivery records under its separate retention policies. This tool does not delete provider-held records, recall messages already sent or being processed, or send a new email. A later new request with explicit consent can create new records.</p>
    </div>
  );
}

export default function GuideRecordsPage() {
  useGuidePageMeta("Guide record removal | The Elevated Beauty Method ™", "Owner-only routine-guide record removal.");
  const { user } = useUser();
  // Remount all private review/mutation state if the signed-in identity changes.
  return <AppLayout><GuideRecordForm key={user?.id} /></AppLayout>;
}