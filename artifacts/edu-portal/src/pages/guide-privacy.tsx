import { Link } from "wouter";
import { useGetRoutineGuide, getGetRoutineGuideQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { guideTheme } from "@/lib/guide-theme";
import { useGuidePageMeta } from "@/lib/guide-page-meta";

export default function GuidePrivacyPage() {
  useGuidePageMeta("The Elevated Routine privacy | The Elevated Beauty Method ™", "How The Elevated Beauty Method ™ handles your email when you request The Elevated Routine guide: what we keep, who processes it, and how to ask for removal.");
  const guide = useGetRoutineGuide({ query: { queryKey: getGetRoutineGuideQueryKey(), retry: false } });
  return (
    <div className="min-h-[100dvh] bg-background text-foreground" style={guideTheme}>
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Link href="/the-elevated-routine" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary">Back to the guide request</Link>
        <p className="mt-10 text-xs uppercase tracking-[0.3em] text-primary/80">The Elevated Routine only</p>
        <h1 className="mt-4 font-serif text-5xl">Guide privacy</h1>
        <p className="mt-5 text-muted-foreground">This page covers only the request form for The Elevated Routine. It does not describe any other part of the site.</p>
        <section className="mt-10 rounded-3xl border border-border bg-card p-6 sm:p-8" aria-live="polite" data-testid="text-privacy-notice">
          <h2 className="font-serif text-2xl">The notice, as published</h2>
          {guide.isPending ? <div className="mt-4 space-y-3" aria-busy="true"><div className="h-4 animate-pulse rounded bg-muted" /><div className="h-4 w-5/6 animate-pulse rounded bg-muted" /><div className="h-4 w-2/3 animate-pulse rounded bg-muted" /></div>
            : guide.isError ? <div role="alert" className="mt-4 text-sm">We could not load the privacy notice. <Button variant="outline" className="ml-2 rounded-full" onClick={() => void guide.refetch()} data-testid="button-retry-privacy">Try again</Button></div>
            : <p className="mt-4 whitespace-pre-line text-muted-foreground">{guide.data.privacyNotice}</p>}
        </section>
        <section className="mt-10 space-y-6">
          <h2 className="font-serif text-2xl">In plain terms</h2>
          <ul className="space-y-4 text-sm text-muted-foreground">
            <li><span className="text-foreground">Records kept.</span> Your email address, your consent, and delivery and retry records for this request.</li>
            <li><span className="text-foreground">Processing.</span> Resend processes the email that carries the guide.</li>
            <li><span className="text-foreground">No marketing.</span> Requesting the guide does not subscribe you to marketing.</li>
            <li><span className="text-foreground">Removal.</span> To ask for removal, write to <a className="text-primary underline underline-offset-4" href="mailto:hello@elevatedbeautymethod.com">hello@elevatedbeautymethod.com</a>.</li>
            <li><span className="text-foreground">Scope of removal.</span> We can remove this address’s guide-only consent, delivery/retry records, and hashed email request counters from this site. Shared hashed IP abuse-prevention counters expire separately. This does not delete your account, membership, billing records, Audit answers, or other site data.</li>
            <li><span className="text-foreground">Separate provider records.</span> Resend may retain email and delivery records under its own retention policies. Removing our records does not erase Resend’s records or recall an email already sent or being processed. Contact us about provider-held records; we do not promise they have been deleted when local removal is complete.</li>
            <li><span className="text-foreground">No automatic resend.</span> Removal does not send another email. A later new guide request with explicit consent may create new records.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
