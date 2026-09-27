import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListManagedMemberStories, usePublishMemberStory, useWithdrawMemberStory,
  getListManagedMemberStoriesQueryKey, getListPublishedMemberStoriesQueryKey,
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
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListManagedMemberStoriesQueryKey() });
    void qc.invalidateQueries({ queryKey: getListPublishedMemberStoriesQueryKey() });
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
  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    publish.mutate({ data: { quote: quote.trim(), attribution: attribution.trim(), permissionRecord: permissionRecord.trim(), permissionConfirmed: true } });
  }
  return <AppLayout>
    <main className="mx-auto w-full max-w-4xl space-y-10 px-6 py-12">
      <div>
        <h1 className="font-serif text-4xl">Member stories</h1>
        <p className="mt-2 text-muted-foreground">Publish only a quote and attribution the member explicitly approved. Keep the permission record here so you can find and withdraw a story later.</p>
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
      <section aria-labelledby="story-list-title">
        <h2 id="story-list-title" className="mb-4 font-serif text-2xl">Stories and permission records</h2>
        {list.isPending ? <p>Loading stories…</p> :
          list.isError ? <div role="alert">Could not load stories. <Button variant="outline" onClick={() => void list.refetch()}>Retry</Button></div> :
          !list.data?.length ? <p className="text-muted-foreground">No stories have been published yet.</p> :
          <div className="space-y-4">{list.data.map(story =>
            <article key={story.id} className="rounded-2xl border border-border bg-card p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Story #{story.id} · {story.withdrawnAt ? "Withdrawn" : "Published"}</p>
                  <blockquote className="mt-3 whitespace-pre-wrap break-words">“{story.quote}”</blockquote>
                  <p className="mt-2 break-words text-primary">— {story.attribution}</p>
                  <p className="mt-4 break-words text-xs text-muted-foreground">Permission recorded {new Date(story.permissionRecordedAt).toLocaleString()}: {story.permissionRecord}</p>
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