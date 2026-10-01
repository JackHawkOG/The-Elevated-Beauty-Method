import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout";
import { 
  listAnnouncements,
  useGetAnnouncement,
  getGetAnnouncementQueryKey,
  createAnnouncement,
  useGetRecentActivity,
  getListAnnouncementsQueryKey,
  getGetRecentActivityQueryKey
} from "@workspace/api-client-react";
import type { Announcement } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { MessageSquare, Clock, Pin, Plus, Loader2 } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { ActivityEntityTitle } from "@/components/activity-entity-title";

function announcementIdFromHash() {
  const match = /^#announcement-([1-9]\d*)$/.exec(window.location.hash);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export default function CommunityPage() {
  const [targetId, setTargetId] = useState(announcementIdFromHash);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Deep links remain available in the full archive, but must not add
  // nonmatching cards to a filtered result.
  const visibleTargetId = search ? null : targetId;
  const pageSize = 20;
  const {
    data: announcementPages, isLoading: announcementsLoading, isError: announcementsError,
    fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError,
    refetch: refetchAnnouncements,
  } = useInfiniteQuery({
    queryKey: [...getListAnnouncementsQueryKey(), "pages", search],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => listAnnouncements({
      limit: pageSize, ...(search ? { search } : {}), ...(pageParam ? { after: pageParam } : {}),
    }, { signal }),
    getNextPageParam: lastPage => lastPage.length === pageSize ? lastPage[lastPage.length - 1].id : undefined,
  });
  const announcements = announcementPages && Array.from(
    new Map(announcementPages.pages.flat().map(post => [post.id, post])).values(),
  );
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  const targetInList = announcements?.some(post => post.id === visibleTargetId);
  const { data: targetedPost, isLoading: targetLoading, isError: targetError } = useGetAnnouncement(visibleTargetId ?? 0, {
    query: { queryKey: getGetAnnouncementQueryKey(visibleTargetId ?? 0), enabled: !!visibleTargetId && !!announcements && !targetInList, retry: false },
  });

  useEffect(() => {
    const onHashChange = () => setTargetId(announcementIdFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!announcements || !visibleTargetId || (!targetInList && !targetedPost)) return;
    const target = document.getElementById(`announcement-${visibleTargetId}`);
    target?.scrollIntoView();
  }, [announcements, visibleTargetId, targetInList, targetedPost]);
  
  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto space-y-8 pb-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-serif font-bold text-foreground tracking-tight mb-2">Community</h1>
            <p className="text-muted-foreground text-lg">Announcements, updates, and conversations from The Elevated Beauty Method ™ community.</p>
          </div>
          <CreateAnnouncementDialog />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <h2 className="text-2xl font-serif font-bold border-b border-border pb-2">Announcements</h2>
            <form role="search" aria-label="Search announcements" className="space-y-2" onSubmit={event => {
              event.preventDefault();
              setSearch(searchInput.trim());
            }}>
              <label htmlFor="announcement-search" className="text-sm font-medium">Search announcements</label>
              <div className="flex flex-wrap gap-2">
                <Input id="announcement-search" type="search" className="flex-1 min-w-40"
                  placeholder="Search titles and messages" maxLength={200}
                  value={searchInput} onChange={event => setSearchInput(event.target.value)} />
                <Button type="submit">Search</Button>
                {(searchInput || search) && <Button type="button" variant="outline" onClick={() => {
                  setSearchInput("");
                  setSearch("");
                }}>Clear search</Button>}
              </div>
              <p className="text-sm text-muted-foreground" role="status">
                {search ? `Results for “${search}” across all announcements.` : "Search the full announcement archive."}
              </p>
            </form>
            
            {announcementsLoading || (visibleTargetId && !targetInList && targetLoading) ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 w-full rounded-2xl bg-card border border-border" />)}
              </div>
            ) : announcementsError && !announcements ? (
              <div role="alert" className="space-y-3 text-sm text-muted-foreground">
                <p>Announcements could not be loaded.</p>
                <Button variant="outline" onClick={() => refetchAnnouncements()}>Try again</Button>
              </div>
            ) : announcements?.length === 0 && !targetedPost && !targetError ? (
              <div className="text-center py-16 border border-dashed border-border rounded-2xl bg-card/30">
                <MessageSquare className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
                <h3 className="text-lg font-bold mb-1">{search ? "No matching announcements" : "No announcements yet"}</h3>
                <p className="text-muted-foreground text-sm">{search ? "Try another topic or clear your search." : "Check back later for updates."}</p>
              </div>
            ) : (
              <div className="space-y-6">
                {targetError && !targetInList && <p role="alert" className="text-sm text-muted-foreground">This announcement is no longer available.</p>}
                {targetedPost && !targetInList && <AnnouncementCard key={targetedPost.id} announcement={targetedPost} />}
                {announcements?.map(announcement => <AnnouncementCard key={announcement.id} announcement={announcement} />)}
                {isFetchNextPageError && <p role="alert" className="text-sm text-muted-foreground">Older announcements could not be loaded. Try again.</p>}
                {hasNextPage && (
                  <Button variant="outline" className="w-full" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading older announcements…</> : "Load older announcements"}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <h2 className="text-2xl font-serif font-bold border-b border-border pb-2">Recent Activity</h2>
            
            <Card className="border-border bg-card/50">
              <CardContent className="p-0">
                {activityLoading ? (
                  <div className="p-4 space-y-4">
                    {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full bg-muted" />)}
                  </div>
                ) : activity?.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No recent activity.
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {activity?.map(item => (
                      <div key={item.id} className="p-5 flex gap-4 text-sm">
                        <div className="mt-1 shrink-0 w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                          {item.type === 'course_created' ? <Pin className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
                        </div>
                        <div>
                          <p className="text-foreground leading-relaxed">
                            <span className="font-medium text-primary">{item.actorName || 'Someone'}</span> {item.description} <ActivityEntityTitle item={item} className="font-bold" />
                          </p>
                          <p className="text-muted-foreground text-xs mt-1.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function AnnouncementCard({ announcement }: { announcement: Announcement }) {
  return (
    <Card id={`announcement-${announcement.id}`} className={`scroll-mt-6 border-border overflow-hidden target:border-primary ${announcement.pinned ? 'border-primary/30 shadow-[0_4px_20px_-10px_rgba(255,236,194,0.1)]' : ''}`}>
      <CardContent className="p-6 md:p-8">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10 border border-border">
              <AvatarFallback className="bg-primary/10 text-primary font-serif">{announcement.authorName.charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <div className="font-medium text-foreground">{announcement.authorName}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" /> {format(new Date(announcement.createdAt), 'MMM d, yyyy h:mm a')}
              </div>
            </div>
          </div>
          {announcement.pinned && (
            <div className="shrink-0 flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 px-2 py-1 rounded-md">
              <Pin className="w-3 h-3" /> Pinned
            </div>
          )}
        </div>
        <h3 className="text-xl font-serif font-bold mb-3">{announcement.title}</h3>
        <div className="prose prose-invert max-w-none text-muted-foreground">
          {announcement.body.split('\n').map((p, i) => <p key={i} className="mb-2 last:mb-0">{p}</p>)}
        </div>
      </CardContent>
    </Card>
  );
}

const pendingAnnouncementKey = "tebm:community:pending-announcement";

type PendingAnnouncement = {
  userId: string;
  title: string;
  body: string;
  requestKey: string;
};

function CreateAnnouncementDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [recoveredPending, setRecoveredPending] = useState(false);
  const requestKey = useRef<string | null>(null);
  const loadedUserId = useRef<string | null>(null);
  const { user, isLoaded } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isLoaded || loadedUserId.current === (user?.id ?? null)) return;
    loadedUserId.current = user?.id ?? null;
    setTitle("");
    setBody("");
    setRecoveredPending(false);
    requestKey.current = null;
    try {
      const raw = sessionStorage.getItem(pendingAnnouncementKey);
      if (!raw) return;
      const pending: PendingAnnouncement = JSON.parse(raw);
      if (pending.userId !== user?.id || typeof pending.title !== "string" ||
          typeof pending.body !== "string" || typeof pending.requestKey !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.requestKey)) {
        sessionStorage.removeItem(pendingAnnouncementKey);
        return;
      }
      setTitle(pending.title);
      setBody(pending.body);
      requestKey.current = pending.requestKey;
      setRecoveredPending(true);
    } catch {
      // A damaged or inaccessible entry cannot safely be reused.
      try { sessionStorage.removeItem(pendingAnnouncementKey); } catch { /* unavailable storage */ }
    }
  }, [isLoaded, user?.id]);

  const editDraft = () => {
    requestKey.current = null;
    setRecoveredPending(false);
    try { sessionStorage.removeItem(pendingAnnouncementKey); } catch { /* submit will report unavailable storage */ }
  };

  const createMutation = useMutation({
      mutationFn: (data: { title: string; body: string }) => {
        if (!user?.id) throw new Error("Sign in before posting an announcement.");
        const key = requestKey.current ?? crypto.randomUUID();
        // Write before the request: a committed post whose reply is lost must
        // still have the same key and exact draft after a page refresh.
        try {
          sessionStorage.setItem(pendingAnnouncementKey, JSON.stringify({
            userId: user.id, ...data, requestKey: key,
          } satisfies PendingAnnouncement));
        } catch {
          throw new Error("Unable to save this draft for a safe retry. Check browser storage and try again.");
        }
        requestKey.current = key;
        return createAnnouncement(data, { headers: { "Idempotency-Key": requestKey.current } });
      },
      onSuccess: () => {
        requestKey.current = null;
        setRecoveredPending(false);
        try { sessionStorage.removeItem(pendingAnnouncementKey); } catch { /* retry key remains safe */ }
        queryClient.invalidateQueries({ queryKey: getListAnnouncementsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRecentActivityQueryKey() });
        toast({ title: "Announcement posted", description: "Your announcement is now live." });
        setOpen(false);
        setTitle("");
        setBody("");
      },
      onError: (error) => {
        toast({ title: "Failed to post", description: error instanceof Error && error.message.startsWith("Unable to save")
          ? error.message : "There was an error posting your announcement.", variant: "destructive" });
      },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || !user?.id || !title.trim() || !body.trim()) return;
    createMutation.mutate({ title, body });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-announcement-draft" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-6 shadow-[0_0_20px_-5px_rgba(255,236,194,0.3)]">
          <Plus className="w-4 h-4 mr-2" /> {recoveredPending ? "Review pending post" : "New Post"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] bg-card border-border">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">{recoveredPending ? "Review pending announcement" : "Create Announcement"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-6">
            {recoveredPending && (
              <div role="status" data-testid="status-recovered-announcement" className="rounded-lg border border-primary/40 bg-primary/10 p-4 text-sm text-foreground space-y-2">
                <p className="font-semibold">This announcement may already be live.</p>
                <p>The reply to your last post was interrupted. Retry without changing the text to confirm that same post without creating a duplicate. To start a separate post, edit the title or message first.</p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Title</label>
              <Input
                data-testid="input-announcement-title"
                value={title}
                onChange={(e) => { editDraft(); setTitle(e.target.value); }}
                disabled={createMutation.isPending}
                placeholder="What's new?"
                className="bg-input border-border focus-visible:ring-primary text-foreground"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Message</label>
              <Textarea
                data-testid="input-announcement-body"
                value={body}
                onChange={(e) => { editDraft(); setBody(e.target.value); }}
                disabled={createMutation.isPending}
                placeholder="Share the details with the community..."
                className="min-h-[150px] bg-input border-border focus-visible:ring-primary text-foreground resize-none"
                required
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={createMutation.isPending} className="hover:bg-muted text-muted-foreground">Cancel</Button>
            <Button type="submit" data-testid="button-post-announcement" className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={createMutation.isPending || !isLoaded || !user?.id || !title.trim() || !body.trim()}>
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {recoveredPending ? "Confirm or retry post" : "Post Announcement"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}