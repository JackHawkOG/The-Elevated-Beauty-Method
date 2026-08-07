import { Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useGetDashboardStats, 
  useGetFeaturedCourses, 
  useGetRecentActivity, 
  useListEnrollments 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Users, Library, Award, ArrowRight, Clock, PlayCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNow } from "date-fns";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: featured, isLoading: featuredLoading } = useGetFeaturedCourses();
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  const { data: enrollments, isLoading: enrollmentsLoading } = useListEnrollments();

  return (
    <AppLayout>
      <div className="space-y-8 pb-12">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground tracking-tight mb-2">Welcome back.</h1>
          <p className="text-muted-foreground text-lg">Here's what's happening in The Elevated Beauty Method community today.</p>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Courses" value={stats?.totalCourses} icon={<Library className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Lessons" value={stats?.totalLessons} icon={<BookOpen className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Members" value={stats?.totalEnrollments} icon={<Users className="w-4 h-4 text-primary" />} loading={statsLoading} />
          <StatCard title="Topics" value={stats?.totalCategories} icon={<Award className="w-4 h-4 text-primary" />} loading={statsLoading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content Column */}
          <div className="lg:col-span-2 space-y-8">
            {/* My Learning */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-serif font-bold">My Learning</h2>
                <Button variant="ghost" size="sm" asChild className="text-muted-foreground hover:text-foreground">
                  <Link href="/profile">View All</Link>
                </Button>
              </div>
              
              {enrollmentsLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl bg-card border border-border" />)}
                </div>
              ) : enrollments?.length ? (
                <div className="grid gap-4">
                  {enrollments.slice(0, 3).map(enrollment => {
                    const progress = enrollment.totalLessons > 0 ? (enrollment.completedLessons / enrollment.totalLessons) * 100 : 0;
                    return (
                      <Link key={enrollment.id} href={`/courses/${enrollment.courseId}`}>
                        <Card className="hover:bg-card/80 transition-colors cursor-pointer border-border group">
                          <CardContent className="p-5 flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <h3 className="font-bold text-lg mb-1 group-hover:text-primary transition-colors">{enrollment.courseTitle}</h3>
                              <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                                <span className="flex items-center gap-1"><PlayCircle className="w-4 h-4" /> {enrollment.completedLessons} / {enrollment.totalLessons} Lessons</span>
                              </div>
                              <Progress value={progress} className="h-2 bg-muted [&>div]:bg-primary" />
                            </div>
                            <Button variant="secondary" className="shrink-0 bg-primary/10 text-primary hover:bg-primary/20 rounded-full h-10 w-10 p-0 flex items-center justify-center">
                              <ArrowRight className="w-5 h-5" />
                            </Button>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <Card className="border-dashed bg-transparent">
                  <CardContent className="p-8 text-center">
                    <Library className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                    <h3 className="text-xl font-bold mb-2">No courses yet</h3>
                    <p className="text-muted-foreground mb-6">Explore the method and find your starting point.</p>
                    <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-6">
                      <Link href="/courses">Explore the Method</Link>
                    </Button>
                  </CardContent>
                </Card>
              )}
            </section>

            {/* Featured Courses */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-serif font-bold">Featured Courses</h2>
                <Button variant="ghost" size="sm" asChild className="text-muted-foreground hover:text-foreground">
                  <Link href="/courses">Explore Library</Link>
                </Button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {featuredLoading ? (
                  [1, 2].map(i => <Skeleton key={i} className="h-48 w-full rounded-xl bg-card border border-border" />)
                ) : (
                  featured?.map(course => (
                    <Link key={course.id} href={`/courses/${course.id}`}>
                      <Card className="h-full hover:bg-card/80 transition-colors cursor-pointer border-border group overflow-hidden flex flex-col">
                        <div className="h-32 bg-muted relative overflow-hidden">
                          {course.thumbnailUrl ? (
                            <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/40">
                              <Library className="w-8 h-8" />
                            </div>
                          )}
                          <div className="absolute top-3 left-3 bg-background/90 backdrop-blur text-xs font-medium px-2 py-1 rounded-md text-foreground">
                            {course.categoryName}
                          </div>
                        </div>
                        <CardContent className="p-5 flex-1 flex flex-col">
                          <h3 className="font-bold text-lg mb-2 group-hover:text-primary transition-colors line-clamp-2">{course.title}</h3>
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
            <Card className="border-border">
              <CardHeader className="pb-3 border-b border-border/50">
                <CardTitle className="text-xl font-serif">Community Activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {activityLoading ? (
                  <div className="p-4 space-y-4">
                    {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full bg-muted" />)}
                  </div>
                ) : activity?.length ? (
                  <div className="divide-y divide-border/50">
                    {activity.map(item => (
                      <div key={item.id} className="p-4 flex gap-3 text-sm">
                        <div className="mt-0.5 text-primary">
                          <Clock className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-foreground">
                            <span className="font-medium text-primary">{item.actorName || 'Someone'}</span> {item.description} <span className="font-medium">{item.entityTitle}</span>
                          </p>
                          <p className="text-muted-foreground text-xs mt-1">
                            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-6 text-center text-muted-foreground text-sm">
                    No recent activity.
                  </div>
                )}
                <div className="p-3 border-t border-border/50 bg-muted/20 text-center">
                  <Button variant="link" size="sm" asChild className="text-muted-foreground hover:text-primary">
                    <Link href="/community">Go to Community Board</Link>
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
    <Card className="border-border bg-card/50">
      <CardContent className="p-5 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
          {icon} <span>{title}</span>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-16 bg-muted mt-1" />
        ) : (
          <div className="text-3xl font-serif font-bold text-foreground">{value?.toLocaleString() || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}