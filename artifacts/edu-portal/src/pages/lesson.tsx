import { useRoute, Link, useLocation } from "wouter";
import { 
  useGetLesson, 
  getGetLessonQueryKey,
  useListLessons,
  getListLessonsQueryKey,
  useUpdateProgress,
  useGetCourse,
  getGetCourseQueryKey,
  getListEnrollmentsQueryKey,
  useListEnrollments
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, CheckCircle, Circle, ChevronLeft, ChevronRight, Menu, Loader2, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useEffect, useRef, useState } from "react";

function LessonContent({ content }: { content: string }) {
  return (
    <div className="space-y-6 text-base leading-8 md:text-lg">
      {content.split(/\n\s*\n/).map((paragraph, index) => {
        const label = paragraph.match(/^\*\*(Outcome|Try it|Reflect):\*\*\s*/);
        const body = label ? paragraph.slice(label[0].length) : paragraph;
        const parts = body.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
        return (
          <p key={index} className={label ? "rounded-2xl border border-[#dccebf]/20 bg-[#dccebf]/[0.04] px-5 py-4" : ""}>
            {label && <strong className="mr-2 text-[#dccebf]">{label[1]}:</strong>}
            {parts.map((part, partIndex) =>
              part.startsWith("**") && part.endsWith("**") ? <strong key={partIndex} className="text-foreground">{part.slice(2, -2)}</strong> :
              part.startsWith("*") && part.endsWith("*") ? <em key={partIndex}>{part.slice(1, -1)}</em> :
              <span key={partIndex}>{part}</span>
            )}
          </p>
        );
      })}
    </div>
  );
}

export default function LessonPage() {
  const [, params] = useRoute("/courses/:courseId/lessons/:lessonId");
  const courseId = Number(params?.courseId);
  const lessonId = Number(params?.lessonId);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [savedLessonKey, setSavedLessonKey] = useState<string | null>(null);
  const lessonKey = `${courseId}:${lessonId}`;
  const activePage = useRef({ mounted: true, lessonKey });
  activePage.current.lessonKey = lessonKey;
  useEffect(() => {
    activePage.current.mounted = true;
    return () => { activePage.current.mounted = false; };
  }, []);

  const { data: course } = useGetCourse(courseId, { 
    query: { queryKey: getGetCourseQueryKey(courseId), enabled: !!courseId } 
  });
  
  const { data: lesson, isLoading, isFetching, error, refetch } = useGetLesson(lessonId, {
    query: { queryKey: getGetLessonQueryKey(lessonId), enabled: !!lessonId }
  });

  const { data: lessons, isLoading: lessonsLoading, isFetching: lessonsFetching, error: lessonsError, refetch: refetchLessons } = useListLessons(courseId, {
    query: { queryKey: getListLessonsQueryKey(courseId), enabled: !!courseId }
  });
  const { data: enrollments } = useListEnrollments();
  const completedIds = new Set(enrollments?.find(item => item.courseId === courseId)?.completedLessonIds ?? []);
  const isComplete = completedIds.has(lessonId) || savedLessonKey === lessonKey;
  const currentIndex = lessons?.findIndex(l => l.id === lessonId) ?? -1;
  const outlineReady = !lessonsLoading && !lessonsError && currentIndex >= 0;
  const prevLesson = outlineReady && currentIndex > 0 ? lessons?.[currentIndex - 1] : null;
  const nextLesson = outlineReady && lessons && currentIndex < lessons.length - 1 ? lessons[currentIndex + 1] : null;

  const updateProgress = useUpdateProgress({
    mutation: {
      onSuccess: (_data, variables) => {
        // Auth changes replace this page/query client, but do not cancel a
        // committed mutation's callbacks. A departed page must not toast or
        // navigate the next member (or a different lesson in the same session).
        if (!activePage.current.mounted ||
            activePage.current.lessonKey !== `${variables.courseId}:${variables.data.lessonId}`) return;
        setSavedLessonKey(lessonKey);
        queryClient.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
        // Do not interpret an unavailable outline as the end of the course.
        const outlineState = queryClient.getQueryState(getListLessonsQueryKey(courseId));
        const currentLessons = outlineState?.status === "success"
          ? queryClient.getQueryData<NonNullable<typeof lessons>>(getListLessonsQueryKey(courseId))
          : undefined;
        const index = currentLessons?.findIndex(l => l.id === lessonId) ?? -1;
        if (!currentLessons || index < 0) {
          toast({ title: "Progress saved", description: "The course outline is unavailable. Try loading it again to continue." });
          return;
        }
        toast({ title: "Progress saved", description: "Lesson marked as complete." });
        if (index < currentLessons.length - 1) {
          setLocation(`/courses/${courseId}/lessons/${currentLessons[index + 1].id}`);
        } else {
          setLocation(`/courses/${courseId}`);
        }
      },
      onError: (_error, variables) => {
        if (!activePage.current.mounted ||
            activePage.current.lessonKey !== `${variables.courseId}:${variables.data.lessonId}`) return;
        toast({ title: "Error", description: "Could not save progress.", variant: "destructive" });
      }
    }
  });

  const handleComplete = () => {
    if (!outlineReady || updateProgress.isPending) return;
    if (isComplete) {
      setLocation(nextLesson ? `/courses/${courseId}/lessons/${nextLesson.id}` : `/courses/${courseId}`);
    } else {
      updateProgress.mutate({ courseId, data: { lessonId } });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen bg-background text-foreground">
        <div className="w-80 border-r border-border hidden lg:block bg-sidebar">
          <div className="p-6 border-b border-border space-y-4">
            <Skeleton className="h-6 w-3/4 bg-muted" />
            <Skeleton className="h-4 w-1/2 bg-muted" />
          </div>
          <div className="p-4 space-y-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full bg-muted rounded-md" />)}
          </div>
        </div>
        <div className="flex-1 flex flex-col h-screen overflow-hidden">
          <header className="h-16 border-b border-border flex items-center px-6 bg-card/50">
            <Skeleton className="h-6 w-1/3 bg-muted" />
          </header>
          <main className="flex-1 overflow-auto p-8 md:p-12 animate-pulse">
            <div className="max-w-3xl mx-auto space-y-8">
              <Skeleton className="h-12 w-3/4 bg-muted" />
              <Skeleton className="h-[400px] w-full bg-muted rounded-xl" />
              <div className="space-y-4">
                <Skeleton className="h-4 w-full bg-muted" />
                <Skeleton className="h-4 w-full bg-muted" />
                <Skeleton className="h-4 w-5/6 bg-muted" />
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  if (error?.status === 403) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-6 text-foreground">
        <div role="alert" className="max-w-md text-center">
          <Lock aria-hidden="true" className="mx-auto mb-5 h-10 w-10 text-primary" />
          <h1 className="font-serif text-3xl font-bold mb-4">Lesson access required</h1>
          <p className="mb-8 text-muted-foreground">
            This lesson is locked for your membership. Visit the course overview to see the access required.
          </p>
          <Button asChild><Link href={`/courses/${courseId}`}>Back to course</Link></Button>
        </div>
      </main>
    );
  }

  if (error && error.status !== 404) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-6 text-foreground">
        <div role="alert" data-testid="status-lesson-load-error" className="max-w-md text-center">
          <h1 className="font-serif text-3xl font-bold mb-4">Lesson could not be loaded</h1>
          <p className="mb-8 text-muted-foreground">
            This may be temporary. Try loading the lesson again.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button data-testid="button-retry-lesson" onClick={() => { void refetch(); }} disabled={isFetching}>
              {isFetching ? "Trying again..." : "Try again"}
            </Button>
            <Button asChild variant="outline"><Link href={`/courses/${courseId}`}>Back to course</Link></Button>
          </div>
        </div>
      </main>
    );
  }

  if (!lesson) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Lesson not found</h2>
          <Button asChild><Link href={`/courses/${courseId}`}>Back to course</Link></Button>
        </div>
      </div>
    );
  }

  const SidebarContent = () => (
    <>
      <div className="p-6 border-b border-border">
        <Link href={`/courses/${courseId}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-4 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Course Overview
        </Link>
        <h3 className="font-serif font-bold text-lg leading-tight line-clamp-2">{course?.title || 'Loading...'}</h3>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-1">
        {lessonsLoading ? (
          [1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full bg-muted mb-2" />)
        ) : !outlineReady ? (
          <div role="alert" className="space-y-3 rounded-lg border border-border p-4 text-sm">
            <p>The course outline is unavailable. Try again to see the other lessons.</p>
            <Button data-testid="button-retry-outline-sidebar" variant="outline" size="sm" onClick={() => { void refetchLessons(); }} disabled={lessonsFetching}>
              {lessonsFetching ? "Trying again..." : "Try again"}
            </Button>
          </div>
        ) : (
          lessons?.map((l, i) => {
            const isActive = l.id === lessonId;
            return (
              <Link key={l.id} href={`/courses/${courseId}/lessons/${l.id}`}>
                <button className={`w-full text-left px-3 py-3 rounded-lg flex items-start gap-3 transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-muted-foreground hover:text-foreground'}`}>
                  <div className="mt-0.5 shrink-0">
                     {completedIds.has(l.id) ? <CheckCircle className="w-4 h-4 text-primary" aria-label="Completed" /> : <Circle className={`w-4 h-4 ${isActive ? "fill-primary/20" : ""}`} />}
                  </div>
                  <div>
                    <span className="text-xs font-medium opacity-70 block mb-0.5">Lesson {i + 1}</span>
                    <span className={`text-sm font-medium leading-tight ${isActive ? 'text-foreground' : ''}`}>{l.title}</span>
                  </div>
                </button>
              </Link>
            )
          })
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="w-80 border-r border-border hidden lg:flex flex-col bg-sidebar text-sidebar-foreground">
        <SidebarContent />
      </div>

      <div className="flex-1 flex flex-col h-screen min-w-0">
        <header className="h-16 border-b border-border flex items-center justify-between px-4 lg:px-8 bg-card/80 backdrop-blur sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden text-muted-foreground">
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-0 flex flex-col bg-sidebar border-border">
                <SheetHeader className="sr-only">
                  <SheetTitle>Course Lessons</SheetTitle>
                </SheetHeader>
                <SidebarContent />
              </SheetContent>
            </Sheet>
            <h1 className="font-serif font-bold text-lg truncate hidden sm:block">{lesson.title}</h1>
          </div>
          
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              size="sm"
              className="hidden sm:flex border-border text-foreground hover:bg-muted"
              onClick={handleComplete}
              disabled={updateProgress.isPending || !outlineReady}
            >
              {updateProgress.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
               {isComplete ? "Completed · Continue" : "Mark Complete"}
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-background">
          <div className="max-w-3xl mx-auto px-6 py-12 md:py-20">
            <h1 className="text-3xl md:text-5xl font-serif font-bold mb-8 leading-tight">{lesson.title}</h1>
            {!outlineReady && !lessonsLoading && (
              <div role="alert" data-testid="status-outline-unavailable" className="mb-8 rounded-xl border border-border bg-card p-5">
                <p className="mb-3 text-sm text-foreground">The course outline is unavailable. You can read this lesson, but please try again before completing it so we can take you to the right next lesson.</p>
                <Button data-testid="button-retry-outline" variant="outline" size="sm" onClick={() => { void refetchLessons(); }} disabled={lessonsFetching}>
                  {lessonsFetching ? "Trying again..." : "Try loading outline again"}
                </Button>
              </div>
            )}
            
            {lesson.videoUrl && (
              <div className="aspect-video rounded-2xl overflow-hidden bg-black mb-12 border border-border shadow-2xl">
                <iframe 
                  src={lesson.videoUrl.replace('watch?v=', 'embed/')} 
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
              </div>
            )}

            <div className="prose prose-invert prose-lg max-w-none text-muted-foreground">
              {lesson.content ? (
                <LessonContent content={lesson.content} />
              ) : (
                <p>This lesson doesn't have any text content yet.</p>
              )}
            </div>

            <div className="mt-20 pt-8 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
              {prevLesson ? (
                <Button asChild variant="outline" className="w-full sm:w-auto border-border">
                  <Link href={`/courses/${courseId}/lessons/${prevLesson.id}`}>
                    <ChevronLeft className="w-4 h-4 mr-2" /> Previous Lesson
                  </Link>
                </Button>
              ) : <div></div>}

              <Button 
                onClick={handleComplete}
                disabled={updateProgress.isPending || !outlineReady}
                className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {updateProgress.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                 {!outlineReady ? 'Waiting for course outline' : nextLesson ? (isComplete ? 'Continue' : 'Complete & Continue') : (isComplete ? 'Return to Course' : 'Finish Course')}
                {nextLesson && <ChevronRight className="w-4 h-4 ml-1" />}
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}