import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListManagedMemberStories, usePublishMemberStory, useWithdrawMemberStory, useReviewMemberStoryRemoval,
  useCorrectMemberStoryRemovalReview,
  getListManagedMemberStoriesQueryKey, getListPublishedMemberStoriesQueryKey, getListMemberStoryRemovalAlertsQueryKey,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";

export default function MemberStoriesPage() {
  const qc = useQueryClient();
  const list = useListManagedMemberStories({ query: { queryKey: getListManagedMemberStoriesQueryKey(), staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: "always" } });
  const [quote, setQuote] = useState("");
  const [attribution, setAttribution] = useState("");
  const [permissionRecord, setPermissionRecord] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [withdrawId, setWithdrawId] = useState<number | null>(null);
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<"withdrawal_confirmed" | "claim_unsubstantiated" | "inconclusive">("inconclusive");
  const [reviewNote, setReviewNote] = useState("");
  const requests = list.data?.filter(story => story.removalRequestedAt)
    .sort((a, b) => new Date(b.removalRequestedAt!).getTime() - new Date(a.removalRequestedAt!).getTime()) ?? [];
  const outstanding = requests.filter(story => !story.removalReviewedAt && !story.removalReviewOutcome);
  const reviewed = requests.filter(story => story.removalReviewedAt || story.removalReviewOutcome);
  useEffect(() => {
    if (!list.data || !window.location.hash.startsWith("#story-")) return;
    const id = Number(window.location.hash.slice("#story-".length));
    if (Number.isSafeInteger(id) && list.data.some(story => story.id === id)) {
      document.getElementById(`story-${id}`)?.scrollIntoView({ block: "start" });
    }
  }, [list.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListManagedMemberStoriesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListPublishedMemberStoriesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListMemberStoryRemovalAlertsQueryKey() });
  };
  const publish = usePublishMemberStory({ mutation: {
    onSuccess: () => {
      setQuote(""); setAttribution(""); setPermissionRecord(""); setConfirmed(false);
      setMessage("Story published.");
      refresh();
    },
    onError: () => setMessage("Could not publish this story. Nothing was published; please try again."),
  } });
  const withdraw = useWithdrawMemberStory({ mutation: {
    onSuccess: () => {
      setWithdrawId(null);
      setMessage("Story withdrawn from the public landing page.");
      refresh();
    },
    onError: () => setMessage("Could not withdraw this story. Please try again."),
  } });
  const review = useReviewMemberStoryRemoval({ mutation: {
    onSuccess: () => {
      setReviewId(null); setReviewNote(""); setReviewOutcome("inconclusive");
      setMessage("Private review saved. The story remains hidden.");
      refresh();
    },
    onError: () => { setReviewId(null); setReviewNote(""); setMessage("Could not save the review. Check the refreshed history before trying again."); refresh(); },
  } });
  const correction = useCorrectMemberStoryRemovalReview({ mutation: {
    onSuccess: () => {
      setReviewId(null); setReviewNote(""); setReviewOutcome("inconclusive");
      setMessage("Correction saved privately. Earlier decisions remain available and the story stays hidden.");
      refresh();
    },
    onError: () => { setReviewId(null); setReviewNote(""); setMessage("Could not save the correction. Check the refreshed history before trying again."); refresh(); },
  } });
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    publish.mutate({ data: { quote: quote.trim(), attribution: attribution.trim(), permissionRecord: permissionRecord.trim(), permissionConfirmed: true } });
  }
  return <AppLayout>
    <main className="mx-auto w-full max-w-4xl space-y-10 px-6 py-12">
      <div>
        <h1 className="font-serif text-4xl">Member stories</h1>
        <p className="mt-2 text-muted-foreground">Publish only a quote and attribution the member explicitly approved. Keep the permission record here so you can find and withdraw a story later. A member’s removal request hides their story immediately. Review the claim privately; even an unsubstantiated claim does not restore the story. Only publish a new story after obtaining fresh, explicit permission for its exact quote and attribution.</p>
      </div>
      <form onSubmit={submit} className="space-y-5 rounded-2xl border border-border bg-card p-6">
        <h2 className="font-serif text-2xl">Publish an approved story</h2>
        <label className="block text-sm">Approved quote
          <textarea className="mt-2 min-h-28 w-full rounded-lg border border-border bg-background p-3" value={quote} onChange={e => setQuote(e.target.value)} required maxLength={2000} />
        </label>
        <label className="block text-sm">Approved public attribution
          <input className="mt-2 w-full rounded-lg border border-border bg-background p-3" value={attribution} onChange={e => setAttribution(e.target.value)} required maxLength={120} />
        </label>
        <label className="block text-sm">Permission record (how and when the member authorized this exact quote and attribution)
          <textarea className="mt-2 min-h-24 w-full rounded-lg border border-border bg-background p-3" value={permissionRecord} onChange={e => setPermissionRecord(e.target.value)} required maxLength={2000} />
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required />
          I confirm the member explicitly gave permission to publish this quote with this attribution.
        </label>
        <Button type="submit" disabled={!confirmed || publish.isPending}> {publish.isPending ? "Publishing…" : "Publish story"}</Button>
      </form>
      {message && <p role="status">{message}</p>}
      <section aria-labelledby="removal-requests-title" className="rounded-2xl border border-destructive/50 bg-destructive/10 p-6">
        <h2 id="removal-requests-title" className="font-serif text-2xl">Outstanding removal requests ({outstanding.length})</h2>
        {list.isPending ? <p className="mt-2 text-sm">Loading requests…</p> :
          list.isError ? <p className="mt-2 text-sm" role="alert">Could not load requests. <Button variant="outline" onClick={() => void list.refetch()}>Retry</Button></p> :
          outstanding.length === 0 ? <p className="mt-2 text-sm">No outstanding requests.</p> : <>
        <p className="mt-2 text-sm">These stories were hidden immediately. Check each request against its permission record privately before saving a review.</p>
        <ul className="mt-3 space-y-1">{outstanding.map(story => <li key={story.id}>
          <a className="underline underline-offset-2" href={`#story-${story.id}`}>Story #{story.id} · received {new Date(story.removalRequestedAt!).toLocaleString()}</a>
        </li>)}</ul></>}
      </section>
      {reviewed.length > 0 && <section aria-labelledby="reviewed-requests-title" className="rounded-2xl border border-border bg-card p-6">
        <h2 id="reviewed-requests-title" className="font-serif text-2xl">Reviewed removal requests ({reviewed.length})</h2>
        <p className="mt-2 text-sm text-muted-foreground">These stories remain hidden. Their private review and permission records are below.</p>
        <ul className="mt-3 space-y-1">{reviewed.map(story => <li key={story.id}>
          <a className="underline underline-offset-2" href={`#story-${story.id}`}>Story #{story.id} · reviewed {story.removalReviewedAt ? new Date(story.removalReviewedAt).toLocaleString() : "previously"}</a>
        </li>)}</ul>
      </section>}
      <section aria-labelledby="story-list-title">
        <h2 id="story-list-title" className="mb-4 font-serif text-2xl">Stories and permission records</h2>
        {list.isPending ? <p>Loading stories…</p> :
          list.isError ? <div role="alert">Could not load stories. <Button variant="outline" onClick={() => void list.refetch()}>Retry</Button></div> :
          !list.data?.length ? <p className="text-muted-foreground">No stories have been published yet.</p> :
          <div className="space-y-4">{list.data.map(story =>
            <article key={story.id} id={`story-${story.id}`} className="scroll-mt-6 rounded-2xl border border-border bg-card p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Story #{story.id} · {story.withdrawnAt ? "Withdrawn" : "Published"}</p>
                  <blockquote className="mt-3 whitespace-pre-wrap break-words">“{story.quote}”</blockquote>
                  <p className="mt-2 break-words text-primary">— {story.attribution}</p>
                  <p className="mt-4 break-words text-xs text-muted-foreground">Permission recorded {new Date(story.permissionRecordedAt).toLocaleString()}: {story.permissionRecord}</p>
                  {story.removalRequestedAt && <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
                    <p className="font-semibold">Member removal request · Hidden {story.removalReviewOutcome ? "· Reviewed" : "· Review needed"}</p>
                    <p className="mt-2 break-words">Received {new Date(story.removalRequestedAt).toLocaleString()} from {story.removalRequesterEmail || story.removalRequestedBy} (account {story.removalRequestedBy})</p>
                    <p className="mt-2 whitespace-pre-wrap break-words">Member’s note: {story.removalRequestNote}</p>
                    {story.reviewHistory.length > 0 && <div className="mt-3 border-t border-border pt-3">
                      <h3 className="font-semibold">Private review history (oldest first)</h3>
                      <ol className="mt-2 space-y-3">{story.reviewHistory.map((entry, index) => <li key={entry.id} className="border-l-2 border-border pl-3">
                        <p>{index === 0 ? "Original review" : `Correction ${index}`} · {entry.outcome.replaceAll("_", " ")} · {new Date(entry.reviewedAt).toLocaleString()}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words">Reason: {entry.note}</p>
                        <p className="mt-1 text-muted-foreground">Reviewed by {entry.reviewedBy}</p>
                      </li>)}</ol>
                      <p className="mt-2 text-muted-foreground">The latest decision is above. This story stays hidden.</p>
                    </div>}
                    {reviewId === story.id
                        ? <form className="mt-4 space-y-3" onSubmit={e => {
                          e.preventDefault();
                          setMessage("");
                          if (story.reviewHistory.length) {
                            correction.mutate({ storyId: story.id, data: {
                              outcome: reviewOutcome, note: reviewNote.trim(),
                              expectedReviewId: story.reviewHistory[story.reviewHistory.length - 1].id,
                            } });
                          } else {
                            review.mutate({ storyId: story.id, data: { outcome: reviewOutcome, note: reviewNote.trim() } });
                          }
                        }}>
                          <label className="block">Outcome
                            <select className="mt-1 w-full rounded-lg border border-border bg-background p-2" value={reviewOutcome} onChange={e => setReviewOutcome(e.target.value as typeof reviewOutcome)}>
                              <option value="inconclusive">Inconclusive</option>
                              <option value="withdrawal_confirmed">Withdrawal confirmed</option>
                              <option value="claim_unsubstantiated">Claim unsubstantiated</option>
                            </select>
                          </label>
                          <label className="block">{story.reviewHistory.length ? "Reason for correcting the last review (private)" : "Private review notes"}
                            <textarea className="mt-1 w-full rounded-lg border border-border bg-background p-2" value={reviewNote} onChange={e => setReviewNote(e.target.value)} required maxLength={2000} />
                          </label>
                          <p className="text-muted-foreground">Saving any outcome leaves this story hidden. {story.reviewHistory.length ? "Earlier decisions cannot be erased. " : ""}Do not rely on old permission to republish it.</p>
                          <div className="flex gap-2"><Button type="button" variant="ghost" onClick={() => setReviewId(null)} disabled={review.isPending || correction.isPending}>Cancel</Button><Button type="submit" disabled={review.isPending || correction.isPending || !reviewNote.trim()}>{story.reviewHistory.length ? "Save correction" : "Save private review"}</Button></div>
                        </form>
                        : <Button className="mt-3" variant="outline" onClick={() => { setMessage(""); setReviewId(story.id); setReviewNote(""); setReviewOutcome(story.reviewHistory.length ? story.reviewHistory[story.reviewHistory.length - 1].outcome : "inconclusive"); }}>{story.reviewHistory.length ? "Correct last review" : "Record review"}</Button>}
                  </div>}
                </div>
                {!story.withdrawnAt && (withdrawId === story.id
                  ? <div className="flex gap-2"><Button variant="ghost" onClick={() => setWithdrawId(null)} disabled={withdraw.isPending}>Cancel</Button><Button variant="destructive" onClick={() => withdraw.mutate({ storyId: story.id })} disabled={withdraw.isPending}>Confirm withdrawal</Button></div>
                  : <Button variant="outline" onClick={() => { setMessage(""); setWithdrawId(story.id); }}>Withdraw story</Button>)}
              </div>
            </article>)}</div>}
      </section>
    </main>
  </AppLayout>;
}
