import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight, Crown, Eye, Star } from "lucide-react";
import heroImage from "@assets/generated_images/hero-library.jpg";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <nav className="h-20 border-b border-border/50 bg-background/80 backdrop-blur sticky top-0 z-50 px-6 md:px-12 flex items-center justify-between">
        <div className="flex items-center gap-3 text-primary">
          <Sparkles className="w-6 h-6" />
          <span className="font-serif text-xl font-bold tracking-wide leading-tight">The Elevated Beauty Method</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-muted-foreground hover:text-primary transition-colors text-sm font-medium">
            Sign In
          </Link>
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium rounded-full px-6">
            <Link href="/sign-up">Join Free</Link>
          </Button>
        </div>
      </nav>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative min-h-[85vh] flex items-center px-6 md:px-12 lg:px-24 overflow-hidden">
          <div className="absolute inset-0 z-0">
            <img src={heroImage} alt="Elevated Beauty" className="w-full h-full object-cover opacity-20" />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/80 to-transparent"></div>
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent"></div>
          </div>

          <div className="relative z-10 max-w-3xl animate-in fade-in slide-in-from-bottom-8 duration-1000">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-sm mb-6 font-medium">
              <Crown className="w-4 h-4" />
              <span>A community for women ready to be seen</span>
            </div>
            <h1 className="font-serif text-5xl md:text-7xl lg:text-8xl font-bold text-foreground leading-[1.1] mb-6">
              Step into your most <span className="text-primary italic">elevated</span> self.
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl leading-relaxed">
              Beauty enhances appearance. Confidence strengthens presence. Transformation changes how you see yourself — and that's power. Join Nikki and a community of women who are ready to become the most confident, visible version of themselves.
            </p>
            <div className="flex flex-col sm:flex-row items-start gap-4">
              <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 h-14 text-base shadow-[0_0_40px_-10px_rgba(255,236,194,0.3)]">
                <Link href="/sign-up">
                  Join Free <ArrowRight className="ml-2 w-5 h-5" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full px-8 h-14 text-base border-border hover:bg-muted text-foreground">
                <Link href="/courses">Explore the Method</Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Who it's for */}
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center gap-12 lg:gap-24">
            <div className="w-full md:w-1/2 order-2 md:order-1 relative">
              <div className="aspect-square rounded-3xl overflow-hidden relative shadow-[0_0_50px_-15px_rgba(255,236,194,0.2)]">
                <div className="absolute inset-0 bg-primary/10 mix-blend-overlay z-10"></div>
                <img src={heroImage} alt="Elevated woman" className="w-full h-full object-cover scale-110" style={{ filter: 'contrast(1.1) brightness(0.9)' }} />
              </div>
              <div className="absolute -bottom-6 -left-6 md:-left-12 bg-card border border-border p-6 rounded-2xl shadow-xl max-w-xs animate-in fade-in slide-in-from-bottom-8 delay-300">
                <div className="flex items-center gap-4 mb-2">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-serif font-bold text-xl">"</div>
                  <div className="text-sm font-medium">Community Member</div>
                </div>
                <p className="text-muted-foreground text-sm italic">"I want to feel like myself, just elevated. This community gave me exactly that."</p>
              </div>
            </div>

            <div className="w-full md:w-1/2 order-1 md:order-2 space-y-6">
              <h2 className="font-serif text-4xl md:text-5xl font-bold leading-tight">This is for the woman who is ready to be seen.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Whether you're learning makeup for the first time, stepping into your personal brand, or navigating a reinvention — The Elevated Beauty Method meets you exactly where you are.
              </p>
              <ul className="space-y-4 mt-8">
                {[
                  "Women who want to master their own makeup & hair",
                  "Entrepreneurs stepping into visibility & personal brand",
                  "Women reinventing themselves after divorce, career change, or midlife",
                  "Aspiring beauty professionals building a business",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <div className="mt-1 shrink-0 w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                      <Sparkles className="w-3 h-3" />
                    </div>
                    <span className="text-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Three pillars */}
        <section className="py-24 px-6 md:px-12 lg:px-24 bg-card/30 border-y border-border/50 relative">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Sparkles className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">The Method</h3>
                <p className="text-muted-foreground leading-relaxed">A signature, repeatable process for beauty mastery — mini courses, workshops, and digital guides designed to build real skill and lasting confidence.</p>
              </div>
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Crown className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">The Community</h3>
                <p className="text-muted-foreground leading-relaxed">Join women who value quality over quantity and expertise over trends. A warm space where every question is a good one and every woman belongs.</p>
              </div>
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Eye className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">The Transformation</h3>
                <p className="text-muted-foreground leading-relaxed">Change on the outside unlocks change on the inside. When you sit with Nikki's method, something shifts — and that's the point.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Membership tiers */}
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4">Choose your level</h2>
              <p className="text-muted-foreground text-lg">Start free. Elevate when you're ready.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Tier 1 */}
              <div className="rounded-2xl border border-border bg-card/50 p-8 flex flex-col">
                <div className="mb-6">
                  <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-2">Free</div>
                  <h3 className="font-serif text-2xl font-bold mb-1">The Beauty Method</h3>
                  <div className="text-4xl font-serif font-bold text-primary mt-4">$0</div>
                </div>
                <ul className="space-y-3 text-sm text-muted-foreground flex-1 mb-8">
                  {["Public community forum", "Free mini-courses", "Free digital guides", "Access to free education"].map(f => (
                    <li key={f} className="flex items-center gap-2"><Star className="w-3.5 h-3.5 text-primary shrink-0" />{f}</li>
                  ))}
                </ul>
                <Button asChild className="w-full rounded-full bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20">
                  <Link href="/sign-up">Join Free</Link>
                </Button>
              </div>

              {/* Tier 2 */}
              <div className="rounded-2xl border border-primary/40 bg-card/80 p-8 flex flex-col relative shadow-[0_0_40px_-15px_rgba(255,236,194,0.2)]">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1 rounded-full">Popular</div>
                <div className="mb-6">
                  <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-2">Monthly</div>
                  <h3 className="font-serif text-2xl font-bold mb-1">The Elevated Method</h3>
                  <div className="text-4xl font-serif font-bold text-primary mt-4">$29<span className="text-lg font-normal text-muted-foreground">/mo</span></div>
                </div>
                <ul className="space-y-3 text-sm text-muted-foreground flex-1 mb-8">
                  {["Everything in The Beauty Method", "Paid education courses", "Tiered-level workshops", "Education offers & events"].map(f => (
                    <li key={f} className="flex items-center gap-2"><Star className="w-3.5 h-3.5 text-primary shrink-0" />{f}</li>
                  ))}
                </ul>
                <Button asChild className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_-5px_rgba(255,236,194,0.3)]">
                  <Link href="/sign-up">Get Started</Link>
                </Button>
              </div>

              {/* Tier 3 */}
              <div className="rounded-2xl border border-border bg-card/50 p-8 flex flex-col">
                <div className="mb-6">
                  <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-2">Premium</div>
                  <h3 className="font-serif text-2xl font-bold mb-1">The Elevated Beauty Method</h3>
                  <div className="text-4xl font-serif font-bold text-primary mt-4">$49<span className="text-lg font-normal text-muted-foreground">/mo</span></div>
                  <div className="text-xs text-muted-foreground mt-1">+ $1,500 one-time Masterclass access</div>
                </div>
                <ul className="space-y-3 text-sm text-muted-foreground flex-1 mb-8">
                  {["Everything in The Elevated Method", "Exclusive Masterclasses with Nikki", "Priority access to new content", "Premium community access"].map(f => (
                    <li key={f} className="flex items-center gap-2"><Star className="w-3.5 h-3.5 text-primary shrink-0" />{f}</li>
                  ))}
                </ul>
                <Button asChild className="w-full rounded-full bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20">
                  <Link href="/sign-up">Apply Now</Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-24 px-6 md:px-12 lg:px-24 bg-card/30 border-t border-border/50">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="font-serif text-4xl md:text-5xl font-bold mb-6">The next level starts here.</h2>
            <p className="text-muted-foreground text-lg mb-10">Sign up in seconds. The Beauty Method tier is completely free — always.</p>
            <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-12 h-14 text-lg shadow-[0_0_40px_-10px_rgba(255,236,194,0.3)]">
              <Link href="/sign-up">Create Free Account</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="py-12 px-6 md:px-12 lg:px-24 bg-card/50 border-t border-border flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Sparkles className="w-5 h-5 text-primary" />
          <span className="font-serif font-bold text-foreground">The Elevated Beauty Method</span>
        </div>
        <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} The Elevated Beauty Method™ by Blushing Beauty By Nikki.</p>
      </footer>
    </div>
  );
}
