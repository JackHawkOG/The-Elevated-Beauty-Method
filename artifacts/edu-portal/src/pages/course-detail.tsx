import { useRoute, Link } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useGetCourse, 
  getGetCourseQueryKey,
  useEnrollInCourse,
  useListEnrollments,
  getListEnrollmentsQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { BookOpen, Users, Clock, PlayCircle, Lock, ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";

export default function CourseDetailPage() {
  const [, params] = useRoute("/courses/:courseId");
  const courseId = Number(params?.courseId);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: course, isLoading } = useGetCourse(courseId, { 
    query: { queryKey: getGetCourseQueryKey(courseId) } 
  });
  
  const { data: enrollments, isLoading: enrollmentsLoading } = useListEnrollments();
  const isEnrolled = enrollments?.some(e => e.courseId === courseId);
  const enrollment = enrollments?.find(e => e.courseId === courseId);
  const completedIds = new Set(enrollment?.completedLessonIds ?? []);
  const nextLesson = course?.lessons?.find(lesson => !completedIds.has(lesson.id)) ?? course?.lessons?.[0];

  const enrollMutation = useEnrollInCourse({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
        toast({ title: "Enrolled successfully", description: "You can now access all lessons." });
      },
      onError: () => {
        toast({ title: "Membership upgrade required", description: `This pathway is included with ${course?.accessTier ?? "a higher"} membership.`, variant: "destructive" });
      }
    }
  });

  const handleEnroll = () => {
    enrollMutation.mutate({ data: { courseId } });
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="max-w-4xl mx-auto space-y-8 animate-pulse pb-12">
          <Skeleton className="h-8 w-24 bg-muted" />
          <Skeleton className="h-[400px] w-full bg-muted rounded-2xl" />
          <div className="space-y-4">
            <Skeleton className="h-12 w-3/4 bg-muted" />
            <Skeleton className="h-6 w-1/2 bg-muted" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!course) {
    return (
      <AppLayout>
        <div className="max-w-4xl mx-auto text-center py-20">
          <h2 className="text-2xl font-bold">Course not found</h2>
          <Button asChild variant="link" className="mt-4"><Link href="/courses">Back to courses</Link></Button>
        </div>
      </AppLayout>
    );
  }

  const totalDuration = course.lessons?.reduce((acc, lesson) => acc + lesson.durationMinutes, 0) || 0;
  const hours = Math.floor(totalDuration / 60);
  const minutes = totalDuration % 60;
  const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto pb-20">
        <Link href="/courses" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to library
        </Link>
        
        {/* Header Section */}
        <div className="relative rounded-3xl overflow-hidden mb-12 border border-border bg-card">
          <div className="h-64 md:h-96 relative bg-muted">
            {course.thumbnailUrl ? (
              <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/20">
                <BookOpen className="w-24 h-24" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent"></div>
            
            <div className="absolute bottom-0 left-0 right-0 p-6 md:p-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="max-w-2xl">
                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge className="bg-primary text-primary-foreground border-transparent rounded-full px-3">{course.categoryName}</Badge>
                  <Badge variant="outline" className="bg-background/50 backdrop-blur border-border text-foreground rounded-full px-3">{course.difficulty}</Badge>
                  <Badge variant="outline" className="bg-primary/10 backdrop-blur border-primary/30 text-primary rounded-full px-3">{course.accessTier} access</Badge>
                </div>
                <h1 className="text-4xl md:text-5xl font-serif font-bold text-foreground mb-4 leading-tight">{course.title}</h1>
                <p className="text-lg text-muted-foreground">Taught by <span className="text-foreground font-medium">{course.instructorName}</span></p>
              </div>
              
              <div className="shrink-0">
                {enrollmentsLoading ? (
                  <Skeleton className="h-12 w-32 rounded-full" />
                ) : isEnrolled ? (
                  <Button asChild size="lg" className="rounded-full h-12 px-8 bg-secondary/20 text-secondary hover:bg-secondary/30">
                     <Link href={nextLesson ? `/courses/${course.id}/lessons/${nextLesson.id}` : `/courses/${course.id}`}>
                       {enrollment?.completedLessons ? 'Continue Learning' : 'Start Course'} <PlayCircle className="w-5 h-5 ml-2" />
                    </Link>
                  </Button>
                ) : (
                  <Button 
                    size="lg" 
                    className="rounded-full h-12 px-8 bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_30px_-5px_rgba(255,236,194,0.3)]"
                    onClick={handleEnroll}
                    disabled={enrollMutation.isPending}
                  >
                    {enrollMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : course.accessTier === "Free" ? "Enroll Now for Free" : `Unlock with ${course.accessTier}`}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content Section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
          <div className="md:col-span-2 space-y-10">
            <section>
              <h2 className="text-2xl font-serif font-bold mb-4">About this course</h2>
              <div className="prose prose-invert max-w-none text-muted-foreground text-lg leading-relaxed">
                {course.description.split('\n').map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            </section>
            
            <section>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-serif font-bold">Syllabus</h2>
                <span className="text-sm text-muted-foreground">{course.lessonCount} lessons • {durationStr}</span>
              </div>
              
              <div className="space-y-3">
                {course.lessons?.map((lesson, index) => (
                  <div key={lesson.id} className={`flex items-center p-4 rounded-xl border ${isEnrolled ? 'border-border bg-card hover:border-primary/50 transition-colors' : 'border-border/50 bg-card/30 opacity-75'}`}>
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-serif font-bold mr-4 shrink-0">
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={`font-bold truncate ${isEnrolled ? 'text-foreground' : 'text-muted-foreground'}`}>{lesson.title}</h4>
                      <p className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
                        <Clock className="w-3.5 h-3.5" /> {lesson.durationMinutes} min
                      </p>
                    </div>
                    <div>
                      {isEnrolled ? (
                        <Button asChild variant="ghost" size="sm" className="rounded-full text-primary hover:text-primary hover:bg-primary/10">
                           <Link href={`/courses/${course.id}/lessons/${lesson.id}`}>{completedIds.has(lesson.id) ? "Completed · Review" : "Read"}</Link>
                        </Button>
                      ) : (
                        <Lock className="w-5 h-5 text-muted-foreground/50" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
          
          <div className="space-y-6">
            <div className="p-6 rounded-2xl border border-border bg-card">
              <h3 className="font-serif font-bold text-lg mb-4 border-b border-border pb-2">Course Details</h3>
              <ul className="space-y-4 text-sm">
                <li className="flex justify-between items-center">
                  <span className="text-muted-foreground flex items-center gap-2"><Clock className="w-4 h-4" /> Duration</span>
                  <span className="font-medium">{durationStr}</span>
                </li>
                <li className="flex justify-between items-center">
                  <span className="text-muted-foreground flex items-center gap-2"><BookOpen className="w-4 h-4" /> Lessons</span>
                  <span className="font-medium">{course.lessonCount}</span>
                </li>
                <li className="flex justify-between items-center">
                  <span className="text-muted-foreground flex items-center gap-2"><Users className="w-4 h-4" /> Enrolled</span>
                  <span className="font-medium">{course.enrollmentCount}</span>
                </li>
                <li className="flex justify-between items-center">
                  <span className="text-muted-foreground">Published</span>
                  <span className="font-medium">{format(new Date(course.createdAt), 'MMM yyyy')}</span>
                </li>
              </ul>
            </div>
            
            {!isEnrolled && (
              <div className="p-6 rounded-2xl border border-primary/20 bg-primary/5 text-center">
                <p className="text-sm text-muted-foreground mb-4">Enroll to unlock all course materials and track your progress.</p>
                <Button 
                  className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={handleEnroll}
                  disabled={enrollMutation.isPending}
                >
                  {enrollMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : course.accessTier === "Free" ? "Enroll Free" : `Unlock with ${course.accessTier}`}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}