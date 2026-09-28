import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  getListAnnouncementActivityReviewQueryKey,
  useListAnnouncementActivityReview,
  useAttachAnnouncementActivity,
  getListAnnouncementActivityCorrectionsQueryKey,
  useListAnnouncementActivityCorrections,
  useCorrectAnnouncementActivity,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";

function CorrectionSection() {
  const client = useQueryClient();
  const list = useListAnnouncementActivityCorrections({
    query: { queryKey: getListAnnouncementActivityCorrectionsQueryKey(), staleTime: 0, refetchOnWindowFocus: "always" },
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [rationale, setRationale] = useState("");
  const [evidence, setEvidence] = useState("");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("");
  const correction = useCorrectAnnouncementActivity({ mutation: {
    onSuccess: () => {
      setSelected(null); setMessage("Correction saved with its review history.");
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityCorrectionsQueryKey() });
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityReviewQueryKey() });
    },
    onError: () => {
      setSelected(null); setMessage("No correction was saved. The link or target may have changed; refresh and review again.");
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityCorrectionsQueryKey() });
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityReviewQueryKey() });
    },
  } });
  const chosen = list.data?.targets.find(item => String(item.id) === target);
  return <section className="space-y-5 border-t border-border pt-8">
    <h2 className="font-serif text-3xl">Correct a reviewed feed link</h2>
    <p className="text-sm text-muted-foreground">Owner only. Unlink a mistaken match or reassign it to an unassigned historical post. Each correction retains the previous reviewer and evidence. Reassignment requires fresh independent evidence. Feed entries are not deleted.</p>
    {message && <p role="status" className="rounded-lg border border-border p-4">{message}</p>}
    <Button variant="outline" disabled={list.isFetching || correction.isPending} onClick={() => { setSelected(null); void list.refetch(); }}>Refresh link history</Button>
    {list.isPending ? <p>Loading reviewed links…</p> : list.isError ? <p role="alert">Could not load reviewed links.</p> :
      !list.data?.records.length ? <p>No manually reviewed links yet.</p> :
        <div className="space-y-5">{list.data.records.map(row => <article key={row.activityId} className="rounded-xl border border-border bg-card p-6">
          <h3 className="font-semibold">Feed #{row.activityId}: {row.entityTitle}</h3>
          <p className="mt-2 text-sm">Actor: {row.actorName} · {new Date(row.createdAt).toLocaleString()} · {row.description}</p>
          <p className="mt-2 text-sm">Current assignment: {row.sourceAnnouncementId === null ? "Unlinked" : `Post #${row.sourceAnnouncementId}`}</p>
          {row.sourceReviewedBy && <p className="text-sm">Reviewed by {row.sourceReviewedBy} on {row.sourceReviewedAt ? new Date(row.sourceReviewedAt).toLocaleString() : "unknown date"} · Evidence: {row.sourceEvidence ?? "Not recorded"}</p>}
          {row.history.length > 0 && <div className="mt-4 space-y-3 border-t border-border pt-3">
            <h4 className="font-semibold">Correction history</h4>
            {row.history.map(entry => <div key={entry.id} className="rounded-lg bg-background p-3 text-sm">
              <p>Post #{entry.fromAnnouncementId ?? "unlinked"} → {entry.toAnnouncementId === null ? "unlinked" : `post #${entry.toAnnouncementId}`} · {new Date(entry.correctedAt).toLocaleString()} · by {entry.correctedBy}</p>
              <p>Reason: {entry.rationale}</p>
              <p>Previous review: {entry.previousReviewedBy ?? "none"} · {entry.previousReviewedAt ? new Date(entry.previousReviewedAt).toLocaleString() : "no date"} · Evidence: {entry.previousEvidence ?? "none"}</p>
              {entry.evidence && <p>New evidence: {entry.evidence}</p>}
            </div>)}
          </div>}
          {selected === row.activityId ? <form className="mt-5 space-y-3 border-t border-border pt-4" onSubmit={event => {
            event.preventDefault();
            correction.mutate({ activityId: row.activityId, data: {
              revision: row.revision, announcementId: target ? Number(target) : null,
              rationale: rationale.trim(), ...(target ? { evidence: evidence.trim(), independentlyVerified: verified } : {}),
            } });
          }}>
            <label className="block text-sm">New assignment
              <select className="mt-2 w-full rounded-lg border border-border bg-background p-3" value={target} onChange={event => { setTarget(event.target.value); setEvidence(""); setVerified(false); }}>
                <option value="">Unlink this feed entry</option>
                {list.data?.targets.filter(item => item.assignedActivityId === null && item.id !== row.sourceAnnouncementId).map(item =>
                  <option key={item.id} value={item.id}>Post #{item.id}: {item.title}</option>)}
              </select>
            </label>
            {chosen && <div className="rounded-lg border border-border p-3 text-sm">
              <p>Post #{chosen.id} · {chosen.authorName} · {new Date(chosen.createdAt).toLocaleString()}</p>
              <p className="mt-2 font-semibold">{chosen.title}</p>
              <p className="mt-2 whitespace-pre-wrap break-words">{chosen.body}</p>
            </div>}
            <label className="block text-sm">Why is the current assignment wrong? (20–2000 characters)
              <textarea className="mt-2 min-h-24 w-full rounded-lg border border-border bg-background p-3" required minLength={20} maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)} />
            </label>
            {target && <>
              <label className="block text-sm">Independent evidence for the new pairing
                <textarea className="mt-2 min-h-24 w-full rounded-lg border border-border bg-background p-3" required minLength={20} maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} />
              </label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} required />I verified evidence beyond the title, author and timestamp for this exact pairing.</label>
            </>}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" disabled={correction.isPending} onClick={() => setSelected(null)}>Cancel</Button>
              <Button type="submit" disabled={correction.isPending || rationale.trim().length < 20 || (!target && row.sourceAnnouncementId === null) || (!!target && (!verified || evidence.trim().length < 20))}>Save correction</Button>
            </div>
          </form> : <Button className="mt-4" variant="outline" disabled={correction.isPending} onClick={() => { setSelected(row.activityId); setTarget(""); setRationale(""); setEvidence(""); setVerified(false); setMessage(""); }}>Correct this link</Button>}
        </article>)}</div>}
  </section>;
}

export default function AnnouncementActivityReviewPage() {
  const { user } = useUser();
  const client = useQueryClient();
  const list = useListAnnouncementActivityReview({
    query: { queryKey: getListAnnouncementActivityReviewQueryKey(), staleTime: 0, refetchOnWindowFocus: "always" },
  });
  const [selected, setSelected] = useState<{ announcementId: number; activityId: number } | null>(null);
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const attach = useAttachAnnouncementActivity({ mutation: {
    onSuccess: () => {
      setSelected(null); setEvidence(""); setConfirmed(false);
      setMessage("Source ID attached. The reviewed entry is no longer in the queue.");
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityReviewQueryKey() });
    },
    onError: () => {
      setMessage("Nothing was linked. The review may have changed; reload and inspect the records again.");
      setSelected(null); setEvidence(""); setConfirmed(false);
      void client.invalidateQueries({ queryKey: getListAnnouncementActivityReviewQueryKey() });
    },
  } });

  function submit(event: FormEvent, announcementId: number, activityId: number, revision: string) {
    event.preventDefault();
    setMessage("");
    attach.mutate({ announcementId, data: { activityId, revision, evidence: evidence.trim(), independentlyVerified: confirmed } });
  }
  return <AppLayout>
    <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-12">
      <div>
        <h1 className="font-serif text-4xl">Older announcement feed review</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">These historical posts could not be safely matched automatically. Compare the complete post with the feed record and an independent source (for example, a dated publication record). Matching titles, authors or timestamps alone are not enough. Leave uncertain records unlinked. Linking does not create a new feed entry.</p>
      </div>
      {message && <p role="status" className="rounded-lg border border-border p-4">{message}</p>}
      <Button variant="outline" onClick={() => { setSelected(null); setEvidence(""); setConfirmed(false); void list.refetch(); }} disabled={list.isFetching || attach.isPending}>Refresh reviews</Button>
      {list.isPending ? <p>Loading review queue…</p> :
        list.isError ? <p role="alert">Could not load the review queue. Try refreshing.</p> :
        !list.data?.length ? <p>No ambiguous announcement records currently need review.</p> :
          <div className="space-y-6">{list.data.map(item => <article key={item.announcementId} className="rounded-xl border border-border bg-card p-6">
            <h2 className="font-serif text-2xl">Post #{item.announcementId}: {item.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">By {item.authorName} · {new Date(item.createdAt).toLocaleString()} · {item.reason}</p>
            <p className="mt-4 whitespace-pre-wrap break-words text-sm">{item.body}</p>
            <h3 className="mt-6 border-t border-border pt-5 font-semibold">Possible feed records</h3>
            {!item.candidates.length && <p className="mt-2 text-sm text-muted-foreground">No feed records are available for staff review. Leave this post unlinked; previously corrected records can only be reassigned by an owner below.</p>}
            <div className="mt-3 space-y-4">{item.candidates.map(candidate => <div key={candidate.id} className="rounded-lg border border-border bg-background p-4 text-sm">
              <p className="font-semibold">Feed #{candidate.id}: {candidate.entityTitle}</p>
              <p className="mt-1 text-muted-foreground">Actor: {candidate.actorName} · {new Date(candidate.createdAt).toLocaleString()} · {candidate.description}</p>
              {candidate.sourceAnnouncementId !== null ? <p className="mt-2 text-amber-500">Already linked to post #{candidate.sourceAnnouncementId}. Cannot assign twice.</p> :
                selected?.announcementId === item.announcementId && selected.activityId === candidate.id ?
                  <form className="mt-4 space-y-3" onSubmit={e => submit(e, item.announcementId, candidate.id, item.revision)}>
                    <label className="block">Independent evidence for this exact post and feed record (where to find it, and what it confirms)
                      <textarea className="mt-2 min-h-24 w-full rounded-lg border border-border bg-background p-3" value={evidence} onChange={e => setEvidence(e.target.value)} minLength={20} maxLength={2000} required />
                    </label>
                    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required />I verified evidence beyond the title, author and timestamp for this exact pairing.</label>
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" disabled={attach.isPending} onClick={() => { setSelected(null); setEvidence(""); setConfirmed(false); }}>Cancel</Button>
                      <Button type="submit" disabled={attach.isPending || !confirmed || evidence.trim().length < 20}>Attach source ID</Button>
                    </div>
                  </form> :
                  <Button className="mt-3" variant="outline" disabled={attach.isPending} onClick={() => { setSelected({ announcementId: item.announcementId, activityId: candidate.id }); setEvidence(""); setConfirmed(false); setMessage(""); }}>Review this pairing</Button>}
            </div>)}</div>
          </article>)}</div>}
      {user?.publicMetadata.role === "owner" && <CorrectionSection />}
    </main>
  </AppLayout>;
}