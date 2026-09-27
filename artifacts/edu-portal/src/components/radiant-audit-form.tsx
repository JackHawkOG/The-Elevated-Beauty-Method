import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, CircleDot, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export type RadiantAuditSubmission = {
  email: string;
  routineChecks: string[];
  valuesChecks: string[];
  beautyTrend: string;
  masteryGoal: string;
  researchTime: string;
};

type RadiantAuditFormProps = {
  initialEmail?: string;
  initialDraft?: RadiantAuditSubmission | null;
  onDraftChange?: (data: RadiantAuditSubmission) => void;
  onDiscardDraft?: () => void;
  draftWarning?: string | null;
  needsAccount?: boolean;
  needsVerification?: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (data: RadiantAuditSubmission) => void;
  onVerifyEmail?: (data: RadiantAuditSubmission) => void;
  onSwitchAccount?: (data: RadiantAuditSubmission) => void;
};

const routineStatements = [
  {
    value: "skincare-consistency",
    title: "Skincare consistency",
    text: "I care for my skin morning and evening, without skipped days.",
  },
  {
    value: "makeup-application-confidence",
    title: "Makeup application confidence",
    text: "I apply my makeup with certainty, and it looks exactly as I intend.",
  },
  {
    value: "product-spending",
    title: "Product spending",
    text: "Every product I buy earns its place — nothing sits forgotten in a drawer.",
  },
  {
    value: "trend-chasing-behavior",
    title: "Trend-chasing behavior",
    text: "I choose what flatters my face, not what is trending this month.",
  },
  {
    value: "time-spent-on-beauty-daily",
    title: "Time spent on beauty daily",
    text: "My routine is efficient: a polished result in minutes, not an hour.",
  },
];

const valuesQuestions = [
  { value: "quality-over-price", title: "Quality over price", text: "Do you prioritize quality over price?" },
  {
    value: "one-method-mastered",
    title: "One method, mastered",
    text: "Do you want to master one method rather than follow many trends?",
  },
  {
    value: "professional-results",
    title: "Professional results",
    text: "Do you want professional-grade results at home?",
  },
  {
    value: "authentic-expression",
    title: "Authentic expression",
    text: "Do you value authentic self-expression?",
  },
  {
    value: "lasting-investment",
    title: "Lasting investment",
    text: "Do you invest in long-term results?",
  },
];

const framework = [
  {
    stage: "01",
    name: "Discover",
    line: "Uncover your beauty baseline.",
    detail:
      "We audit your current routine, skin dynamics, and personal identity goals — revealing your skin type, undertones, and true starting point. The Radiant Audit is your first step.",
  },
  {
    stage: "02",
    name: "Refine",
    line: "Strip away the noise.",
    detail:
      "We release trend-chasing noise and poor product fit, setting aside improper techniques, formulas that no longer serve your skin, and ill-fitting cosmetics so only what truly serves you remains.",
  },
  {
    stage: "03",
    name: "Enhance",
    line: "Artistry tailored to you.",
    detail:
      "Science-backed, age-positive artistry techniques tailored to your individual facial geometry, designed to amplify your natural features.",
  },
  {
    stage: "04",
    name: "Embody",
    line: "Inner identity, outer expression.",
    detail:
      "We align your outer appearance with your inner identity and daily habits, bringing mindset, posture, and presence into harmony with how you look.",
  },
  {
    stage: "05",
    name: "Radiate",
    line: "Unapologetic visibility.",
    detail:
      "You step into total visibility, authority, and personal presence — commanding space with authentic magnetism.",
  },
];

function CheckOption({
  id,
  value,
  title,
  text,
  checked,
  onChange,
}: {
  id: string;
  value: string;
  title: string;
  text: string;
  checked: boolean;
  onChange: (value: string, checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`group flex min-h-[104px] cursor-pointer items-start gap-4 rounded-2xl border p-4 transition-colors duration-200 sm:p-5 ${
        checked
          ? "border-primary/60 bg-primary/[0.09]"
          : "border-border/70 bg-background/60 hover:border-primary/35 hover:bg-card/80"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
          checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 bg-background"
        }`}
      >
        {checked && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </span>
      <input
        id={id}
        type="checkbox"
        value={value}
        checked={checked}
        onChange={(event) => onChange(value, event.currentTarget.checked)}
        className="sr-only"
      />
      <span className="min-w-0">
        <span className="block text-[0.68rem] font-bold uppercase tracking-[0.17em] text-primary/90">
          {title}
        </span>
        <span className="mt-2 block text-sm leading-relaxed text-foreground/85">{text}</span>
      </span>
    </label>
  );
}

export function RadiantAuditForm({
  initialEmail = "",
  initialDraft,
  onDraftChange,
  onDiscardDraft,
  draftWarning,
  needsAccount = false,
  needsVerification = false,
  submitting = false,
  error = null,
  onSubmit,
  onVerifyEmail,
  onSwitchAccount,
}: RadiantAuditFormProps) {
  const [email, setEmail] = useState(initialDraft?.email || initialEmail);
  useEffect(() => {
    if (initialEmail) setEmail(current => current || initialEmail);
  }, [initialEmail]);
  const [routineChecks, setRoutineChecks] = useState<string[]>(initialDraft?.routineChecks ?? []);
  const [valuesChecks, setValuesChecks] = useState<string[]>(initialDraft?.valuesChecks ?? []);
  const [beautyTrend, setBeautyTrend] = useState(initialDraft?.beautyTrend ?? "");
  const [masteryGoal, setMasteryGoal] = useState(initialDraft?.masteryGoal ?? "");
  const [researchTime, setResearchTime] = useState(initialDraft?.researchTime ?? "");
  const [writingError, setWritingError] = useState<string | null>(null);

  const answers = (): RadiantAuditSubmission => ({
    email: email.trim(),
    routineChecks,
    valuesChecks,
    beautyTrend: beautyTrend.trim(),
    masteryGoal: masteryGoal.trim(),
    researchTime: researchTime.trim(),
  });

  useEffect(() => {
    onDraftChange?.({ email, routineChecks, valuesChecks, beautyTrend, masteryGoal, researchTime });
  }, [email, routineChecks, valuesChecks, beautyTrend, masteryGoal, researchTime, onDraftChange]);

  const toggle = (setter: (value: string[] | ((previous: string[]) => string[])) => void) =>
    (value: string, checked: boolean) => {
      setter((previous) =>
        checked ? [...previous, value] : previous.filter((item) => item !== value),
      );
    };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (![beautyTrend, masteryGoal, researchTime].every((answer) => answer.trim().length > 0)) {
      setWritingError("Please complete each reflection before continuing.");
      return;
    }
    setWritingError(null);
    onSubmit(answers());
  };

  const routineToggle = toggle(setRoutineChecks);
  const valuesToggle = toggle(setValuesChecks);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -right-40 top-24 h-[28rem] w-[28rem] rounded-full bg-primary/[0.055] blur-[110px]" />
        <div className="absolute -left-48 top-[46rem] h-[30rem] w-[30rem] rounded-full bg-primary/[0.035] blur-[120px]" />
      </div>

      <main className="relative mx-auto w-full max-w-6xl px-4 pb-20 pt-10 sm:px-8 sm:pt-16 lg:px-12">
        <header className="mx-auto mb-12 max-w-3xl text-center sm:mb-16">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/[0.07] px-4 py-2 text-[0.65rem] font-semibold uppercase tracking-[0.23em] text-primary sm:text-xs">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            The Elevated Beauty Method ™
          </div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">
            A personal reflection · 10 quiet minutes
          </p>
          <h1 className="font-serif text-4xl font-bold leading-[1.04] sm:text-6xl md:text-7xl">
            The Radiant <span className="italic text-primary">Audit</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:mt-7 sm:text-lg">
            Discover your personal beauty blueprint. Before a woman can elevate her beauty, she must
            first see it clearly. Answer honestly, and let this audit show you where you stand today —
            and where your personal method begins.
          </p>
          <div className="mx-auto mt-8 h-px w-20 bg-primary/60" />
        </header>

        <form onSubmit={handleSubmit} noValidate={false} className="space-y-7 sm:space-y-9">
          <section className="overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/55 shadow-[0_24px_70px_-50px_rgba(220,206,191,0.35)]">
            <div className="border-b border-border/60 px-5 py-6 sm:px-9 sm:py-8">
              <div className="flex items-start gap-4">
                <span className="font-serif text-3xl italic text-primary/75">I.</span>
                <div>
                  <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-primary">Your starting point</p>
                  <h2 className="mt-1 font-serif text-2xl font-bold sm:text-3xl">Current Beauty Routine</h2>
                  <p className="mt-2 text-sm text-muted-foreground">Check each statement that is true for you today.</p>
                </div>
              </div>
            </div>
            <fieldset className="p-5 sm:p-9">
              <legend className="sr-only">Current Beauty Routine — select all statements that are true today</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {routineStatements.map((item, index) => (
                  <div key={item.value} className={index === 4 ? "sm:col-span-2" : ""}>
                    <CheckOption
                      id={`routine-${item.value}`}
                      {...item}
                      checked={routineChecks.includes(item.value)}
                      onChange={routineToggle}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border/50 pt-4 text-sm">
                <span className="text-muted-foreground">Current beauty routine</span>
                <span aria-live="polite" className="font-serif text-lg text-primary">
                  {routineChecks.length}<span className="text-muted-foreground"> /5</span>
                </span>
              </div>
            </fieldset>
          </section>

          <section className="overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/55 shadow-[0_24px_70px_-50px_rgba(220,206,191,0.35)]">
            <div className="border-b border-border/60 px-5 py-6 sm:px-9 sm:py-8">
              <div className="flex items-start gap-4">
                <span className="font-serif text-3xl italic text-primary/75">II.</span>
                <div>
                  <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-primary">What matters to you</p>
                  <h2 className="mt-1 font-serif text-2xl font-bold sm:text-3xl">The Elevated Woman Check-In</h2>
                  <p className="mt-2 text-sm text-muted-foreground">Check each question you answer with a quiet yes.</p>
                </div>
              </div>
            </div>
            <fieldset className="p-5 sm:p-9">
              <legend className="sr-only">The Elevated Woman Check-In — select all that you answer yes to</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {valuesQuestions.map((item, index) => (
                  <div key={item.value} className={index === 4 ? "sm:col-span-2" : ""}>
                    <CheckOption
                      id={`values-${item.value}`}
                      {...item}
                      checked={valuesChecks.includes(item.value)}
                      onChange={valuesToggle}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border/50 pt-4 text-sm">
                <span className="text-muted-foreground">The Elevated Woman check-in</span>
                <span aria-live="polite" className="font-serif text-lg text-primary">
                  {valuesChecks.length}<span className="text-muted-foreground"> /5</span>
                </span>
              </div>
            </fieldset>
          </section>

          <section className="overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/55 shadow-[0_24px_70px_-50px_rgba(220,206,191,0.35)]">
            <div className="border-b border-border/60 px-5 py-6 sm:px-9 sm:py-8">
              <div className="flex items-start gap-4">
                <span className="font-serif text-3xl italic text-primary/75">III.</span>
                <div>
                  <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-primary">Make room for your own words</p>
                  <h2 className="mt-1 font-serif text-2xl font-bold sm:text-3xl">In Your Own Words</h2>
                  <p className="mt-2 text-sm text-muted-foreground">There is no right answer. Begin with what is true for you.</p>
                </div>
              </div>
            </div>
            <div className="space-y-6 p-5 sm:p-9">
              <div>
                <label htmlFor="beauty-trend" className="mb-2 block text-sm font-medium">
                  The beauty trend I follow most is
                </label>
                <textarea
                  id="beauty-trend"
                  name="beautyTrend"
                  value={beautyTrend}
                  onChange={(event) => setBeautyTrend(event.target.value)}
                  maxLength={1000}
                  required
                  rows={3}
                  aria-invalid={!!writingError && !beautyTrend.trim()}
                  aria-describedby="reflection-guidance"
                  className="w-full resize-y rounded-xl border border-border bg-background/75 px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  placeholder="Name the look, technique, or idea that has your attention…"
                />
              </div>
              <div>
                <label htmlFor="mastery-goal" className="mb-2 block text-sm font-medium">
                  What I most want to master about my appearance is
                </label>
                <textarea
                  id="mastery-goal"
                  name="masteryGoal"
                  value={masteryGoal}
                  onChange={(event) => setMasteryGoal(event.target.value)}
                  maxLength={1000}
                  required
                  rows={3}
                  aria-invalid={!!writingError && !masteryGoal.trim()}
                  aria-describedby="reflection-guidance"
                  className="w-full resize-y rounded-xl border border-border bg-background/75 px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  placeholder="What would make getting ready feel more like you?"
                />
              </div>
              <div>
                <label htmlFor="research-time" className="mb-2 block text-sm font-medium">
                  The time I spend researching products per week is
                </label>
                <textarea
                  id="research-time"
                  name="researchTime"
                  value={researchTime}
                  onChange={(event) => setResearchTime(event.target.value)}
                  maxLength={1000}
                  required
                  rows={3}
                  aria-invalid={!!writingError && !researchTime.trim()}
                  aria-describedby="reflection-guidance"
                  className="w-full resize-y rounded-xl border border-border bg-background/75 px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  placeholder="A rough estimate is perfect…"
                />
              </div>
              <p id="reflection-guidance" className="text-xs text-muted-foreground">
                Required · Up to 1,000 characters each
              </p>
              {writingError && (
                <p role="alert" className="text-sm text-destructive">{writingError}</p>
              )}
            </div>
          </section>

          <section className="relative overflow-hidden rounded-[1.75rem] border border-primary/25 bg-card/75 p-5 sm:p-9">
            <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-primary/[0.055] blur-[70px]" aria-hidden="true" />
            <div className="relative">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-primary">Your reading</p>
                  <h2 className="mt-2 font-serif text-2xl font-bold sm:text-3xl">The Radiant Audit</h2>
                </div>
                <CircleDot className="mt-1 h-6 w-6 shrink-0 text-primary/70" aria-hidden="true" />
              </div>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Fewer checks in Section I, more in Section II? That space between where your routine is
                and what you truly value is exactly where The Elevated Beauty Method ™ begins.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background/60 px-4 py-3">
                  <span className="text-sm">Section I <span className="text-muted-foreground">· Current routine</span></span>
                  <span className="font-serif text-xl text-primary">{routineChecks.length}<span className="text-sm text-muted-foreground"> /5</span></span>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background/60 px-4 py-3">
                  <span className="text-sm">Section II <span className="text-muted-foreground">· Your values</span></span>
                  <span className="font-serif text-xl text-primary">{valuesChecks.length}<span className="text-sm text-muted-foreground"> /5</span></span>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-border/70 bg-card/40 p-5 sm:p-9">
            <div className="mb-7">
              <p className="text-[0.65rem] font-bold uppercase tracking-[0.22em] text-primary">A note for your next step</p>
              <h2 className="mt-2 font-serif text-2xl font-bold sm:text-3xl">Your reflection, held with care.</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {needsAccount
                  ? "Enter your email to continue to free account creation. Your answers are saved only after you verify your account."
                  : "Confirm your account email to save your Radiant Audit reflection."}
              </p>
            </div>
            <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <label htmlFor="audit-email" className="mb-2 block text-sm font-medium">Email address</label>
                <input
                  id="audit-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  className="h-12 w-full rounded-xl border border-border bg-background/75 px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  placeholder="you@example.com"
                />
              </div>
              <Button
                type="submit"
                disabled={submitting}
                className="h-12 rounded-full bg-primary px-7 font-semibold text-primary-foreground transition-transform hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Saving your reflection…" : needsAccount ? "Continue to free account" : "Save my Audit"}
                {!submitting && <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />}
              </Button>
            </div>
            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </p>
            )}
            {needsVerification && (
              <div className="mt-5 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
                <p>Verify your primary email before saving. Open your account profile, choose Email addresses, and follow the verification steps. Your answers will stay in this browser.</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button type="button" variant="outline" onClick={() => onVerifyEmail?.(answers())}>Verify my email</Button>
                  <Button type="button" variant="ghost" onClick={() => onSwitchAccount?.(answers())}>Use another account</Button>
                </div>
              </div>
            )}
            {onDiscardDraft && (
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                 <span>Your unfinished answers are saved privately to your account for up to 24 hours and can be continued on another device. This browser also keeps a temporary copy; avoid shared devices.</span>
                <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onDiscardDraft} data-testid="button-discard-audit-draft">
                  Discard draft
                </Button>
              </div>
            )}
            {draftWarning && <p role="alert" className="mt-3 text-sm text-destructive">{draftWarning}</p>}
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              Your answers are a starting point — not a judgment. Every beauty method begins with understanding you.
            </p>
          </section>
        </form>

        <section className="mt-16 sm:mt-24" aria-labelledby="framework-title">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.25em] text-primary">The foundation of the proprietary method™</p>
            <h2 id="framework-title" className="mt-3 font-serif text-3xl font-bold sm:text-5xl">The 5-Stage Transformation Framework</h2>
            <p className="mt-3 text-sm text-muted-foreground">The Elevated Beauty Experience ™</p>
          </div>
          <div className="mb-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-3 text-xs font-bold uppercase tracking-[0.16em] text-primary sm:gap-x-4 sm:text-sm">
            {framework.map((stage, index) => (
              <span key={stage.stage} className="inline-flex items-center gap-2 sm:gap-4">
                <span>{stage.name}</span>
                {index < framework.length - 1 && <span aria-hidden="true" className="text-primary/45">→</span>}
              </span>
            ))}
          </div>
          <p className="mx-auto mb-8 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
            Every transformation within The Method follows one intentional path. Five stages, each built
            on the last, guide you from hesitant and invisible to radiant and confident.
          </p>
          <ol className="relative grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {framework.map((stage, index) => (
              <li
                key={stage.stage}
                className={`rounded-2xl border border-border/70 bg-card/45 p-5 transition-colors hover:border-primary/35 ${
                  index === 0 || index === 1 ? "lg:col-span-3" : "lg:col-span-2"
                }`}
              >
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-primary/80">Stage {stage.stage}</span>
                <h3 className="mt-2 font-serif text-2xl font-bold">{stage.name}</h3>
                <p className="mt-1 text-sm font-medium text-foreground/85">{stage.line}</p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{stage.detail}</p>
              </li>
            ))}
          </ol>
        </section>

        <footer className="mt-16 border-t border-border/60 pt-8 text-center sm:mt-20">
          <p className="font-serif text-2xl font-semibold">You’re ready for The Method.</p>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
            Join our free community and start building your personal beauty blueprint today.
          </p>
          <p className="mt-6 text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground/75">
            The Elevated Beauty Method ™
          </p>
        </footer>
      </main>
    </div>
  );
}