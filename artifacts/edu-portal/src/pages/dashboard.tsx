import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useGetDashboardStats, 
  useGetFeaturedCourses, 
  useGetRecentActivity, 
  useListEnrollments,
  useGetBeautyMethod,
  useGetMe,
  useListCourses,
  useGetCourse,
  getListCoursesQueryKey,
  getGetCourseQueryKey,
  useGetRadiantAudit
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Users, Library, Award, ArrowRight, Clock, PlayCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNow } from "date-fns";
import { BeautyDiagnostic, BeautyDiagnosticSkeleton } from "@/components/beauty-diagnostic";
import { AcceleratorDashboard } from "@/components/accelerator-dashboard";

export default function Dashboard() {
  const { data: member, isLoading: memberLoading } = useGetMe();
  // Existing Premium accounts retain access to Elevated courses, even though
  // only Free and Elevated are currently offered to new members.
  const isElevated = member?.membershipTier === "Elevated" || member?.membershipTier === "Premium";
  const acceleratorSearch = { search: "The Beauty Mindset Accelerator" };
  const { data: acceleratorCourses, isLoading: coursesLoading } = useListCourses(
    acceleratorSearch,
    { query: { queryKey: getListCoursesQueryKey(acceleratorSearch), enabled: isElevated } }
  );
  const acceleratorId = acceleratorCourses?.find(course => course.title === "The Beauty Mindset Accelerator")?.id;
  const { data: accelerator, isLoading: acceleratorLoading } = useGetCourse(acceleratorId ?? 0, {
    query: { queryKey: getGetCourseQueryKey(acceleratorId ?? 0), enabled: isElevated && !!acceleratorId }
  });
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: featured, isLoading: featuredLoading } = useGetFeaturedCourses();
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  const { data: enrollments, isLoading: enrollmentsLoading } = useListEnrollments();
  const { data: method, isLoading: methodLoading } = useGetBeautyMethod();
  const { data: audit, isLoading: auditLoading } = useGetRadiantAudit();

  return (
    <AppLayout>
      <div className="space-y-8 pb-12">
        <header className="mb-8">
          <h1 className="text-4xl font-serif font-bold text-foreground tracking-tight mb-2">Welcome back.</h1>
          <p className="text-muted-foreground text-lg">Here's what's happening in The Elevated Beauty Method community today.</p>
        </header>

        {!auditLoading && (
          <section className="rounded-2xl border border-primary/30 bg-card/70 p-6">
            <h2 className="font-serif text-2xl text-foreground">Your Radiant Audit</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {audit
                ? `Your reflection is saved. Current routine: ${audit.routineScore}/5 · Your values: ${audit.valuesScore}/5.`
                : "Begin with the scorecard and check-in worksheet from The Radiant Audit."}
            </p>
            <Button asChild className="mt-4 rounded-full">
              <Link href={audit ? "/radiant-audit/complete" : "/radiant-audit"}>
                {audit ? "Review your Audit" : "Complete your Audit"}
              </Link>
            </Button>
          </section>
        )}

        {(memberLoading || isElevated) && (
          <AcceleratorDashboard
            course={accelerator}
            enrollment={enrollments?.find(item => item.courseId === acceleratorId)}
            loading={memberLoading || coursesLoading || acceleratorLoading || enrollmentsLoading}
          />
        )}

        {/* Primary New Member Experience */}
        <section>
          {methodLoading ? (
            <BeautyDiagnosticSkeleton />
          ) : (
            <BeautyDiagnostic method={method} />
          )}
        </section>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Courses" value={stats?.totalCourses} icon={<Library className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Lessons" value={stats?.totalLessons} icon={<BookOpen className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Members" value={stats?.totalEnrollments} icon={<Users className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Topics" value={stats?.totalCategories} icon={<Award className="w-4 h-4 text-primary" />} loading={statsLoading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content Column */}
          <div className="lg:col-span-2 space-y-12">
            {/* My Learning */}
            <section>
              <div className="flex items-center justify-between mb-6 border-b border-border/50 pb-2">
                <h2 className="text-2xl font-serif font-bold">My Learning</h2>
                <Button variant="ghost" size="sm" asChild className="text-primary hover:text-primary hover:bg-primary/10">
                  <Link href="/profile">View All</Link>
                </Button>
              </div>
              
              {enrollmentsLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <Skeleton key={i} className="h-32 w-full rounded-2xl bg-card border border-border" />)}
                </div>
              ) : enrollments?.length ? (
                <div className="grid gap-4">
                  {enrollments.slice(0, 3).map(enrollment => {
                    const progress = enrollment.totalLessons > 0 ? (enrollment.completedLessons / enrollment.totalLessons) * 100 : 0;
                    return (
                      <Link key={enrollment.id} href={`/courses/${enrollment.courseId}`}>
                        <Card className="hover:bg-card/80 transition-all cursor-pointer border-border group rounded-2xl hover:border-primary/30 shadow-sm">
                          <CardContent className="p-6 flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <h3 className="font-serif font-bold text-xl mb-2 group-hover:text-primary transition-colors">{enrollment.courseTitle}</h3>
                              <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3 font-medium">
                                <span className="flex items-center gap-1.5"><PlayCircle className="w-4 h-4 text-primary/70" /> {enrollment.completedLessons} / {enrollment.totalLessons} Lessons</span>
                              </div>
                              <Progress value={progress} className="h-1.5 bg-muted [&>div]:bg-primary" />
                            </div>
                            <Button variant="secondary" className="shrink-0 bg-primary/10 text-primary hover:bg-primary/20 rounded-full h-12 w-12 p-0 flex items-center justify-center transition-transform group-hover:translate-x-1">
                              <ArrowRight className="w-5 h-5" />
                            </Button>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <Card className="border-dashed bg-transparent rounded-2xl">
                  <CardContent className="p-12 text-center">
                    <Library className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                    <h3 className="text-xl font-serif font-bold mb-2">No courses yet</h3>
                    <p className="text-muted-foreground mb-6 max-w-md mx-auto">Explore your recommended method and find your starting point.</p>
                    <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 h-12">
                      <Link href="/courses">Explore the Library</Link>
                    </Button>
                  </CardContent>
                </Card>
              )}
            </section>

            {/* Featured Courses */}
            <section>
              <div className="flex items-center justify-between mb-6 border-b border-border/50 pb-2">
                <h2 className="text-2xl font-serif font-bold">Featured Courses</h2>
                <Button variant="ghost" size="sm" asChild className="text-primary hover:text-primary hover:bg-primary/10">
                  <Link href="/courses">Explore All</Link>
                </Button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {featuredLoading ? (
                  [1, 2].map(i => <Skeleton key={i} className="h-64 w-full rounded-2xl bg-card border border-border" />)
                ) : (
                  featured?.map(course => (
                    <Link key={course.id} href={`/courses/${course.id}`}>
                      <Card className="h-full hover:bg-card/80 transition-all cursor-pointer border-border group overflow-hidden flex flex-col rounded-2xl hover:border-primary/30 shadow-sm">
                        <div className="h-40 bg-muted relative overflow-hidden">
                          {course.thumbnailUrl ? (
                            <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/30 group-hover:scale-105 transition-transform duration-500">
                              <Library className="w-10 h-10" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-background/90 to-transparent"></div>
                          <div className="absolute bottom-3 left-3 bg-background/80 backdrop-blur border border-border text-xs font-medium px-2.5 py-1 rounded-full text-foreground">
                            {course.categoryName}
                          </div>
                        </div>
                        <CardContent className="p-5 flex-1 flex flex-col">
                          <h3 className="font-serif font-bold text-lg mb-2 group-hover:text-primary transition-colors line-clamp-2 leading-tight">{course.title}</h3>
                          <p className="text-sm text-muted-foreground mt-auto line-clamp-1">{course.instructorName}</p>
                        </CardContent>
                      </Card>
                    </Link>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* Sidebar Column */}
          <div className="space-y-8">
            {/* Recent Activity */}
            <Card className="border-border rounded-2xl bg-card/30">
              <CardHeader className="pb-4 border-b border-border/50">
                <CardTitle className="text-xl font-serif">Community Pulse</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {activityLoading ? (
                  <div className="p-5 space-y-5">
                    {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full bg-muted rounded-xl" />)}
                  </div>
                ) : activity?.length ? (
                  <div className="divide-y divide-border/50">
                    {activity.map(item => (
                      <div key={item.id} className="p-5 flex gap-4 text-sm group transition-colors hover:bg-card/50">
                        <div className="mt-0.5 text-primary/70 group-hover:text-primary transition-colors">
                          <Clock className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-foreground leading-relaxed">
                            <span className="font-medium text-primary">{item.actorName || 'A member'}</span> {item.description} <span className="font-medium">{item.entityTitle}</span>
                          </p>
                          <p className="text-muted-foreground text-xs mt-1.5 font-medium">
                            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No recent activity.
                  </div>
                )}
                <div className="p-4 border-t border-border/50 bg-background/50 text-center">
                  <Button variant="link" size="sm" asChild className="text-primary hover:text-primary/80">
                    <Link href="/community">View Community Board</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function StatCard({ title, value, icon, loading }: { title: string; value?: number; icon: React.ReactNode; loading: boolean }) {
  return (
    <Card className="border-border bg-card/50 rounded-2xl hover:border-primary/20 transition-colors">
      <CardContent className="p-5 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium tracking-wide uppercase">
          {icon} <span>{title}</span>
        </div>
        {loading ? (
          <Skeleton className="h-10 w-20 bg-muted mt-1" />
        ) : (
          <div className="text-4xl font-serif font-bold text-foreground mt-1">{value?.toLocaleString() || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
