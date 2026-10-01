import { useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useGetMe,
  useUpdateMe,
  useListEnrollments,
  getGetMeQueryKey
} from "@workspace/api-client-react";
import type { UserProfile } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { Loader2, Settings, BookOpen, Clock, Award, PlayCircle, Badge } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { notifyProfileChanged } from "@/hooks/use-profile-freshness";

// A form can unmount between saves, but the member's query client survives navigation.
const latestProfileSave = new WeakMap<QueryClient, number>();

export default function ProfilePage() {
  const { data: profile, isLoading: profileLoading, refetch: refetchProfile } = useGetMe();
  const { data: enrollments, isLoading: enrollmentsLoading } = useListEnrollments();
  const [isEditing, setIsEditing] = useState(false);
  
  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto space-y-12 pb-12">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground tracking-tight mb-2">Your Profile</h1>
          <p className="text-muted-foreground text-lg">Manage your identity and learning progress.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-1 space-y-6">
            <Card className="border-border overflow-hidden">
              <div className="h-24 bg-muted relative">
                <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-transparent"></div>
              </div>
              <CardContent className="pt-0 relative px-6 pb-6 text-center">
                <Avatar className="w-24 h-24 border-4 border-card absolute -top-12 left-1/2 -translate-x-1/2 bg-muted">
                  <AvatarImage src={profile?.avatarUrl || undefined} />
                  <AvatarFallback className="text-2xl font-serif text-muted-foreground">{profile?.displayName?.charAt(0) || 'U'}</AvatarFallback>
                </Avatar>
                
                <div className="pt-16 pb-4 border-b border-border/50">
                  {profileLoading ? (
                    <div className="space-y-2 flex flex-col items-center">
                      <Skeleton className="h-6 w-32" />
                      <Skeleton className="h-4 w-48" />
                    </div>
                  ) : (
                    <>
                      <h2 className="text-xl font-bold font-serif text-foreground">{profile?.displayName}</h2>
                      <p className="text-sm text-muted-foreground">{profile?.email}</p>
                    </>
                  )}
                </div>
                
                <div className="pt-4 text-left">
                  <p className="text-sm text-muted-foreground mb-1">Member since</p>
                  {profileLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : (
                    <p className="font-medium text-foreground">{profile?.createdAt ? format(new Date(profile.createdAt), 'MMMM yyyy') : 'Recently'}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border-border">
              <CardHeader className="pb-3 border-b border-border/50">
                <CardTitle className="text-lg font-serif">Learning Stats</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground flex items-center gap-2"><BookOpen className="w-4 h-4 text-primary" /> Enrolled</span>
                    <span className="font-bold">{enrollments?.length || 0}</span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground flex items-center gap-2"><Award className="w-4 h-4 text-primary" /> Completed</span>
                    <span className="font-bold">{enrollments?.filter(e => e.completedLessons === e.totalLessons && e.totalLessons > 0).length || 0}</span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground flex items-center gap-2"><Clock className="w-4 h-4 text-primary" /> Lessons Done</span>
                    <span className="font-bold">{enrollments?.reduce((acc, e) => acc + e.completedLessons, 0) || 0}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          
          <div className="md:col-span-2 space-y-8">
            <Card className="border-border">
              <CardHeader className="flex flex-row items-center justify-between border-b border-border pb-4">
                <CardTitle className="text-xl font-serif">About Me</CardTitle>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setIsEditing(!isEditing)}
                  disabled={!profile || profileLoading}
                >
                  <Settings className="w-4 h-4 mr-2" />
                  {isEditing ? "Cancel" : "Edit Profile"}
                </Button>
              </CardHeader>
              <CardContent className="p-6">
                {profileLoading ? (
                  <div className="space-y-4">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : !profile ? (
                  <div role="alert" className="space-y-3">
                    <p>We couldn't load your saved profile. Try again before editing.</p>
                    <Button variant="outline" onClick={() => void refetchProfile()}>Retry loading profile</Button>
                  </div>
                ) : isEditing ? (
                  <ProfileEditForm 
                    initialProfile={profile}
                    onSuccess={() => setIsEditing(false)} 
                  />
                ) : (
                  <div>
                    {profile?.bio ? (
                      <p className="text-foreground leading-relaxed whitespace-pre-wrap">{profile.bio}</p>
                    ) : (
                      <div className="text-center py-8">
                        <p className="text-muted-foreground italic">You haven't written a bio yet.</p>
                        <Button variant="link" onClick={() => setIsEditing(true)} className="text-primary mt-2">Add a short bio</Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <h3 className="text-2xl font-serif font-bold text-foreground">My Courses</h3>
              
              {enrollmentsLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <Skeleton key={i} className="h-32 w-full rounded-2xl bg-card border border-border" />)}
                </div>
              ) : enrollments?.length === 0 ? (
                <Card className="border-dashed bg-transparent border-border">
                  <CardContent className="p-12 text-center">
                    <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                    <h3 className="text-xl font-bold mb-2">No active enrollments</h3>
                    <p className="text-muted-foreground mb-6">You haven't started any courses yet.</p>
                    <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8">
                      <Link href="/courses">Browse Catalog</Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4">
                  {enrollments?.map(enrollment => {
                    const progress = enrollment.totalLessons > 0 ? (enrollment.completedLessons / enrollment.totalLessons) * 100 : 0;
                    const isComplete = progress === 100 && enrollment.totalLessons > 0;
                    
                    return (
                      <Card key={enrollment.id} className={`border-border overflow-hidden transition-all hover:border-primary/30 ${isComplete ? 'bg-primary/5' : 'bg-card'}`}>
                        <CardContent className="p-0">
                          <div className="flex flex-col sm:flex-row p-6 gap-6">
                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                              <div className="flex items-center gap-2 mb-2">
                                {isComplete && <Badge className="bg-primary text-primary-foreground border-transparent px-2 py-0.5 text-xs">Completed</Badge>}
                                <h4 className="font-bold text-lg font-serif truncate text-foreground">{enrollment.courseTitle}</h4>
                              </div>
                              <p className="text-sm text-muted-foreground mb-4">
                                Enrolled on {format(new Date(enrollment.enrolledAt), 'MMM d, yyyy')}
                              </p>
                              
                              <div className="space-y-2 mt-auto">
                                <div className="flex justify-between text-sm">
                                  <span className="font-medium text-foreground">Progress</span>
                                  <span className="text-muted-foreground">{enrollment.completedLessons} / {enrollment.totalLessons} Lessons</span>
                                </div>
                                <Progress value={progress} className="h-2.5 bg-muted [&>div]:bg-primary" />
                              </div>
                            </div>
                            
                            <div className="shrink-0 flex sm:flex-col justify-center sm:justify-end gap-3 sm:w-40 sm:border-l sm:border-border sm:pl-6">
                              <Button asChild variant="outline" className="w-full border-border hover:bg-muted bg-background flex-1 sm:flex-none">
                                <Link href={`/courses/${enrollment.courseId}`}>Details</Link>
                              </Button>
                              {!isComplete && enrollment.totalLessons > 0 && (
                                <Button asChild className="w-full bg-primary text-primary-foreground hover:bg-primary/90 flex-1 sm:flex-none shadow-[0_0_15px_-5px_rgba(255,236,194,0.4)]">
                                  <Link href={enrollment.lastLessonId ? `/courses/${enrollment.courseId}/lessons/${enrollment.lastLessonId}` : `/courses/${enrollment.courseId}`}>
                                    {enrollment.completedLessons > 0 ? 'Continue' : 'Start'}
                                  </Link>
                                </Button>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

export function ProfileEditForm({ initialProfile, onSuccess }: { initialProfile: UserProfile, onSuccess: () => void }) {
  const [name, setName] = useState(initialProfile.displayName);
  const [bio, setBio] = useState(initialProfile.bio || "");
  const [version, setVersion] = useState(initialProfile.profileVersion);
  const [conflict, setConflict] = useState<UserProfile | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useUpdateMe({
    mutation: {
      onMutate: () => {
        const sequence = (latestProfileSave.get(queryClient) ?? 0) + 1;
        latestProfileSave.set(queryClient, sequence);
        return sequence;
      },
      onSuccess: (data, _variables, sequence) => {
        if (sequence !== latestProfileSave.get(queryClient)) return;
        // Update cache manually instead of invalidate to avoid layout shift
        queryClient.setQueryData<UserProfile>(getGetMeQueryKey(), (old) =>
          old ? { ...old, displayName: data.displayName, bio: data.bio, profileVersion: data.profileVersion } : old
        );
        notifyProfileChanged(initialProfile.clerkId);
        toast({ title: "Profile updated", description: "Your changes have been saved." });
        onSuccess();
      },
      onError: (error, _variables, sequence) => {
        if (sequence !== latestProfileSave.get(queryClient)) return;
        if (error.status === 409 && error.data?.currentProfile) {
          setConflict(error.data.currentProfile);
          return;
        }
        toast({ title: "Error", description: "Could not update profile.", variant: "destructive" });
      }
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || conflict || updateMutation.isPending) return;
    updateMutation.mutate({ data: { displayName: name, bio, profileVersion: version } });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {conflict && (
        <div role="alert" className="space-y-3 rounded-lg border border-border p-4">
          <p className="font-medium">Your profile changed while you were editing.</p>
          <p className="text-sm">Your edits are still in the form. Review the latest saved details below, then choose which to keep. Nothing has been overwritten.</p>
          <div className="text-sm whitespace-pre-wrap">
            <p>Saved name: {conflict.displayName}</p>
            <p>Saved bio: {conflict.bio || "No bio"}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" onClick={() => {
              setName(conflict.displayName);
              setBio(conflict.bio || "");
              setVersion(conflict.profileVersion);
              queryClient.setQueryData(getGetMeQueryKey(), conflict);
              setConflict(null);
            }}>Use latest saved details</Button>
            <Button type="button" variant="outline" onClick={() => {
              setVersion(conflict.profileVersion);
              queryClient.setQueryData(getGetMeQueryKey(), conflict);
              setConflict(null);
            }}>Keep my edits and review before saving</Button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">Display Name</label>
        <Input 
          value={name} 
          onChange={e => setName(e.target.value)} 
          className="bg-input border-border focus-visible:ring-primary text-foreground"
          required
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">Bio</label>
        <Textarea 
          value={bio} 
          onChange={e => setBio(e.target.value)} 
          className="min-h-[120px] bg-input border-border focus-visible:ring-primary text-foreground resize-y"
          placeholder="Tell the community a bit about yourself..."
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onSuccess} className="border-border hover:bg-muted text-foreground">Cancel</Button>
        <Button type="submit" disabled={updateMutation.isPending || !name.trim() || !!conflict} className="bg-primary text-primary-foreground hover:bg-primary/90 min-w-24">
          {updateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}