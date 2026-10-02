import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useGetRoutineGuide, getGetRoutineGuideQueryKey, useClaimRoutineGuide } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { guideTheme } from "@/lib/guide-theme";
import { useGuidePageMeta } from "@/lib/guide-page-meta";

const masterLogo = `${import.meta.env.BASE_URL}brand/tebm-master-logo-1920x1080.png`;
const CONSENT_FALLBACK = "Email me The Elevated Routine from The Elevated Beauty Method ™.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorMessage(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 400) return "That request was not accepted. Check your email address and the consent box, then try again. Nothing was sent.";
  if (status === 409) return "This request conflicts with an earlier one, so we did not send it. Please check your email address and try again.";
  if (status === 429) return "There have been too many requests. Please wait a little while, then try again. Nothing was confirmed.";
  if (status === 503) return "Delivery is not available right now. Nothing was confirmed. Please try again later.";
  return "We could not confirm whether this request went through. You can try again; we will reuse the same request so you are not sent duplicates.";
}

export default function ElevatedRoutinePage() {
  useGuidePageMeta("The Elevated Routine | Free guide by Dominique | The Elevated Beauty Method ™", "Request The Elevated Routine, a nine-page guide by Dominique, by email. We use your address only to send this PDF. No marketing subscription, no account needed.");
  const guide = useGetRoutineGuide({ query: { queryKey: getGetRoutineGuideQueryKey(), retry: false } });
  const claim = useClaimRoutineGuide();
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [touched, setTouched] = useState(false);
  const idRef = useRef<{ key: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const info = guide.data;
  const consentText = info?.consentText ?? CONSENT_FALLBACK;
  const trimmed = email.trim();
  const emailError = !trimmed ? "Enter your email address." : trimmed.length > 254 || !EMAIL_RE.test(trimmed) ? "Enter a valid email address." : null;
  const consentError = !consent ? "Tick the box to confirm you want this email." : null;
  const result = claim.data;
  const failed = claim.isError;

  useEffect(() => { if (result || failed) statusRef.current?.focus(); }, [result, failed]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!info?.available || emailError || consentError || inFlight.current || claim.isPending) return;
    const key = trimmed.toLowerCase() + "|" + website;
    if (!idRef.current || idRef.current.key !== key) idRef.current = { key, id: crypto.randomUUID() };
    inFlight.current = true;
    claim.mutate({ data: { email: trimmed, consent: true, requestId: idRef.current.id, website } }, { onSettled: () => { inFlight.current = false; } });
  }

  const sent = result?.status === "sent";
  const processing = result?.status === "processing";

  return (
    <div className="min-h-[100dvh] bg-background text-foreground" style={guideTheme}>
      <style>{`@keyframes er-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}.er-rise{animation:er-rise .7s cubic-bezier(.2,.7,.2,1) both}@media (prefers-reduced-motion:reduce){.er-rise{animation:none}}`}</style>
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.10),transparent_65%)]" />
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" aria-label="The Elevated Beauty Method ™ home" className="block w-36"><img src={masterLogo} alt="The Elevated Beauty Method ™" className="h-auto w-full" /></Link>
        <Link href="/guide-privacy" className="text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-primary">Guide privacy</Link>
      </header>
      <main className="relative mx-auto grid max-w-6xl gap-12 px-6 pb-24 pt-8 lg:grid-cols-[1.05fr_1fr] lg:gap-20 lg:pt-16">
        <section className="er-rise">
          <p className="text-xs uppercase tracking-[0.3em] text-primary/80">A guide by Dominique</p>
          <h1 className="mt-5 font-serif text-5xl leading-[1.02] sm:text-6xl lg:text-7xl" data-testid="text-guide-title">{info?.title ?? "The Elevated Routine"}</h1>
          <p className="mt-6 max-w-md text-lg text-muted-foreground">A personal routine begins with your features and your life. This nine-page guide is where Dominique starts.</p>
          <dl className="mt-10 max-w-md divide-y divide-border border-y border-border text-sm">
            {[["What you get", "One PDF, sent by email"], ["Length", `${info?.pageCount ?? 9} pages`], ["What we do with your email", "Send this guide. Nothing else"], ["Account", "Not required"]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-6 py-3"><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></div>
            ))}
          </dl>
        </section>

        <section className="er-rise [animation-delay:120ms]">
          <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_30px_80px_-40px_hsl(var(--primary)/0.25)] sm:p-9">
            {guide.isPending ? (
              <div className="space-y-4" aria-busy="true" data-testid="status-guide-loading">
                <div className="h-6 w-2/3 animate-pulse rounded bg-muted" /><div className="h-12 animate-pulse rounded-full bg-muted" /><div className="h-20 animate-pulse rounded-2xl bg-muted" /><div className="h-12 animate-pulse rounded-full bg-muted" />
              </div>
            ) : guide.isError ? (
              <div role="alert" data-testid="status-guide-error">
                <h2 className="font-serif text-2xl">We could not load this request form</h2>
                <p className="mt-3 text-sm text-muted-foreground">Nothing has been sent. Check your connection and try again.</p>
                <Button className="mt-5 rounded-full" variant="outline" onClick={() => void guide.refetch()} data-testid="button-retry-guide">Try again</Button>
              </div>
            ) : !info?.available ? (
              <div data-testid="status-guide-unavailable">
                <h2 className="font-serif text-2xl">Not available to request yet</h2>
                <p className="mt-3 text-sm text-muted-foreground">The Elevated Routine is not being delivered at the moment, and we are not collecting email addresses for it. Please check back later.</p>
              </div>
            ) : sent || processing ? (
              <div ref={statusRef} tabIndex={-1} role="status" className="outline-none" data-testid={sent ? "status-sent" : "status-processing"}>
                <h2 className="font-serif text-3xl">{sent ? "Your request was accepted" : "Your request is still processing"}</h2>
                <p className="mt-4 text-sm">{result.message}</p>
                {sent && <p className="mt-3 text-sm text-muted-foreground">Our email provider has accepted the message for delivery. That is not a guarantee it has reached your Inbox, so please also check Spam or Promotions. If it does not arrive, contact hello@elevatedbeautymethod.com.</p>}
                {processing && <>
                  <p className="mt-3 text-sm text-muted-foreground">We will not retry on our own. If you would like to check again, do so below; the same request is reused so you are not sent duplicates.</p>
                  <Button className="mt-5 rounded-full" variant="outline" onClick={() => {
                    if (!idRef.current || inFlight.current || claim.isPending) return;
                    inFlight.current = true;
                    claim.mutate({ data: { email: trimmed, consent: true, requestId: idRef.current.id, website } },
                      { onSettled: () => { inFlight.current = false; } });
                  }} disabled={claim.isPending} data-testid="button-retry-processing">{claim.isPending ? "Checking…" : "Check again"}</Button>
                </>}
              </div>
            ) : (
              <form onSubmit={submit} noValidate aria-describedby="guide-privacy-summary">
                <h2 className="font-serif text-3xl">Request the guide</h2>
                <div id="guide-privacy-summary" className="mt-4 rounded-2xl border border-border bg-background/60 p-4 text-sm" data-testid="text-privacy-notice">
                  <p className="text-xs uppercase tracking-[0.2em] text-primary/80">Before you submit</p>
                  <p className="mt-2 whitespace-pre-line text-muted-foreground">{info?.privacyNotice}</p>
                  <Link href="/guide-privacy" className="mt-2 inline-block underline underline-offset-4 hover:text-primary">Read the full guide privacy page</Link>
                </div>
                <label htmlFor="guide-email" className="mt-6 block text-sm text-muted-foreground">Email address</label>
                <input id="guide-email" data-testid="input-email" type="email" inputMode="email" autoComplete="off" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && !!emailError} aria-describedby={touched && emailError ? "guide-email-err" : undefined} disabled={claim.isPending}
                  className="mt-2 w-full rounded-full border border-border bg-background px-5 py-3 text-base outline-none transition-colors placeholder:text-muted-foreground/50 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40" placeholder="you@example.com" />
                {touched && emailError && <p id="guide-email-err" className="mt-2 text-sm text-red-300" data-testid="error-email">{emailError}</p>}
                <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label></div>
                <div className="mt-6 flex items-start gap-3">
                  <input id="guide-consent" data-testid="checkbox-consent" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={claim.isPending} aria-invalid={touched && !!consentError} aria-describedby={touched && consentError ? "guide-consent-err" : undefined} className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-[hsl(var(--primary))]" />
                  <label htmlFor="guide-consent" className="cursor-pointer text-sm leading-relaxed">{consentText}</label>
                </div>
                {touched && consentError && <p id="guide-consent-err" className="mt-2 text-sm text-red-300" data-testid="error-consent">{consentError}</p>}
                {failed && (
                  <div ref={statusRef} tabIndex={-1} role="alert" className="mt-6 rounded-2xl border border-red-400/30 bg-red-950/30 p-4 text-sm outline-none" data-testid="status-claim-error">
                    {errorMessage(claim.error)}
                  </div>
                )}
                <Button type="submit" disabled={claim.isPending} className="mt-7 h-12 w-full rounded-full text-base transition-transform active:scale-[0.99]" data-testid="button-submit">
                  {claim.isPending ? "Sending request…" : failed ? "Try again" : "Send me the guide"}
                </Button>
                <p className="mt-3 text-center text-xs text-muted-foreground">Nothing is sent until you press the button. No marketing emails.</p>
              </form>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
