import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight, Crown, Eye, Star, CheckCircle2 } from "lucide-react";
import heroImage from "@assets/generated_images/hero-beauty.jpg";
import diagnosticImage from "@assets/generated_images/diagnostic-preview.jpg";
import everydayFaceImage from "@assets/generated_images/everyday-face.jpg";
import masterLogo from "@assets/TEBM_-_Master_Logo_-_Website_2000x2000.png_1789590910265.png";
import masterMonogram from "@assets/generated_images/tebm-master-monogram.png";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <nav className="relative min-h-[42rem] border-b border-border/50 bg-background/90 px-6 py-8 backdrop-blur md:min-h-[54rem] md:px-12">
        <Link
          href="/"
          aria-label="The Elevated Beauty Method home"
          className="mx-auto flex w-fit flex-col items-center justify-center text-center"
        >
          <img
            src={masterMonogram}
            alt="The Elevated Beauty Method"
            className="h-40 w-auto object-contain drop-shadow-[0_8px_28px_rgba(220,206,191,0.22)] md:h-[17.5rem]"
          />
          <h1 className="metallic-logo-text mt-12 max-w-[95vw] font-serif text-[7.5rem] font-semibold leading-[0.84] tracking-[0.02em] md:mt-16 md:text-[11.25rem]">
            The Elevated Beauty Method
          </h1>
        </Link>
        <div className="absolute right-4 top-4 flex items-center gap-3 md:right-12 md:top-8 md:gap-4">
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
            <img src={heroImage} alt="Elevated Beauty" className="w-full h-full object-cover opacity-30" />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-transparent"></div>
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
              Beauty enhances appearance. Confidence strengthens presence. Transformation changes how you see yourself. Join a community of women who are ready to become the most confident, visible version of themselves.
            </p>
            <div className="flex flex-col sm:flex-row items-start gap-4">
              <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 h-14 text-base shadow-[0_0_40px_-10px_rgba(255,224,153,0.3)]">
                <Link href="/sign-up">
                  Discover Your Method <ArrowRight className="ml-2 w-5 h-5" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full px-8 h-14 text-base border-border hover:bg-muted text-foreground">
                <Link href="/courses">Explore the Library</Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Personalized Diagnostic Preview */}
        <section className="py-24 px-6 md:px-12 lg:px-24 bg-card/30 border-y border-border/50 relative overflow-hidden">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center gap-12 lg:gap-24">
            <div className="w-full md:w-1/2 space-y-6 z-10">
              <div className="inline-flex items-center gap-2 text-primary font-medium text-sm tracking-widest uppercase mb-2">
                <Sparkles className="w-4 h-4" /> Step One
              </div>
              <h2 className="font-serif text-4xl md:text-5xl font-bold leading-tight">Your Personal Beauty Diagnostic</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Beauty is not one-size-fits-all. When you join, your first step is a personalized diagnostic covering your skin type, undertone, lifestyle, and visibility goals.
              </p>
              <p className="text-lg text-muted-foreground leading-relaxed">
                We use this to build <span className="text-foreground font-medium">Your Method</span> — a custom pathway of education tailored exactly to what you need right now.
              </p>
              <Button asChild variant="outline" className="rounded-full px-8 h-12 mt-4 border-primary/30 text-primary hover:bg-primary/10">
                <Link href="/sign-up">Take the Diagnostic</Link>
              </Button>
            </div>

            <div className="w-full md:w-1/2 relative">
              <div className="aspect-[4/3] rounded-3xl overflow-hidden relative shadow-[0_0_50px_-15px_rgba(255,224,153,0.15)]">
                <img src={diagnosticImage} alt="Beauty Diagnostic" className="w-full h-full object-cover" />
              </div>
              {/* Floating UI Elements simulating the diagnostic */}
              <div className="absolute -bottom-8 -left-8 bg-background border border-border p-5 rounded-2xl shadow-2xl max-w-[280px] animate-in fade-in slide-in-from-bottom-8 delay-300">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Your Method</div>
                <h4 className="font-serif font-bold text-lg mb-2">The Executive Presence</h4>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><CheckCircle2 className="w-4 h-4 text-primary" /> Cool Undertone</div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1"><CheckCircle2 className="w-4 h-4 text-primary" /> Camera Ready</div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="w-4 h-4 text-primary" /> Complexion Focus</div>
              </div>
            </div>
          </div>
        </section>

        {/* The Free First Win */}
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row-reverse items-center gap-12 lg:gap-24">
            <div className="w-full md:w-1/2 space-y-6">
              <div className="inline-flex items-center gap-2 text-primary font-medium text-sm tracking-widest uppercase mb-2">
                <Crown className="w-4 h-4" /> First Win
              </div>
              <h2 className="font-serif text-4xl md:text-5xl font-bold leading-tight">The Elevated Everyday Face</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Start with a quick win. Every member receives our foundational 5-part video series completely free. Learn the core principles of the Elevated Beauty Method to look polished and put-together in under 10 minutes.
              </p>
              <ul className="space-y-4 mt-6">
                {[
                  "Skin prep that actually lasts",
                  "Finding your perfect base",
                  "Strategic concealing",
                  "Adding life back with color",
                  "Setting for all-day wear",
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <div className="shrink-0 w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                      <span className="text-xs font-bold">{i + 1}</span>
                    </div>
                    <span className="text-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="w-full md:w-1/2 relative">
              <div className="aspect-square md:aspect-[4/5] rounded-3xl overflow-hidden relative shadow-[0_0_50px_-15px_rgba(255,224,153,0.15)]">
                <img src={everydayFaceImage} alt="The Elevated Everyday Face" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent"></div>
                <div className="absolute bottom-8 left-8 right-8">
                  <div className="bg-background/40 backdrop-blur-md border border-white/10 rounded-2xl p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-primary text-sm font-medium mb-1">Included in Free Tier</div>
                        <div className="font-serif text-xl font-bold text-white">5 Video Lessons</div>
                      </div>
                      <Button size="icon" className="rounded-full bg-white text-black hover:bg-white/90">
                        <ArrowRight className="w-5 h-5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Transformation Proof */}
        <section className="py-24 px-6 md:px-12 lg:px-24 bg-card/50 border-y border-border/50">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16">
              <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4">The Transformation</h2>
              <p className="text-muted-foreground text-lg max-w-2xl mx-auto">Change on the outside unlocks change on the inside. Hear from women who stepped into their visibility.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {[
                {
                  quote: "I used to hide behind the camera in Zoom meetings. The Elevated Method gave me the practical tools to show up confidently. Now, I lead with my camera on, every time.",
                  author: "Sarah J.",
                  role: "Executive Director"
                },
                {
                  quote: "After my divorce, I didn't recognize myself in the mirror. This community wasn't just about makeup; it was about reclaiming my identity and learning to love who I saw.",
                  author: "Elena M.",
                  role: "Reclaiming Her Time"
                },
                {
                  quote: "Building a personal brand felt overwhelming until I learned how to create a consistent, camera-ready look. The ROI on this investment paid for itself in my first launch.",
                  author: "Jessica T.",
                  role: "Founder & Coach"
                }
              ].map((testimonial, i) => (
                <div key={i} className="bg-background border border-border p-8 rounded-2xl shadow-lg relative">
                  <div className="absolute -top-4 -left-2 text-6xl text-primary/20 font-serif leading-none">"</div>
                  <p className="text-muted-foreground leading-relaxed italic mb-6 relative z-10">
                    {testimonial.quote}
                  </p>
                  <div className="border-t border-border/50 pt-4">
                    <div className="font-serif font-bold text-foreground text-lg">{testimonial.author}</div>
                    <div className="text-primary text-sm">{testimonial.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Membership tiers */}
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-6xl mx-auto">
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
                  <div className="text-4xl font-serif font-bold text-foreground mt-4">$0</div>
                </div>
                <ul className="space-y-4 text-sm text-muted-foreground flex-1 mb-8">
                  {[
                    "Personalized Beauty Diagnostic",
                    "The Elevated Everyday Face (5 lessons)",
                    "Public community forum",
                    "Curated free digital guides"
                  ].map(f => (
                    <li key={f} className="flex items-start gap-3">
                      <Star className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="w-full rounded-full bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20">
                  <Link href="/sign-up">Join Free</Link>
                </Button>
              </div>

              {/* Tier 2 */}
              <div className="rounded-2xl border border-primary/40 bg-card/80 p-8 flex flex-col relative shadow-[0_0_40px_-15px_rgba(255,224,153,0.15)]">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-bold tracking-wider uppercase px-4 py-1 rounded-full">Popular</div>
                <div className="mb-6">
                  <div className="text-xs font-semibold tracking-widest text-primary uppercase mb-2">Monthly</div>
                  <h3 className="font-serif text-2xl font-bold mb-1">The Elevated Method</h3>
                  <div className="text-4xl font-serif font-bold text-primary mt-4">$29<span className="text-lg font-normal text-muted-foreground">/mo</span></div>
                </div>
                <ul className="space-y-4 text-sm text-muted-foreground flex-1 mb-8">
                  {[
                    "Everything in The Beauty Method",
                    "Full access to all Elevated courses",
                    "Tiered-level monthly workshops",
                    "Exclusive education offers & events"
                  ].map(f => (
                    <li key={f} className="flex items-start gap-3">
                      <Star className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_-5px_rgba(255,224,153,0.3)]">
                  <Link href="/sign-up">Get Started</Link>
                </Button>
              </div>

              {/* Tier 3 */}
              <div className="rounded-2xl border border-border bg-card/50 p-8 flex flex-col">
                <div className="mb-6">
                  <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-2">Premium</div>
                  <h3 className="font-serif text-2xl font-bold mb-1">The Elevated Beauty Method</h3>
                  <div className="text-4xl font-serif font-bold text-foreground mt-4">$49<span className="text-lg font-normal text-muted-foreground">/mo</span></div>
                  <div className="text-xs text-muted-foreground mt-2">+ $1,500 one-time Masterclass access</div>
                </div>
                <ul className="space-y-4 text-sm text-muted-foreground flex-1 mb-8">
                  {[
                    "Everything in The Elevated Method",
                    "Exclusive Masterclasses with Nikki",
                    "Priority access to new content",
                    "Premium inner-circle community access"
                  ].map(f => (
                    <li key={f} className="flex items-start gap-3">
                      <Star className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
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
            <p className="text-muted-foreground text-lg mb-10">Sign up in seconds. Discover Your Method completely free.</p>
            <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-12 h-14 text-lg shadow-[0_0_40px_-10px_rgba(255,224,153,0.3)]">
              <Link href="/sign-up">Create Free Account</Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="py-12 px-6 md:px-12 lg:px-24 bg-card/50 border-t border-border flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center text-muted-foreground">
          <img
            src={masterLogo}
            alt="The Elevated Beauty Method"
            className="h-24 w-auto rounded-xl object-contain shadow-[0_8px_32px_-12px_rgba(255,236,194,0.25)]"
          />
        </div>
        <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} The Elevated Beauty Method™ by Blushing Beauty By Nikki.</p>
      </footer>
    </div>
  );
}
