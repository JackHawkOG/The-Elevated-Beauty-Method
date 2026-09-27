import { useRef, useState } from "react";
import { AppLayout } from "@/components/layout";
import { 
  useListAnnouncements,
  createAnnouncement,
  useGetRecentActivity,
  getListAnnouncementsQueryKey,
  getGetRecentActivityQueryKey
} from "@workspace/api-client-react";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";

export default function CommunityPage() {
  const { data: announcements, isLoading: announcementsLoading } = useListAnnouncements();
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  
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
            
            {announcementsLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 w-full rounded-2xl bg-card border border-border" />)}
              </div>
            ) : announcements?.length === 0 ? (
              <div className="text-center py-16 border border-dashed border-border rounded-2xl bg-card/30">
                <MessageSquare className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
                <h3 className="text-lg font-bold mb-1">No announcements yet</h3>
                <p className="text-muted-foreground text-sm">Check back later for updates.</p>
              </div>
            ) : (
              <div className="space-y-6">
                {announcements?.map(announcement => (
                  <Card key={announcement.id} className={`border-border overflow-hidden ${announcement.pinned ? 'border-primary/30 shadow-[0_4px_20px_-10px_rgba(255,236,194,0.1)]' : ''}`}>
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
                ))}
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
                            <span className="font-medium text-primary">{item.actorName || 'Someone'}</span> {item.description} <span className="font-bold">{item.entityTitle}</span>
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

function CreateAnnouncementDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const requestKey = useRef<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
      mutationFn: (data: { title: string; body: string }) => {
        requestKey.current ??= crypto.randomUUID();
        return createAnnouncement(data, { headers: { "Idempotency-Key": requestKey.current } });
      },
      onSuccess: () => {
        requestKey.current = null;
        queryClient.invalidateQueries({ queryKey: getListAnnouncementsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRecentActivityQueryKey() });
        toast({ title: "Announcement posted", description: "Your announcement is now live." });
        setOpen(false);
        setTitle("");
        setBody("");
      },
      onError: () => {
        toast({ title: "Failed to post", description: "There was an error posting your announcement.", variant: "destructive" });
      },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    createMutation.mutate({ title, body });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-6 shadow-[0_0_20px_-5px_rgba(255,236,194,0.3)]">
          <Plus className="w-4 h-4 mr-2" /> New Post
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] bg-card border-border">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Create Announcement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Title</label>
              <Input 
                value={title}
                onChange={(e) => { requestKey.current = null; setTitle(e.target.value); }}
                disabled={createMutation.isPending}
                placeholder="What's new?"
                className="bg-input border-border focus-visible:ring-primary text-foreground"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">Message</label>
              <Textarea 
                value={body}
                onChange={(e) => { requestKey.current = null; setBody(e.target.value); }}
                disabled={createMutation.isPending}
                placeholder="Share the details with the community..."
                className="min-h-[150px] bg-input border-border focus-visible:ring-primary text-foreground resize-none"
                required
              />
            </div>
          </div>
          <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={createMutation.isPending} className="hover:bg-muted text-muted-foreground">Cancel</Button>
            <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={createMutation.isPending || !title.trim() || !body.trim()}>
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Post Announcement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}