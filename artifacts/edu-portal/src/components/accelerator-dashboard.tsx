import type { CourseDetail, Enrollment } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ArrowRight, BookOpen, Check, Clock3, LockKeyhole } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type AcceleratorDashboardProps = {
  course?: CourseDetail | null;
  enrollment?: Enrollment | null;
  loading: boolean;
};

const ACCENT = "#dccebf";
const MODULE_SUMMARIES = [
  "Assess your skin type, undertones, and lifestyle to build your custom foundation.",
  "Explore five essential products matched to your needs and how to apply them.",
  "Build a clear, evidence-informed routine around your skin concerns, not passing trends.",
  "Evaluate and update your routine as your skin and life evolve.",
];

/**
 * Elevated-member view of the four approved Accelerator lessons.
 */
export function AcceleratorDashboard({ course, enrollment, loading }: AcceleratorDashboardProps) {
  if (loading) {
    return (
      <section aria-label="Loading your Accelerator" className="overflow-hidden rounded-[2rem] border border-border bg-card/60">
        <div className="space-y-4 border-b border-border/70 p-6 sm:p-9">
          <Skeleton className="h-3 w-28 bg-muted" />
          <Skeleton className="h-12 w-3/4 bg-muted" />
          <Skeleton className="h-5 w-1/2 bg-muted" />
        </div>
        <div className="grid gap-8 p-6 sm:p-9 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4">
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 w-full rounded-2xl bg-muted" />)}
          </div>
          <Skeleton className="h-52 w-full rounded-2xl bg-muted" />
        </div>
      </section>
    );
  }

  if (!course) {
    return (
      <section className="rounded-[2rem] border border-border bg-card/60 p-7 sm:p-10" aria-labelledby="accelerator-unavailable">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em]" style={{ color: ACCENT }}>The Elevated Method</p>
        <h2 id="accelerator-unavailable" className="font-serif text-3xl text-foreground">Your Accelerator is not available right now.</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Please return to the course library and try again shortly.</p>
        <Link data-testid="link-accelerator-library" href="/courses" className="mt-6 inline-flex items-center gap-2 text-sm font-bold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" style={{ color: ACCENT }}>
          Browse courses <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </section>
    );
  }

  const lessons = [...(course.lessons ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 4);
  const isEnrolled = enrollment?.courseId === course.id;
  const completedIds = new Set(isEnrolled ? enrollment.completedLessonIds ?? [] : []);
  const completed = lessons.filter(lesson => completedIds.has(lesson.id)).length;
  const progress = lessons.length ? Math.round((completed / lessons.length) * 100) : 0;
  const nextLesson = lessons.find(lesson => !completedIds.has(lesson.id)) ?? lessons[0];
  const destination = isEnrolled && nextLesson
    ? `/courses/${course.id}/lessons/${nextLesson.id}`
    : `/courses/${course.id}`;

  return (
    <section className="overflow-hidden rounded-[2rem] border border-border bg-card/70 text-foreground" aria-labelledby="accelerator-heading">
      <div className="relative overflow-hidden border-b border-border/70 px-6 pb-8 pt-8 sm:px-10 sm:pb-10 sm:pt-10">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border border-[#dccebf]/10 sm:h-96 sm:w-96" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-6 -top-14 h-52 w-52 rounded-full border border-[#dccebf]/10 sm:h-72 sm:w-72" />
        <div className="relative max-w-2xl">
          <p className="mb-4 flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.24em]" style={{ color: ACCENT }}>
            <span className="h-px w-7 bg-[#dccebf]" /> The Elevated Method <span className="text-muted-foreground">/ Your curriculum</span>
          </p>
          <h2 id="accelerator-heading" className="max-w-xl font-serif text-[2.7rem] leading-[0.98] tracking-tight sm:text-6xl">{course.title}</h2>
          <p className="mt-5 max-w-xl text-sm leading-7 text-muted-foreground sm:text-base">{course.description}</p>
          <Link
            data-testid="link-accelerator-primary"
            href={destination}
            className="mt-7 inline-flex min-h-11 items-center gap-3 rounded-full bg-[#dccebf] px-6 py-2.5 text-sm font-bold text-background transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#dccebf]"
          >
            {isEnrolled ? completed === lessons.length && lessons.length > 0 ? "Revisit the course" : "Continue learning" : "View course & enroll"}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="grid gap-9 px-6 py-8 sm:px-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:gap-10">
        <div>
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: ACCENT }}>The journey</p>
              <h3 className="font-serif text-3xl leading-none sm:text-4xl">Four foundations.</h3>
            </div>
            <span data-testid="text-accelerator-progress" className="text-sm text-muted-foreground">
              {isEnrolled ? `${completed} of ${lessons.length} modules complete` : "Enrollment not started"}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Accelerator progress"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mb-7 h-1 w-full overflow-hidden rounded-full bg-[#dccebf]/15"
          >
            <div className="h-full origin-left bg-[#dccebf] transition-transform duration-500" style={{ transform: `translateX(-${100 - progress}%)` }} />
          </div>

          {lessons.length ? (
            <ol className="divide-y divide-border/70 border-y border-border/70">
              {lessons.map((lesson, index) => {
                 const lessonComplete = completedIds.has(lesson.id);
                 const status = !isEnrolled ? "Enroll to access" : lessonComplete ? "Complete" : "Ready to explore";
                 const description = MODULE_SUMMARIES[index] ?? "Explore this foundation in the lesson.";
                const body = (
                  <>
                    <span className="pt-0.5 font-serif text-3xl leading-none text-[#dccebf]/65" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#dccebf]/85">Module {index + 1}</span>
                      <span className="block font-serif text-[1.65rem] leading-tight text-foreground sm:text-3xl">{lesson.title}</span>
                      <span className="mt-2 block text-sm leading-6 text-muted-foreground">{description}</span>
                      <span data-testid={`status-accelerator-module-${lesson.id}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-[#dccebf]">
                         {lessonComplete ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : isEnrolled ? <BookOpen aria-hidden="true" className="h-3.5 w-3.5" /> : <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" />}
                        {status}
                      </span>
                    </span>
                    {isEnrolled && <ArrowRight aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-[#dccebf] transition-transform group-hover:translate-x-1" />}
                  </>
                );
                return (
                  <li key={lesson.id}>
                    {isEnrolled ? (
                      <Link
                        href={`/courses/${course.id}/lessons/${lesson.id}`}
                        data-testid={`link-accelerator-lesson-${lesson.id}`}
                        className="group flex gap-4 py-5 transition-colors hover:bg-[#dccebf]/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dccebf] sm:gap-6 sm:py-6"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className="flex gap-4 py-5 sm:gap-6 sm:py-6">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="rounded-2xl border border-border p-6 text-sm text-muted-foreground">
              The curriculum is being prepared. Visit the course page for the latest details.
            </div>
          )}
          <Link
            data-testid="link-accelerator-course"
            href={`/courses/${course.id}`}
            className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[#dccebf] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#dccebf]"
          >
            {isEnrolled ? "View full course" : "View course to enroll"} <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>

        <aside className="self-start rounded-[1.5rem] border border-[#dccebf]/25 bg-[#dccebf]/[0.045] p-6 sm:p-7" aria-labelledby="accelerator-session-title">
          <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-full border border-[#dccebf]/30 text-[#dccebf]">
            <Clock3 aria-hidden="true" className="h-5 w-5" />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#dccebf]">Gather together</p>
          <h3 id="accelerator-session-title" className="mt-3 font-serif text-3xl leading-none">Live group session</h3>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">A group workshop with time for questions, included in The Elevated Method.</p>
          <div className="mt-8 border-t border-[#dccebf]/20 pt-5">
            <p data-testid="status-accelerator-session" className="text-sm font-bold text-[#dccebf]">No date announced yet</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Session details will be shared when available.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default AcceleratorDashboard;