import { Link } from "wouter";
import { BookOpen } from "lucide-react";
import { useListDigitalGuides, getListDigitalGuidesQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { guideTheme } from "@/lib/guide-theme";
import { useGuidePageMeta } from "@/lib/guide-page-meta";

export default function GuidesPage() {
  useGuidePageMeta("Curated Digital Guides | The Elevated Beauty Method ™", "Free approved guides from The Elevated Beauty Method ™.");
  const guides = useListDigitalGuides({ query: { queryKey: getListDigitalGuidesQueryKey(), staleTime: 0, refetchOnMount: "always" } });
  return <AppLayout>
    <main className="mx-auto w-full max-w-4xl space-y-8 px-6 py-12" style={guideTheme}>
      <div>
        <p className="text-xs uppercase tracking-[0.3em] text-primary/80">Free for members</p>
        <h1 className="mt-3 font-serif text-4xl sm:text-5xl">Curated Digital Guides</h1>
        <p className="mt-3 max-w-xl text-muted-foreground">Guides we have reviewed and approved for you.</p>
      </div>
      {guides.isPending ? <div className="grid gap-4" aria-busy="true"><div className="h-28 animate-pulse rounded-2xl bg-muted" /><div className="h-28 animate-pulse rounded-2xl bg-muted" /></div>
        : guides.isError ? <div role="alert" className="rounded-2xl border border-border bg-card p-6">Could not load the guides. <Button variant="outline" className="ml-2 rounded-full" onClick={() => void guides.refetch()} data-testid="button-retry-guides">Retry</Button></div>
        : !guides.data.length ? <div className="rounded-3xl border border-dashed border-border bg-card/50 p-10 text-center" data-testid="status-guides-empty">
            <BookOpen className="mx-auto h-8 w-8 text-primary/70" aria-hidden />
            <h2 className="mt-4 font-serif text-2xl">No guides are published yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">Guides appear here only once they are approved and ready to deliver. Nothing is missing from your account.</p>
          </div>
        : <ul className="grid gap-4">{guides.data.map(g => <li key={g.version + g.title} className="rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40" data-testid={`card-guide-${g.version}`}>
            <h2 className="font-serif text-2xl">{g.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{g.pageCount} pages</p>
            <Link href="/the-elevated-routine" className="mt-4 inline-block text-sm text-primary underline underline-offset-4">Request by email</Link>
          </li>)}</ul>}
    </main>
  </AppLayout>;
}
