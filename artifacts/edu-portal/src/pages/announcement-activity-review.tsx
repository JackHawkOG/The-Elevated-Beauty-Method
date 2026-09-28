import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListAnnouncementActivityReviewQueryKey,
  useListAnnouncementActivityReview,
  useAttachAnnouncementActivity,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";

export default function AnnouncementActivityReviewPage() {
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
            {!item.candidates.length && <p className="mt-2 text-sm text-muted-foreground">No feed records share this title. Leave this post unlinked; do not invent a feed entry here.</p>}
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
    </main>
  </AppLayout>;
}