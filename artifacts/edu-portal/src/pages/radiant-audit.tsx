import { useEffect, useRef, useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import { useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRadiantAudit,
  useGetRadiantAuditHistory,
  useSaveRadiantAudit,
  getGetRadiantAuditQueryKey,
  getGetRadiantAuditHistoryQueryKey,
  type RadiantAuditInput,
} from "@workspace/api-client-react";
import { RadiantAuditForm, type RadiantAuditSubmission } from "@/components/radiant-audit-form";
import { RadiantAuditComparison } from "@/components/radiant-audit-comparison";
import { trackEvent, trackRadiantAuditSaved } from "@/lib/analytics";
import { clearPendingAudit, readPendingAudit, stageAudit } from "@/lib/radiant-audit-session";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";

function auditAnswers(audit: RadiantAuditSubmission): RadiantAuditInput {
  return {
    routineChecks: audit.routineChecks as RadiantAuditInput["routineChecks"],
    valuesChecks: audit.valuesChecks as RadiantAuditInput["valuesChecks"],
    beautyTrend: audit.beautyTrend,
    masteryGoal: audit.masteryGoal,
    researchTime: audit.researchTime,
  };
}

export default function RadiantAuditPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useSaveRadiantAudit();
  const email = user?.primaryEmailAddress?.emailAddress;

  async function handleSubmit(audit: RadiantAuditSubmission) {
    setError(null);
    if (!isLoaded) return;
    if (isSignedIn) {
      if (!email || email.toLowerCase() !== audit.email.toLowerCase()) {
        setError(`You're signed in with ${email || "another account"}. Enter that email to save this Audit, or sign out first.`);
        return;
      }
      try {
        const saved = await save.mutateAsync({ data: auditAnswers(audit) });
        trackRadiantAuditSaved(saved.completionKind);
        queryClient.setQueryData(getGetRadiantAuditQueryKey(), saved.audit);
        void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
        navigate("/radiant-audit/complete");
      } catch {
        setError("We couldn't save your Audit. Your answers are still here; please try again.");
      }
      return;
    }
    try {
      stageAudit(audit);
      trackEvent("radiant_audit_signup_started");
      navigate("/sign-up");
    } catch {
      setError("We couldn't keep your answers for sign-up in this browser. Please enable session storage and try again.");
    }
  }

  return (
    <RadiantAuditForm
      initialEmail={email}
      needsAccount={!isSignedIn}
      submitting={!isLoaded || save.isPending}
      error={error}
      onSubmit={handleSubmit}
    />
  );
}

export function RadiantAuditCompletePage() {
  const { signOut } = useClerk();
  const { user, isLoaded } = useUser();
  const [pending, setPending] = useState(readPendingAudit);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const queryClient = useQueryClient();
  const save = useSaveRadiantAudit();
  const { data: saved, isLoading, isError } = useGetRadiantAudit({
    query: { queryKey: getGetRadiantAuditQueryKey(), enabled: !pending },
  });
  const { data: history, isLoading: historyLoading, isError: historyError } = useGetRadiantAuditHistory({
    query: { queryKey: getGetRadiantAuditHistoryQueryKey(), enabled: !pending && !!saved },
  });
  const email = user?.primaryEmailAddress?.emailAddress;
  const mismatch = !!pending && !!isLoaded &&
    (!email || email.toLowerCase() !== pending.email.toLowerCase());

  async function submitPending(audit: RadiantAuditSubmission) {
    setError(null);
    try {
      const result = await save.mutateAsync({ data: auditAnswers(audit) });
      trackRadiantAuditSaved(result.completionKind);
      queryClient.setQueryData(getGetRadiantAuditQueryKey(), result.audit);
      void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
      clearPendingAudit();
      setPending(null);
    } catch {
      setError("We couldn't save your Audit. Your answers are still in this browser. Please try again.");
    }
  }

  useEffect(() => {
    if (!pending || !isLoaded || !user || mismatch || started.current) return;
    started.current = true;
    void submitPending(pending);
  }, [pending, isLoaded, user, mismatch]);

  return (
    <div className="min-h-screen bg-background px-4 py-12 text-foreground sm:py-20">
      <main className="mx-auto max-w-3xl rounded-3xl border border-primary/25 bg-card/70 p-6 shadow-xl sm:p-12">
        {mismatch ? (
          <>
            <h1 className="font-serif text-4xl">Check your email address</h1>
            <p className="mt-4 text-muted-foreground">
              Your Audit was entered with {pending?.email}, but you signed in as {email || "a different account"}.
              To protect your answers, sign in with the email you entered or start a new Audit with this account.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button onClick={() => void signOut({ redirectUrl: `${import.meta.env.BASE_URL}sign-in` })}>
                Sign in with that email
              </Button>
              <Button asChild variant="outline"><Link href="/radiant-audit">Start a new Audit</Link></Button>
            </div>
          </>
        ) : pending ? (
          <>
            <h1 className="font-serif text-4xl">Saving your Radiant Audit</h1>
            <p className="mt-4 text-muted-foreground">Your free account is ready. We’re attaching your answers to it now.</p>
            {error && (
              <div className="mt-6" role="alert">
                <p className="text-destructive">{error}</p>
                <Button className="mt-4" onClick={() => void submitPending(pending)} disabled={save.isPending}>Try saving again</Button>
              </div>
            )}
          </>
        ) : isLoading ? (
          <p role="status">Loading your Audit…</p>
        ) : isError ? (
          <p role="alert">We couldn't load your Audit. Please refresh and try again.</p>
        ) : saved ? (
          <>
            <CheckCircle2 className="mb-5 h-9 w-9 text-primary" aria-hidden="true" />
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">Your reflection is saved</p>
            <h1 className="mt-3 font-serif text-4xl sm:text-5xl">Your Radiant Audit</h1>
            <p className="mt-4 text-muted-foreground">
              Fewer checks in Section I, more in Section II? That space between where your routine is and what you truly value is where The Elevated Beauty Method ™ begins.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border p-5">
                <p className="text-sm text-muted-foreground">Current beauty routine</p>
                <p className="mt-2 font-serif text-3xl text-primary">{saved.routineScore} / 5</p>
              </div>
              <div className="rounded-2xl border border-border p-5">
                <p className="text-sm text-muted-foreground">The Elevated Woman check-in</p>
                <p className="mt-2 font-serif text-3xl text-primary">{saved.valuesScore} / 5</p>
              </div>
            </div>
            <h2 className="mt-9 font-serif text-2xl">In your own words</h2>
            <dl className="mt-4 space-y-5">
              {[
                ["The beauty trend I follow most", saved.beautyTrend],
                ["What I most want to master about my appearance", saved.masteryGoal],
                ["Time spent researching products each week", saved.researchTime],
              ].map(([label, value]) => (
                <div key={label} className="border-b border-border pb-4">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {historyLoading ? (
              <p className="mt-8" role="status">Loading earlier Audits…</p>
            ) : historyError ? (
              <p className="mt-8 text-destructive" role="alert">We couldn't load your earlier Audits. Please refresh and try again.</p>
            ) : (
              <RadiantAuditComparison latest={saved} history={history ?? []} />
            )}
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild><Link href="/dashboard">Explore your free dashboard</Link></Button>
              <Button asChild variant="outline"><Link href="/radiant-audit">Retake the Audit</Link></Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="font-serif text-4xl">Start your Radiant Audit</h1>
            <p className="mt-4 text-muted-foreground">There isn't an Audit saved for this account yet.</p>
            <Button asChild className="mt-6"><Link href="/radiant-audit">Complete the Audit</Link></Button>
          </>
        )}
      </main>
    </div>
  );
}