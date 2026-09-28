import { useCallback, useEffect, useRef, useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import { useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRadiantAudit,
  useGetRadiantAuditHistory,
  useSaveRadiantAudit,
  useDeleteRadiantAudit,
  getGetRadiantAuditQueryKey,
  getGetRadiantAuditHistoryQueryKey,
  type RadiantAuditInput,
  type RadiantAuditDraft,
  type RadiantAuditStoredDraft,
  getRadiantAuditDraft,
  getRadiantAudit,
  saveRadiantAuditDraft,
  deleteRadiantAuditDraft,
} from "@workspace/api-client-react";
import { RadiantAuditForm, type RadiantAuditSubmission } from "@/components/radiant-audit-form";
import { RadiantAuditComparison } from "@/components/radiant-audit-comparison";
import {
  clearAuditVerification, rememberAuditVerification, trackAuditResumptionIfRequested,
  trackAuditVerificationAction, trackEvent, trackRadiantAuditSaved,
} from "@/lib/analytics";
import { clearPendingAudit, isAuditReadyToSave, readPendingAudit, stageAudit } from "@/lib/radiant-audit-session";
import { auditDraftWrittenAt, clearAuditDraft, getAuditSubmissionId, readAuditDraft, writeAuditDraft } from "@/lib/radiant-audit-draft";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  const { openUserProfile, signOut } = useClerk();
  const { user, isLoaded, isSignedIn } = useUser();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [draftConflict, setDraftConflict] = useState<{ draft: RadiantAuditStoredDraft | null; discarded: boolean } | null>(null);
  const [completedConflict, setCompletedConflict] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [loadedDraft, setLoadedDraft] = useState<{ accountId: string; answers: RadiantAuditSubmission | null } | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftWrite = useRef<Promise<void>>(Promise.resolve());
  const draftBlocked = useRef(false);
  const conflictPending = useRef(false);
  const draftVersion = useRef<{ owner: string; revision: string } | null>(null);
  const latestAnswers = useRef<RadiantAuditSubmission | null>(null);
  const skipRestoredChange = useRef(false);
  const draftBaseline = useRef<{ owner: string; completedAt: string } | null>(null);
  const draftHadAnswers = useRef(false);
  const save = useSaveRadiantAudit();
  const attempt = useRef<{ accountId: string; answers: string; id: string } | null>(null);
  const email = user?.primaryEmailAddress?.emailAddress;
  const accountId = isLoaded && isSignedIn ? user?.id : undefined;
  const activeAccount = useRef(accountId);
  activeAccount.current = accountId;
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    setLoadedDraft(null);
    setDraftConflict(null);
    setCompletedConflict(false);
    draftBlocked.current = false;
    conflictPending.current = false;
    draftBaseline.current = null;
    draftVersion.current = null;
    draftHadAnswers.current = false;
    const local = readAuditDraft(accountId);
    void getRadiantAuditDraft({ responseType: "json" }).then(async remote => {
      let localAnswer = local;
      const current = await getRadiantAudit({ responseType: "json" });
      const completedAt = current ? Date.parse(current.completedAt) : null;
      let remoteAnswer = remote;
      if (remoteAnswer && "updatedAt" in remoteAnswer && completedAt != null &&
          Date.parse(remoteAnswer.updatedAt) <= completedAt) {
        remoteAnswer = null;
      }
      const discardedAt = remote && "discardedAt" in remote ? Date.parse(remote.discardedAt) : null;
      if (discardedAt != null && localAnswer) {
        const writtenAt = auditDraftWrittenAt(accountId);
        if (writtenAt == null || writtenAt <= discardedAt) {
          clearAuditDraft(accountId);
          localAnswer = null;
        }
      }
      if (remote && "updatedAt" in remote && localAnswer) {
        const writtenAt = auditDraftWrittenAt(accountId);
        if (writtenAt == null || writtenAt <= Date.parse(remote.updatedAt)) {
          clearAuditDraft(accountId);
          localAnswer = null;
        }
      }
      if (localAnswer && completedAt != null) {
        const writtenAt = auditDraftWrittenAt(accountId);
        if (writtenAt == null || writtenAt <= completedAt) {
          clearAuditDraft(accountId);
          localAnswer = null;
        }
      }
      if (active) {
        const answers = localAnswer ?? (remoteAnswer && !("discardedAt" in remoteAnswer)
          ? { ...remoteAnswer, email: email ?? "" } : readPendingAudit());
        draftBaseline.current = { owner: accountId, completedAt: current?.completedAt ?? "none" };
        draftVersion.current = { owner: accountId, revision: remote
          ? ("discardedAt" in remote ? remote.discardedAt : remote.updatedAt) : "none" };
        draftHadAnswers.current = !!(answers?.routineChecks.length || answers?.valuesChecks.length ||
          answers?.beautyTrend || answers?.masteryGoal || answers?.researchTime);
        setLoadedDraft({ accountId, answers });
        latestAnswers.current = answers;
      }
    }).catch(() => {
      if (active) {
        setLoadedDraft({ accountId, answers: local ?? readPendingAudit() });
        setDraftWarning("Your online draft couldn't be loaded. Your answers can still be saved on this device.");
      }
    });
    return () => {
      active = false;
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [accountId, email]);

  const showDraftConflict = useCallback(async (owner: string) => {
    if (owner !== activeAccount.current) return;
    draftBlocked.current = true;
    conflictPending.current = true;
    try {
      const remote = await getRadiantAuditDraft({ responseType: "json" });
      if (owner !== activeAccount.current) return;
      draftVersion.current = { owner, revision: remote
        ? ("discardedAt" in remote ? remote.discardedAt : remote.updatedAt) : "none" };
      setDraftConflict({
        draft: remote && "updatedAt" in remote ? remote : null,
        discarded: !!remote && "discardedAt" in remote,
      });
      setDraftWarning(null);
    } catch {
      setDraftWarning("Another device changed your online draft. Reload this page to compare drafts.");
    }
  }, []);

  const handleDraftConflict = useCallback((owner: string, failure: unknown) => {
    if (owner !== activeAccount.current) return;
    const error = failure as { status?: number; data?: { code?: string } };
    if (error.status !== 409) return false;
    if (error.data?.code === "completed_audit_changed") {
      draftBlocked.current = true;
      conflictPending.current = true;
      setDraftConflict(null);
      setCompletedConflict(true);
    } else {
      void showDraftConflict(owner);
    }
    return true;
  }, [showDraftConflict]);

  const queueDraft = useCallback((owner: string, answers: RadiantAuditSubmission) => {
    const baseline = draftBaseline.current?.owner === owner ? draftBaseline.current.completedAt : null;
    if (!baseline) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      if (draftBlocked.current) return;
      const data = auditAnswers(answers) as RadiantAuditDraft;
      // Serial writes prevent an older response from replacing the newest answers.
      draftWrite.current = draftWrite.current.catch(() => {}).then(async () => {
        if (draftBlocked.current) return;
        const saved = await saveRadiantAuditDraft(data, { headers: {
          "x-audit-draft-owner": owner,
          "x-audit-draft-baseline": baseline,
          "x-audit-draft-revision": draftVersion.current?.owner === owner ? draftVersion.current.revision : "none",
        } });
        if (draftVersion.current?.owner === owner) draftVersion.current.revision = saved.updatedAt;
      }).catch((failure: unknown) => {
        if (!handleDraftConflict(owner, failure) && owner === activeAccount.current) {
          setDraftWarning("Your online draft couldn't be saved. Your answers are still in this browser.");
        }
      });
    }, 600);
  }, [handleDraftConflict]);
  const queueClearDraft = useCallback((owner: string) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      if (draftBlocked.current) return;
      draftWrite.current = draftWrite.current.catch(() => {}).then(async () => {
        if (draftBlocked.current) return;
        await deleteRadiantAuditDraft({ headers: {
          "x-audit-draft-owner": owner,
          "x-audit-draft-revision": draftVersion.current?.owner === owner ? draftVersion.current.revision : "none",
        } });
        // A deletion marker has its own revision; read it before another write.
        const remote = await getRadiantAuditDraft({ responseType: "json" });
        if (draftVersion.current?.owner === owner && remote && "discardedAt" in remote)
          draftVersion.current.revision = remote.discardedAt;
      }).catch((failure: unknown) => {
        if (typeof failure === "object" && failure !== null && "status" in failure && failure.status === 409) {
          void showDraftConflict(owner);
        } else if (owner === activeAccount.current) {
          setDraftWarning("Your online draft couldn't be cleared. Please try discarding it.");
        }
      });
    }, 600);
  }, [showDraftConflict]);
  const persistDraft = useCallback((answers: RadiantAuditSubmission) => {
    if (!accountId) return;
    latestAnswers.current = answers;
    if (skipRestoredChange.current) {
      skipRestoredChange.current = false;
      return;
    }
    const hasAnswers = !!(answers.routineChecks.length || answers.valuesChecks.length ||
      answers.beautyTrend || answers.masteryGoal || answers.researchTime);
    try {
      if (!answers.routineChecks.length && !answers.valuesChecks.length &&
          !answers.beautyTrend && !answers.masteryGoal && !answers.researchTime &&
          answers.email === (email ?? "")) {
        clearAuditDraft(accountId);
      } else {
        writeAuditDraft(accountId, answers);
      }
      setDraftWarning(null);
    } catch {
      setDraftWarning("This browser couldn't keep your draft. Keep this page open until your Audit is saved.");
    }
    if (!draftBlocked.current) {
      if (hasAnswers) queueDraft(accountId, answers);
      else if (draftHadAnswers.current) queueClearDraft(accountId);
    }
    draftHadAnswers.current = hasAnswers;
  }, [accountId, email, queueDraft, queueClearDraft]);

  async function keepThisDraft() {
    if (!accountId || !latestAnswers.current || !draftConflict) return;
    const answers = latestAnswers.current;
    try {
      const saved = await saveRadiantAuditDraft(auditAnswers(answers) as RadiantAuditDraft, { headers: {
        "x-audit-draft-owner": accountId,
        "x-audit-draft-baseline": draftBaseline.current?.completedAt ?? "none",
        "x-audit-draft-revision": draftVersion.current?.revision ?? "none",
      } });
      draftVersion.current = { owner: accountId, revision: saved.updatedAt };
      setDraftConflict(null);
      setDraftWarning(null);
      conflictPending.current = false;
      draftBlocked.current = false;
    } catch (failure) {
      if (!handleDraftConflict(accountId, failure)) setDraftWarning("Your choice couldn't be saved online. Try again.");
    }
  }

  function useOtherDraft() {
    if (!accountId || !draftConflict) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const answers = draftConflict.draft ? { ...draftConflict.draft, email: email ?? "" } : null;
    try { clearAuditDraft(accountId); } catch { /* The online draft is still available. */ }
    skipRestoredChange.current = true;
    latestAnswers.current = answers;
    draftHadAnswers.current = !!answers;
    setLoadedDraft({ accountId, answers });
    setDraftRevision(value => value + 1);
    setDraftConflict(null);
    setDraftWarning(null);
    conflictPending.current = false;
    draftBlocked.current = false;
  }

  async function discardDraft() {
    if (draftConflict) return;
    draftBlocked.current = true;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    try {
      await draftWrite.current;
      await deleteRadiantAuditDraft({ headers: {
        "x-audit-draft-owner": accountId!,
        "x-audit-draft-revision": draftVersion.current?.revision ?? "none",
      } });
      const marker = await getRadiantAuditDraft({ responseType: "json" });
      if (marker && "discardedAt" in marker) draftVersion.current = { owner: accountId!, revision: marker.discardedAt };
      clearAuditDraft(accountId);
      clearPendingAudit();
      attempt.current = null;
      draftHadAnswers.current = false;
      setDraftWarning(null);
      setError(null);
      setLoadedDraft({ accountId: accountId!, answers: null });
      setDraftRevision(revision => revision + 1);
      conflictPending.current = false;
      draftBlocked.current = false;
    } catch (failure) {
      if (typeof failure === "object" && failure !== null && "status" in failure && failure.status === 409)
        await showDraftConflict(accountId!);
      else {
        draftBlocked.current = false;
        setDraftWarning("Your draft couldn't be removed everywhere. Please try again.");
      }
    }
  }

  async function handleSubmit(audit: RadiantAuditSubmission) {
    if (conflictPending.current || draftBlocked.current) {
      setError(completedConflict ? "Reload and review the Audit saved on your other device before submitting again." : "Choose which unfinished draft to keep before saving your Audit.");
      return;
    }
    setError(null);
    if (!isLoaded) return;
    if (isSignedIn) {
      if (user?.primaryEmailAddress?.verification.status !== "verified") {
        setError("Verify your account email before saving your Audit.");
        return;
      }
      if (!email || email.toLowerCase() !== audit.email.toLowerCase()) {
        setError(`You're signed in with ${email || "another account"}. Enter that email to save this Audit, or sign out first.`);
        return;
      }
      try {
        draftBlocked.current = true;
        if (draftTimer.current) clearTimeout(draftTimer.current);
        await draftWrite.current;
        if (conflictPending.current) {
          setError(completedConflict ? "Reload and review the Audit saved on your other device before submitting again." : "Choose which unfinished draft to keep before saving your Audit.");
          return;
        }
        const answers = auditAnswers(audit);
        const signature = JSON.stringify(answers);
        if (attempt.current?.accountId !== user!.id || attempt.current.answers !== signature) {
          let id: string;
          try {
            id = getAuditSubmissionId(user!.id, audit);
          } catch {
            // Saving still works when local browser storage is unavailable.
            id = crypto.randomUUID();
          }
          attempt.current = { accountId: user!.id, answers: signature, id };
        }
        const saved = await save.mutateAsync({ data: { ...answers, submissionId: attempt.current.id } });
        // Clear only after the server confirms the save.
        try { clearAuditDraft(user?.id); } catch { /* A storage failure must not hide a confirmed save. */ }
        trackRadiantAuditSaved(saved.completionKind);
        trackAuditResumptionIfRequested(user!.id, "form");
        queryClient.setQueryData(getGetRadiantAuditQueryKey(), saved.audit);
        void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
        try { clearPendingAudit(); } catch { /* A storage failure must not hide a confirmed save. */ }
        navigate("/radiant-audit/complete");
      } catch {
        if (!conflictPending.current) {
          draftBlocked.current = false;
          if (accountId) queueDraft(accountId, audit);
        }
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

  function keepAnswers(audit: RadiantAuditSubmission): boolean {
    try {
      stageAudit(audit);
      setError(null);
      return true;
    } catch {
      setError("We couldn't keep your answers in this browser. Please enable session storage before leaving this form.");
      return false;
    }
  }

  if (!isLoaded) return <p role="status">Loading your Audit…</p>;
  if (accountId && loadedDraft?.accountId !== accountId) return <p role="status">Loading your draft…</p>;

  return (
    <>
    {completedConflict && (
      <section role="alert" className="mx-auto mb-6 max-w-3xl rounded-xl border border-primary/50 bg-card p-5">
        <h2 className="font-serif text-xl">Your completed Audit changed on another device</h2>
        <p className="mt-2 text-sm">Your answers are still saved in this browser. Reload to review the latest completed Audit before you start or submit another one.</p>
        <Button type="button" className="mt-4" onClick={() => window.location.reload()}>Reload and review Audit</Button>
      </section>
    )}
    {draftConflict && (
      <section role="alert" className="mx-auto mb-6 max-w-3xl rounded-xl border border-primary/50 bg-card p-5">
        <h2 className="font-serif text-xl">Your Audit draft changed on another device</h2>
        <p className="mt-2 text-sm">Your answers on this device are still here. {draftConflict.draft
          ? "The online draft has different answers. Choose which complete draft to keep; the other version will be replaced."
          : draftConflict.discarded ? "The online draft was discarded on another device. Choose whether to restore your answers or keep it discarded."
          : "The online draft is no longer available. Choose whether to save these answers as a new draft or clear this form."}</p>
        {draftConflict.draft && <div className="mt-3 rounded-lg bg-muted p-3 text-sm">
          <p className="font-semibold">Online draft from the other device</p>
          <p>Beauty trend: {draftConflict.draft.beautyTrend || "Not answered"}</p>
          <p>Mastery goal: {draftConflict.draft.masteryGoal || "Not answered"}</p>
          <p>Research time: {draftConflict.draft.researchTime || "Not answered"}</p>
          <p>Routine choices: {draftConflict.draft.routineChecks.join(", ") || "None"}</p>
          <p>Values choices: {draftConflict.draft.valuesChecks.join(", ") || "None"}</p>
        </div>}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="button" onClick={() => void keepThisDraft()}>Keep this device's answers</Button>
          <Button type="button" variant="outline" onClick={useOtherDraft}>{draftConflict.draft ? "Use the other device's answers" : "Keep the online draft discarded"}</Button>
        </div>
      </section>
    )}
    <RadiantAuditForm
      key={`${accountId ?? "visitor"}:${draftRevision}`}
      initialEmail={email}
      initialDraft={accountId ? loadedDraft?.answers : null}
      onDraftChange={accountId ? persistDraft : undefined}
      onDiscardDraft={accountId ? discardDraft : undefined}
      draftWarning={draftWarning}
      needsAccount={!isSignedIn}
      needsVerification={!!isSignedIn && user?.primaryEmailAddress?.verification.status !== "verified"}
      submitting={!isLoaded || save.isPending}
      error={error}
      onSubmit={handleSubmit}
      onVerifyEmail={audit => {
        if (keepAnswers(audit)) {
          if (accountId) rememberAuditVerification(accountId);
          trackAuditVerificationAction("verify_email", "form");
          openUserProfile();
        }
      }}
      onSwitchAccount={audit => {
        if (keepAnswers(audit)) {
          clearAuditVerification();
          trackAuditVerificationAction("switch_account", "form");
          void signOut({ redirectUrl: `${import.meta.env.BASE_URL}sign-in` });
        }
      }}
    />
    </>
  );
}

export function RadiantAuditCompletePage() {
  const { signOut, openUserProfile } = useClerk();
  const { user, isLoaded } = useUser();
  const [pending, setPending] = useState(readPendingAudit);
  const [error, setError] = useState<string | null>(null);
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  const [confirmDeleteCurrent, setConfirmDeleteCurrent] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const started = useRef(false);
  const queryClient = useQueryClient();
  const save = useSaveRadiantAudit();
  const deleteCurrent = useDeleteRadiantAudit();
  const { data: saved, isLoading, isError } = useGetRadiantAudit({
    query: { queryKey: getGetRadiantAuditQueryKey(), enabled: !pending },
    request: { responseType: "json" },
  });
  const { data: history, isLoading: historyLoading, isError: historyError } = useGetRadiantAuditHistory({
    query: { queryKey: getGetRadiantAuditHistoryQueryKey(), enabled: !pending && !isLoading && !isError },
  });
  const email = user?.primaryEmailAddress?.emailAddress;
  const verifiedEmail = user?.primaryEmailAddress?.verification.status === "verified" ? email : undefined;
  const mismatch = !!pending && !!isLoaded &&
    (!verifiedEmail || verifiedEmail.toLowerCase() !== pending.email.toLowerCase());

  async function confirmCurrentDeletion() {
    setDeleteError(null);
    try {
      await deleteCurrent.mutateAsync();
      queryClient.setQueryData(getGetRadiantAuditQueryKey(), null);
      setConfirmDeleteCurrent(false);
      void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
    } catch {
      try {
        // The server may have committed the deletion before the response was lost.
        // Read its current state rather than assuming a failed request left the Audit intact.
        const current = await getRadiantAudit({ responseType: "json" });
        queryClient.setQueryData(getGetRadiantAuditQueryKey(), current);
        if (current === null) {
          setConfirmDeleteCurrent(false);
          void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
        } else {
          setDeleteError("We couldn't delete your current Audit. Please try again.");
        }
      } catch {
        setDeleteError("We couldn't confirm whether your current Audit was deleted. Please refresh to check before trying again.");
      }
    }
  }

  async function submitPending(audit: RadiantAuditSubmission) {
    setError(null);
    // Check again on retries; never rely on an earlier render's account identity.
    const currentEmail = user?.primaryEmailAddress;
    if (!user || currentEmail?.verification.status !== "verified" ||
        currentEmail.emailAddress.toLowerCase() !== audit.email.toLowerCase()) {
      setError("Sign in with the verified email for this Audit before saving your answers.");
      return;
    }
    try {
      // Persist the ID before sending, so a refresh or lost response retries the
      // same submission rather than creating a retake.
      const staged = stageAudit(audit);
      const result = await save.mutateAsync({ data: { ...auditAnswers(audit), submissionId: staged.submissionId } });
      trackRadiantAuditSaved(result.completionKind);
      trackAuditResumptionIfRequested(user.id, "completion");
      queryClient.setQueryData(getGetRadiantAuditQueryKey(), result.audit);
      void queryClient.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() });
      clearPendingAudit();
      try { clearAuditDraft(user.id); } catch { /* The submission is already confirmed. */ }
      setPending(null);
    } catch {
      setError("We couldn't save your Audit. Your answers are still in this browser. Please try again.");
    }
  }

  function confirmEmailCorrection() {
    if (!pending || !verifiedEmail || confirmedEmail !== verifiedEmail ||
        pending.email.toLowerCase() === verifiedEmail.toLowerCase()) return;
    try {
      // Persist consent's target before allowing the pending save to resume on reload.
      const corrected = { ...pending, email: verifiedEmail };
      stageAudit(corrected);
      setError(null);
      setPending(corrected);
    } catch {
      setError("We couldn't keep your corrected email in this browser. Your answers are still here; please try again.");
    }
  }

  useEffect(() => {
    if (!pending || !isAuditReadyToSave(pending) || !isLoaded || !user || mismatch || started.current) return;
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
              Your answers are still in this browser and haven't been saved to this account.
            </p>
            {verifiedEmail ? (
              <div className="mt-6 rounded-2xl border border-primary/25 p-5">
                <p>Entered the wrong email? You can save these answers to your verified account at <strong>{verifiedEmail}</strong> instead.</p>
                <label className="mt-4 flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={confirmedEmail === verifiedEmail}
                    onChange={(event) => setConfirmedEmail(event.target.checked ? verifiedEmail : null)}
                  />
                  I confirm that these are my Audit answers and agree to save them to {verifiedEmail}.
                </label>
                <Button className="mt-4" disabled={confirmedEmail !== verifiedEmail || save.isPending} onClick={confirmEmailCorrection}>
                  Correct email and save my Audit
                </Button>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-muted-foreground">Verify your primary email in your account profile under Email addresses before saving these answers, or sign in with the email you entered.</p>
                {user && (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button variant="outline" onClick={() => {
                      rememberAuditVerification(user.id);
                      trackAuditVerificationAction("verify_email", "completion");
                      openUserProfile();
                    }}>Verify my email</Button>
                    <Button variant="ghost" onClick={() => void user.reload().catch(() => setError("We couldn't check your email status. Please try again."))}>Check verification status</Button>
                  </div>
                )}
              </div>
            )}
            {error && <p className="mt-4 text-destructive" role="alert">{error}</p>}
            <div className="mt-8 flex flex-wrap gap-4">
              <Button asChild variant="outline"><Link href="/radiant-audit">Edit my answers</Link></Button>
              <Button onClick={() => {
                clearAuditVerification();
                trackAuditVerificationAction("switch_account", "completion");
                void signOut({ redirectUrl: `${import.meta.env.BASE_URL}sign-in` });
              }}>
                Use another account
              </Button>
            </div>
          </>
        ) : pending ? (
          <>
            <h1 className="font-serif text-4xl">{isAuditReadyToSave(pending) ? "Saving your Radiant Audit" : "Finish your Radiant Audit"}</h1>
            <p className="mt-4 text-muted-foreground">
              {isAuditReadyToSave(pending) ? "Your free account is ready. We’re attaching your answers to it now." : "Your answers are still in this browser. Finish the form before saving."}
            </p>
            {!isAuditReadyToSave(pending) && <Button asChild className="mt-4"><Link href="/radiant-audit">Continue my Audit</Link></Button>}
            {error && (
              <div className="mt-6" role="alert">
                <p className="text-destructive">{error}</p>
                {isAuditReadyToSave(pending) && (
                  <Button className="mt-4" onClick={() => void submitPending(pending)} disabled={save.isPending}>Try saving again</Button>
                )}
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
              <RadiantAuditComparison key={user?.id} accountId={user?.id ?? ""} latest={saved} history={history ?? []} />
            )}
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild><Link href="/dashboard">Explore your free dashboard</Link></Button>
              <Button asChild variant="outline"><Link href="/radiant-audit">Retake the Audit</Link></Button>
            </div>
            <section className="mt-10 border-t border-border pt-8">
              <h2 className="font-serif text-2xl">Remove your current Audit</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This is separate from clearing earlier history. Earlier submissions will remain saved, but none will become your current Audit.
              </p>
              <Button type="button" variant="outline" className="mt-4" onClick={() => { setDeleteError(null); setConfirmDeleteCurrent(true); }}>
                Delete current Audit
              </Button>
              {deleteError && <p className="mt-3 text-sm text-destructive" role="alert">{deleteError}</p>}
            </section>
          </>
        ) : (
          <>
            <h1 className="font-serif text-4xl">Start your Radiant Audit</h1>
            <p className="mt-4 text-muted-foreground">There isn't an Audit saved for this account yet.</p>
            <Button asChild className="mt-6"><Link href="/radiant-audit">Complete the Audit</Link></Button>
            {historyLoading ? (
              <p className="mt-8" role="status">Loading earlier Audits…</p>
            ) : historyError ? (
              <p className="mt-8 text-destructive" role="alert">We couldn't load your earlier Audits. Please refresh and try again.</p>
            ) : history?.length ? (
              <RadiantAuditComparison key={user?.id} accountId={user?.id ?? ""} latest={null} history={history} />
            ) : null}
          </>
        )}
        <AlertDialog open={confirmDeleteCurrent} onOpenChange={open => { if (!open && !deleteCurrent.isPending) setConfirmDeleteCurrent(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your current Audit?</AlertDialogTitle>
              <AlertDialogDescription>
                Your current Audit and its written reflections will be permanently deleted. This cannot be undone.
                Earlier Audits will stay in your history, but none will become your current Audit.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && <p className="text-sm text-destructive" role="alert">{deleteError}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteCurrent.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={deleteCurrent.isPending} onClick={event => { event.preventDefault(); void confirmCurrentDeletion(); }}>
                {deleteCurrent.isPending ? "Deleting…" : "Permanently delete current Audit"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </main>
    </div>
  );
}
