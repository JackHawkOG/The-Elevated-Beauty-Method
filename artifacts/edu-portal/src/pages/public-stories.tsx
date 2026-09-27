import { Link } from "wouter";
import { useListPublishedMemberStories, getListPublishedMemberStoriesQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { StoryRemovalRequest } from "@/components/story-removal-request";
import { Button } from "@/components/ui/button";

export default function PublicStoriesPage() {
  const stories = useListPublishedMemberStories({
    query: { queryKey: getListPublishedMemberStoriesQueryKey(), staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: "always" },
  });
  return <AppLayout>
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-12">
      <div>
        <h1 className="font-serif text-4xl">Member stories</h1>
        <p className="mt-3 text-muted-foreground">If a story attributed to you is here and you no longer want it published, request removal beneath that story. We hide it immediately and the owner reviews your request privately.</p>
      </div>
      {stories.isPending ? <p>Loading stories…</p> :
        stories.isError ? <div role="alert">Could not load stories. <Button variant="outline" onClick={() => void stories.refetch()}>Retry</Button></div> :
        !stories.data?.length ? <p>No stories are currently published.</p> :
        <div className="space-y-5">{stories.data.map(story =>
          <article key={story.id} className="rounded-2xl border border-border bg-card p-6">
            <blockquote className="whitespace-pre-wrap break-words font-serif text-xl">“{story.quote}”</blockquote>
            <p className="mt-4 break-words text-primary">— {story.attribution}</p>
            <StoryRemovalRequest storyId={story.id} />
          </article>)}</div>}
      <Link href="/dashboard" className="text-sm text-muted-foreground underline underline-offset-4">Back to dashboard</Link>
    </main>
  </AppLayout>;
}