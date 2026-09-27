import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCourseQueryKey,
  getGetLessonQueryKey,
  getListEditorialCoursesQueryKey,
  getListCoursesQueryKey,
  getListLessonsQueryKey,
  getReviewCourseQueryKey,
  getReviewLessonQueryKey,
  useApproveCourse,
  useApproveLesson,
  useListEditorialCourses,
  useReviewCourse,
  useReviewLesson,
} from "@workspace/api-client-react";
import type { EditorialCourse, EditorialCourseSummary, EditorialLesson, EditorialLessonSummary } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowRight, Check, ExternalLink, FileText, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";

const isConflict = (error: unknown) =>
  !!error && typeof error === "object" && "status" in error && error.status === 409;

const dateLabel = (value: string | null | undefined) => {
  if (!value) return "Not published";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Published" : `Published ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
};

const safeVideoUrl = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

function StateMessage({ title, detail, action, onAction, testId }: {
  title: string; detail: string; action: string; onAction: () => void; testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-2xl border border-primary/20 bg-primary/[0.035] px-5 py-6 sm:px-7">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <h3 className="font-serif text-2xl text-foreground">{title}</h3>
          <p className="mt-1 max-w-lg text-sm leading-relaxed text-muted-foreground">{detail}</p>
          <Button data-testid={`${testId}-action`} onClick={onAction} variant="outline" className="mt-5 rounded-full border-primary/30 text-primary hover:bg-primary/10">
            <RefreshCw className="mr-2 size-3.5" /> {action}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewPlaceholder() {
  return <div data-testid="loading-editorial-review" className="space-y-5" aria-label="Loading editorial review">
    <Skeleton className="h-5 w-28 bg-muted" />
    <Skeleton className="h-14 w-3/4 bg-muted" />
    <Skeleton className="h-28 w-full bg-muted" />
    <Skeleton className="h-40 w-full bg-muted" />
  </div>;
}

function Status({ publishedAt }: { publishedAt: string | null }) {
  return <span data-testid={publishedAt ? "status-published" : "status-draft"} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.17em] ${publishedAt ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : "border-primary/30 bg-primary/10 text-primary"}`}>
    <span className={`size-1.5 rounded-full ${publishedAt ? "bg-emerald-200" : "bg-primary"}`} />
    {publishedAt ? "Published" : "Awaiting approval"}
  </span>;
}

function LessonReview({ lesson, courseId, canApprove }: { lesson: EditorialLessonSummary; courseId: number; canApprove: boolean }) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<EditorialLesson | null>(null);
  const [stale, setStale] = useState(false);
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const review = useReviewLesson(lesson.id, {
    query: { queryKey: getReviewLessonQueryKey(lesson.id), enabled: !stale && !approved, refetchOnWindowFocus: false, refetchOnReconnect: false },
  });
  useEffect(() => {
    if (!snapshot && !stale && !approved && !review.isFetching && review.isFetchedAfterMount && review.data) setSnapshot(review.data);
  }, [snapshot, stale, approved, review.isFetching, review.isFetchedAfterMount, review.data]);
  const approval = useApproveLesson({
    mutation: {
      onSuccess: () => {
        setApproved(true);
        setConfirm(false);
        setMessage("Lesson approved. This reviewed revision is now published.");
        queryClient.invalidateQueries({ queryKey: getListEditorialCoursesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getReviewLessonQueryKey(lesson.id) });
        queryClient.invalidateQueries({ queryKey: getListLessonsQueryKey(courseId) });
        queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lesson.id) });
        queryClient.invalidateQueries({ queryKey: getGetCourseQueryKey(courseId) });
      },
      onError: (error) => {
        setConfirm(false);
        if (isConflict(error)) {
          setSnapshot(null);
          setStale(true);
          setMessage(null);
        } else setMessage("The lesson could not be approved. Nothing was published. Please try again.");
      },
    },
  });
  const reReview = async () => {
    setSnapshot(null);
    setMessage(null);
    setConfirm(false);
    // A stale revision cannot be silently replaced by a background refetch.
    const result = await review.refetch();
    if (result.data && !result.error) {
      setSnapshot(result.data);
      setStale(false);
    }
  };
  const current = snapshot;
  const video = safeVideoUrl(current?.videoUrl);
  return (
    <article data-testid={`card-editorial-lesson-${lesson.id}`} className="border-t border-border/80 py-7 first:border-t-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Lesson {String(lesson.sortOrder).padStart(2, "0")}</p>
          <h4 data-testid={`text-lesson-title-${lesson.id}`} className="mt-1 font-serif text-2xl leading-tight text-foreground">{current?.title ?? lesson.title}</h4>
        </div>
        <Status publishedAt={approved ? new Date().toISOString() : current?.publishedAt ?? lesson.publishedAt} />
      </div>
      {stale ? (
        <div className="mt-5"><StateMessage testId={`error-stale-lesson-${lesson.id}`} title="This draft changed while you reviewed it." detail="Your approval was not applied. Re-review the new lesson content and decide again; the previous revision is no longer available for approval." action="Re-review lesson" onAction={reReview} /></div>
      ) : !current && review.isFetching ? (
        <div className="mt-5"><Skeleton className="h-28 w-full bg-muted" /></div>
      ) : !current && review.isError ? (
        <div className="mt-5"><StateMessage testId={`error-review-lesson-${lesson.id}`} title="Lesson review unavailable" detail="We could not load this draft. No approval can be made until the full lesson is reviewed." action="Retry review" onAction={reReview} /></div>
      ) : current ? (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Full lesson copy</p>
              <div data-testid={`text-lesson-content-${lesson.id}`} className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground/80">{current.content?.trim() || "No written content supplied for this lesson."}</div>
            </div>
            <div className="text-left sm:text-right">
              <p data-testid={`text-lesson-duration-${lesson.id}`} className="text-xs text-muted-foreground">{current.durationMinutes} min read</p>
              <p data-testid={`text-lesson-published-${lesson.id}`} className="mt-1 text-xs text-muted-foreground">{approved ? "Published just now" : dateLabel(current.publishedAt)}</p>
            </div>
          </div>
          <div className="mt-6 rounded-xl border border-border bg-background/50 px-4 py-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Video reference</span>
            {video ? <a data-testid={`link-lesson-video-${lesson.id}`} href={video} target="_blank" rel="noopener noreferrer" className="mt-1 flex w-fit max-w-full items-center gap-2 break-all text-xs text-primary underline-offset-4 hover:underline">{current.videoUrl}<ExternalLink className="size-3 shrink-0" /></a> :
              <p data-testid={`text-lesson-video-${lesson.id}`} className="mt-1 text-xs text-muted-foreground">{current.videoUrl ? "Video URL is not a valid web link." : "No video attached."}</p>}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p data-testid={`text-lesson-revision-${lesson.id}`} className="break-all font-mono text-[10px] text-muted-foreground" title={current.revision}>Reviewed revision: {current.revision}</p>
            {!current.publishedAt && !approved && canApprove && (
              confirm ? <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-foreground/70">Publish this exact revision?</span>
                <Button data-testid={`button-cancel-lesson-approval-${lesson.id}`} size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={approval.isPending}>Cancel</Button>
                <Button data-testid={`button-confirm-lesson-approval-${lesson.id}`} size="sm" className="rounded-full bg-primary text-primary-foreground" disabled={approval.isPending} onClick={() => approval.mutate({ lessonId: lesson.id, data: { revision: current.revision } })}>{approval.isPending ? "Approving…" : "Confirm approval"}</Button>
              </div> : <Button data-testid={`button-approve-lesson-${lesson.id}`} size="sm" variant="outline" className="rounded-full border-primary/40 text-primary hover:bg-primary/10" onClick={() => setConfirm(true)}><Check className="mr-2 size-3.5" /> Approve lesson</Button>
            )}
          </div>
          {message && <p data-testid={`status-lesson-approval-${lesson.id}`} role="status" className="mt-3 text-xs text-primary">{message}</p>}
        </>
      ) : null}
    </article>
  );
}

function CourseReview({ summary, canApprove }: { summary: EditorialCourseSummary; canApprove: boolean }) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<EditorialCourse | null>(null);
  const [stale, setStale] = useState(false);
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const review = useReviewCourse(summary.id, {
    query: { queryKey: getReviewCourseQueryKey(summary.id), enabled: !stale && !approved, refetchOnWindowFocus: false, refetchOnReconnect: false },
  });
  useEffect(() => {
    if (!snapshot && !stale && !approved && !review.isFetching && review.isFetchedAfterMount && review.data) setSnapshot(review.data);
  }, [snapshot, stale, approved, review.isFetching, review.isFetchedAfterMount, review.data]);
  const approval = useApproveCourse({
    mutation: {
      onSuccess: () => {
        setApproved(true);
        setConfirm(false);
        setMessage("Course approved. This reviewed revision is now published.");
        queryClient.invalidateQueries({ queryKey: getListEditorialCoursesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getReviewCourseQueryKey(summary.id) });
        queryClient.invalidateQueries({ queryKey: getListCoursesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCourseQueryKey(summary.id) });
      },
      onError: (error) => {
        setConfirm(false);
        if (isConflict(error)) {
          setSnapshot(null);
          setStale(true);
          setMessage(null);
        } else setMessage("The course could not be approved. Nothing was published. Please try again.");
      },
    },
  });
  const reReview = async () => {
    setSnapshot(null);
    setMessage(null);
    setConfirm(false);
    const result = await review.refetch();
    if (result.data && !result.error) {
      setSnapshot(result.data);
      setStale(false);
    }
  };
  const lessons = [...summary.lessons].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  return (
    <div data-testid={`panel-editorial-course-${summary.id}`} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-6">
        <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-primary">Review dossier / {String(summary.id).padStart(3, "0")}</span>
        <Status publishedAt={approved ? new Date().toISOString() : snapshot?.publishedAt ?? summary.publishedAt} />
      </div>
      {stale ? <div className="mt-8"><StateMessage testId={`error-stale-course-${summary.id}`} title="This course draft has changed." detail="Your approval was not applied. Re-review the new course copy before making another decision; the previous revision is no longer available for approval." action="Re-review course" onAction={reReview} /></div> :
        !snapshot && review.isFetching ? <div className="pt-8"><ReviewPlaceholder /></div> :
        !snapshot && review.isError ? <div className="mt-8"><StateMessage testId={`error-review-course-${summary.id}`} title="Course review unavailable" detail="We could not load this draft. Approval is unavailable until the full course copy has been reviewed." action="Retry review" onAction={reReview} /></div> :
        snapshot ? <>
          <div className="py-8 sm:py-10">
            <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-[0.16em]">
              <span data-testid={`text-course-tier-${summary.id}`} className="rounded-full border border-primary/30 px-3 py-1.5 text-primary">{snapshot.accessTier} access</span>
              <span data-testid={`text-course-category-${summary.id}`} className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">{snapshot.categoryName}</span>
              <span data-testid={`text-course-difficulty-${summary.id}`} className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">{snapshot.difficulty}</span>
            </div>
            <h2 data-testid={`text-course-title-${summary.id}`} className="mt-5 max-w-3xl font-serif text-4xl leading-[0.97] tracking-[-0.025em] text-foreground sm:text-5xl lg:text-6xl">{snapshot.title}</h2>
            <p data-testid={`text-course-instructor-${summary.id}`} className="mt-4 text-sm text-muted-foreground">Taught by <span className="text-foreground">{snapshot.instructorName}</span></p>
          </div>
          <div className="grid gap-7 border-t border-border py-7 lg:grid-cols-[150px_minmax(0,1fr)]">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Course description</span>
            <p data-testid={`text-course-description-${summary.id}`} className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground/85">{snapshot.description || "No description supplied."}</p>
          </div>
          <div className="grid gap-7 border-t border-border py-7 lg:grid-cols-[150px_minmax(0,1fr)]">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Transformation story</span>
            <p data-testid={`text-course-story-${summary.id}`} className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground/85">{snapshot.transformationStory?.trim() || "No transformation story supplied."}</p>
          </div>
          {snapshot.thumbnailUrl && <div className="grid gap-7 border-t border-border py-7 lg:grid-cols-[150px_minmax(0,1fr)]">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Cover artwork</span>
            <img data-testid={`img-course-thumbnail-${summary.id}`} src={snapshot.thumbnailUrl} alt={`Cover artwork for ${snapshot.title}`} className="max-h-72 w-full max-w-lg rounded-xl border border-border object-cover" />
          </div>}
          <div className="flex flex-col gap-5 border-t border-border py-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p data-testid={`text-course-published-${summary.id}`} className="text-xs text-muted-foreground">{approved ? "Published just now" : dateLabel(snapshot.publishedAt)}</p>
              <p data-testid={`text-course-revision-${summary.id}`} className="mt-2 break-all font-mono text-[10px] text-muted-foreground" title={snapshot.revision}>Reviewed revision: {snapshot.revision}</p>
            </div>
            {!snapshot.publishedAt && !approved && canApprove && (
              confirm ? <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-foreground/70">Publish this exact revision?</span>
                <Button data-testid={`button-cancel-course-approval-${summary.id}`} size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={approval.isPending}>Cancel</Button>
                <Button data-testid={`button-confirm-course-approval-${summary.id}`} size="sm" className="rounded-full bg-primary text-primary-foreground" disabled={approval.isPending} onClick={() => approval.mutate({ courseId: summary.id, data: { revision: snapshot.revision } })}>{approval.isPending ? "Approving…" : "Confirm approval"}</Button>
              </div> : <Button data-testid={`button-approve-course-${summary.id}`} className="rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/90" onClick={() => setConfirm(true)}><Check className="mr-2 size-4" /> Approve course</Button>
            )}
          </div>
          {message && <p data-testid={`status-course-approval-${summary.id}`} role="status" className="pb-5 text-xs text-primary">{message}</p>}
        </> : null}
      <section aria-labelledby="editorial-lessons-heading" className="mt-4 rounded-2xl border border-border bg-card/60 px-5 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-primary">The syllabus</p>
            <h3 id="editorial-lessons-heading" className="mt-1 font-serif text-3xl text-foreground">Lessons in review</h3>
          </div>
          <p data-testid={`text-lesson-count-${summary.id}`} className="text-xs text-muted-foreground">{lessons.length} {lessons.length === 1 ? "lesson" : "lessons"}</p>
        </div>
         {lessons.length ? lessons.map((lesson) => <LessonReview key={lesson.id} lesson={lesson} courseId={summary.id} canApprove={canApprove} />) :
          <div data-testid={`empty-lessons-${summary.id}`} className="py-12 text-center"><FileText className="mx-auto size-7 text-primary/60" /><p className="mt-4 font-serif text-2xl">The lesson list is empty</p><p className="mt-1 text-sm text-muted-foreground">There is no lesson copy to review for this course yet.</p></div>}
      </section>
    </div>
  );
}

export default function EditorialPage() {
  const { user } = useUser();
  const role = user?.publicMetadata?.role;
  const canApprove = role === "owner" || role === "admin";
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = useListEditorialCourses({ query: { queryKey: getListEditorialCoursesQueryKey() } });
  const courses = list.data ?? [];
  const selected = courses.find((course) => course.id === selectedId) ?? courses[0];
  const pendingLessons = courses.reduce((total, course) => total + course.lessons.filter((lesson) => !lesson.publishedAt).length, 0);
  const pendingCourses = courses.filter((course) => !course.publishedAt).length;
  return (
    <AppLayout>
      <div data-testid="page-editorial" className="min-h-[100dvh] bg-background text-foreground">
        <div className="border-b border-border bg-card/40">
          <div className="mx-auto max-w-[1500px] px-5 py-10 sm:px-8 sm:py-12 xl:px-12">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.26em] text-primary"><ShieldCheck className="size-3.5" /> The Elevated Beauty Method ™ <span className="mx-1 text-muted-foreground">/</span> Editorial desk</div>
            <div className="mt-5 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h1 className="font-serif text-5xl leading-none tracking-[-0.025em] sm:text-7xl">The review room<span className="text-primary">.</span></h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">A private look at the lessons and course copy waiting to meet the world. Review every word before it goes live.</p>
              </div>
              <div className="flex w-fit flex-wrap items-center gap-5 border-l border-primary/40 pl-5 sm:gap-8">
                <div><span data-testid="text-pending-courses" className="block font-serif text-3xl leading-none text-primary">{list.isLoading ? "—" : pendingCourses}</span><span className="mt-1 block text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Course drafts</span></div>
                <div><span data-testid="text-pending-lessons" className="block font-serif text-3xl leading-none text-primary">{list.isLoading ? "—" : pendingLessons}</span><span className="mt-1 block text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Lesson drafts</span></div>
              </div>
            </div>
          </div>
        </div>
        <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 xl:px-12">
          <div data-testid="status-editorial-permission" className="mb-8 flex items-start gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-xs leading-5 text-muted-foreground">
            {canApprove ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> : <LockKeyhole className="mt-0.5 size-4 shrink-0 text-primary" />}
            <span>{canApprove ? "Owner review: approvals publish only the exact revision displayed below. If the copy changes, approval stops and a new review is required." : "Editorial review: you can inspect every draft here. Only an owner or admin can approve content for publication."}</span>
          </div>
          {list.isLoading ? <div data-testid="loading-editorial-list" className="grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]"><div className="space-y-3"><Skeleton className="h-20 bg-muted" /><Skeleton className="h-20 bg-muted" /><Skeleton className="h-20 bg-muted" /></div><ReviewPlaceholder /></div> :
            list.isError ? <StateMessage testId="error-editorial-list" title="The review queue is unavailable" detail="Drafts could not be loaded. Nothing can be approved until the queue is available again." action="Retry loading" onAction={() => { void list.refetch(); }} /> :
            !courses.length ? <div data-testid="empty-editorial-queue" className="mx-auto flex max-w-lg flex-col items-center py-24 text-center"><div className="flex size-16 items-center justify-center rounded-full border border-primary/30 bg-primary/5"><Check className="size-7 text-primary" /></div><h2 className="mt-7 font-serif text-4xl">Everything has been reviewed.</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">There are no unpublished course or lesson drafts in the queue. New work will appear here when it is ready for review.</p></div> :
            <div className="grid items-start gap-8 lg:grid-cols-[300px_minmax(0,1fr)] xl:gap-12">
              <aside className="lg:sticky lg:top-8">
                <div className="mb-4 flex items-center justify-between"><h2 className="text-[10px] font-bold uppercase tracking-[0.22em] text-primary">Review queue</h2><span data-testid="text-editorial-queue-count" className="text-xs text-muted-foreground">{courses.length} {courses.length === 1 ? "course" : "courses"}</span></div>
                <div className="overflow-hidden rounded-2xl border border-border bg-card/60">
                  {courses.map((course, index) => {
                    const active = selected?.id === course.id;
                    const pending = course.lessons.filter((lesson) => !lesson.publishedAt).length;
                    return <button key={course.id} type="button" data-testid={`button-select-course-${course.id}`} aria-current={active ? "true" : undefined} onClick={() => setSelectedId(course.id)} className={`group flex w-full items-start gap-4 border-t border-border px-5 py-5 text-left transition-colors first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${active ? "bg-primary/[0.08]" : "hover:bg-primary/[0.04]"}`}>
                      <span className={`mt-0.5 font-serif text-2xl leading-none ${active ? "text-primary" : "text-muted-foreground/50"}`}>{String(index + 1).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1"><span data-testid={`text-queue-course-title-${course.id}`} className={`block font-serif text-xl leading-tight ${active ? "text-foreground" : "text-foreground/75"}`}>{course.title}</span><span className="mt-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{course.accessTier} · {course.publishedAt ? `${pending} lesson drafts` : "Course draft"}{!course.publishedAt && pending > 0 ? ` · ${pending} lesson drafts` : ""}</span></span>
                      <ArrowRight className={`mt-1 size-4 shrink-0 transition-transform group-hover:translate-x-1 ${active ? "text-primary" : "text-muted-foreground/50"}`} />
                    </button>;
                  })}
                </div>
                <p className="mt-4 px-1 text-xs leading-5 text-muted-foreground">Drafts remain private until an owner approves each revision.</p>
              </aside>
              <main className="min-w-0"><CourseReview key={selected.id} summary={selected} canApprove={canApprove} /></main>
            </div>}
        </div>
      </div>
    </AppLayout>
  );
}