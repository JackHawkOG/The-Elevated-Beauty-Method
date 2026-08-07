import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { BookType, ArrowRight, Library, Users, Sparkles } from "lucide-react";
import heroImage from "@assets/generated_images/hero-library.jpg";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      <nav className="h-20 border-b border-border/50 bg-background/80 backdrop-blur sticky top-0 z-50 px-6 md:px-12 flex items-center justify-between">
        <div className="flex items-center gap-3 text-primary">
          <BookType className="w-8 h-8" />
          <span className="font-serif text-2xl font-bold tracking-wide">EduPortal</span>
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
        <section className="relative min-h-[85vh] flex items-center px-6 md:px-12 lg:px-24 overflow-hidden">
          <div className="absolute inset-0 z-0">
             <img src={heroImage} alt="Library" className="w-full h-full object-cover opacity-20" />
             <div className="absolute inset-0 bg-gradient-to-r from-background via-background/80 to-transparent"></div>
             <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent"></div>
          </div>
          
          <div className="relative z-10 max-w-3xl animate-in fade-in slide-in-from-bottom-8 duration-1000">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-sm mb-6 font-medium">
              <Sparkles className="w-4 h-4" />
              <span>A welcoming community for lifelong learners</span>
            </div>
            <h1 className="font-serif text-5xl md:text-7xl lg:text-8xl font-bold text-foreground leading-[1.1] mb-6">
              The library that <br/><span className="text-primary italic">never locks</span> the door.
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl leading-relaxed">
              Step into a warm, focused space where curiosity thrives. Connect with experts, discover rich courses, and build your knowledge in a community that feels like home.
            </p>
            <div className="flex flex-col sm:flex-row items-start gap-4">
              <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 h-14 text-base shadow-[0_0_40px_-10px_rgba(255,236,194,0.3)]">
                <Link href="/sign-up">
                  Start Learning Now <ArrowRight className="ml-2 w-5 h-5" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full px-8 h-14 text-base border-border hover:bg-muted text-foreground">
                <Link href="/courses">Browse Library</Link>
              </Button>
            </div>
          </div>
        </section>
        
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center gap-12 lg:gap-24">
            <div className="w-full md:w-1/2 order-2 md:order-1 relative">
              <div className="aspect-square rounded-3xl overflow-hidden relative shadow-[0_0_50px_-15px_rgba(255,236,194,0.2)]">
                 <div className="absolute inset-0 bg-primary/10 mix-blend-overlay z-10"></div>
                 <img src={heroImage} alt="Focused learning" className="w-full h-full object-cover scale-110" style={{ filter: 'contrast(1.1) brightness(0.9)' }} />
              </div>
              <div className="absolute -bottom-6 -left-6 md:-left-12 bg-card border border-border p-6 rounded-2xl shadow-xl max-w-xs animate-in fade-in slide-in-from-bottom-8 delay-300">
                <div className="flex items-center gap-4 mb-2">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-serif font-bold text-xl">"</div>
                  <div className="text-sm font-medium">Community Member</div>
                </div>
                <p className="text-muted-foreground text-sm italic">"Finally, a place that respects my attention and offers real depth. No gamification, just pure learning."</p>
              </div>
            </div>
            
            <div className="w-full md:w-1/2 order-1 md:order-2 space-y-6">
              <h2 className="font-serif text-4xl md:text-5xl font-bold leading-tight">Learn at your own pace, on your own terms.</h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                We've stripped away the noise. No streaks to maintain, no badges to chase, no aggressive push notifications. Just you, the material, and a community of peers who care about the subject as much as you do.
              </p>
              <ul className="space-y-4 mt-8">
                {[
                  "Expert-led deep dives into fascinating subjects",
                  "A distraction-free, ad-free environment",
                  "Connect with professors and fellow students",
                  "Lifetime access to your enrolled courses"
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
        
        <section className="py-24 px-6 md:px-12 lg:px-24 bg-card/30 border-y border-border/50 relative">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Library className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">Curated Knowledge</h3>
                <p className="text-muted-foreground leading-relaxed">Explore a rich catalog of courses designed to illuminate, not just instruct. Deep dives into subjects that matter.</p>
              </div>
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Users className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">Shared Discovery</h3>
                <p className="text-muted-foreground leading-relaxed">Join a vibrant community of thinkers, creators, and professionals. Ask questions, share insights, and grow together.</p>
              </div>
              <div className="flex flex-col items-start space-y-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-2 border border-primary/20 shadow-[0_0_20px_-5px_rgba(255,236,194,0.2)]">
                  <Sparkles className="w-6 h-6" />
                </div>
                <h3 className="text-2xl font-serif font-bold text-foreground">Warm Environment</h3>
                <p className="text-muted-foreground leading-relaxed">A digital space designed for focus and calm. No aggressive notifications, just a quiet room for your mind to expand.</p>
              </div>
            </div>
          </div>
        </section>
        
        <section className="py-24 px-6 md:px-12 lg:px-24">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="font-serif text-4xl md:text-5xl font-bold mb-6">Ready to take a seat?</h2>
            <p className="text-muted-foreground text-lg mb-10">Sign up in seconds. It's completely free to join the community.</p>
            <Button asChild size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-12 h-14 text-lg shadow-[0_0_40px_-10px_rgba(255,236,194,0.3)]">
              <Link href="/sign-up">Create Free Account</Link>
            </Button>
          </div>
        </section>
      </main>
      
      <footer className="py-12 px-6 md:px-12 lg:px-24 bg-card/50 border-t border-border flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <BookType className="w-5 h-5 text-primary" />
          <span className="font-serif font-bold text-foreground">EduPortal</span>
        </div>
        <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} EduPortal. A place for curious minds.</p>
      </footer>
    </div>
  );
}