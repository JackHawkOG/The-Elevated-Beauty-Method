import { useState, type FormEvent } from "react";
import { useClerk, useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { getListPublishedMemberStoriesQueryKey, useRequestMemberStoryRemoval } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function StoryRemovalRequest({ storyId }: { storyId: number }) {
  const { user, isLoaded } = useUser();
  const { openSignIn } = useClerk();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const request = useRequestMemberStoryRemoval({ mutation: {
    onSuccess: () => {
      setDone(true);
      setNote("");
      toast({ title: "Story hidden", description: "Your removal request was received. The owner can now review it privately." });
      void queryClient.invalidateQueries({ queryKey: getListPublishedMemberStoriesQueryKey() });
    },
    onError: error => setError(error.status === 429
      ? "You can submit one removal request every 24 hours. Please contact the owner directly if another story needs urgent removal."
      : "We couldn't submit your request. The story may still be public. Please try again."),
  } });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    request.mutate({ storyId, data: { note: note.trim() } });
  }

  if (done) return <p role="status" className="mt-4 text-sm">Your request was received. This story is now hidden while the owner reviews it.</p>;

  return <div className="mt-5 border-t border-border/60 pt-4 text-sm">
    {!open ? <button type="button" className="text-muted-foreground underline underline-offset-4 hover:text-primary" onClick={() => setOpen(true)}>Is this your story? Request removal</button> :
      <div className="space-y-3">
        <p>This story will be hidden immediately after your request. The owner will review your claim and permission record privately. You can submit one removal request every 24 hours.</p>
        {!isLoaded ? <p>Checking sign-in…</p> : !user ?
          <Button variant="outline" type="button" onClick={() => void openSignIn()}>Sign in to request removal</Button> :
          <form onSubmit={submit} className="space-y-3">
            <label className="block">How is this story connected to you? This note is private to the owner.
              <textarea className="mt-2 min-h-20 w-full rounded-lg border border-border bg-background p-3" value={note} onChange={event => setNote(event.target.value)} required maxLength={500} />
            </label>
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={request.isPending || !note.trim()}>{request.isPending ? "Submitting…" : "Request removal now"}</Button>
          </form>}
        <button type="button" className="block text-muted-foreground underline underline-offset-4" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
      </div>}
  </div>;
}