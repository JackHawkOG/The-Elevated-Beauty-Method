import React from 'react';
import { PageHeader } from './Shared';

export function ExecutiveSummary() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="Competitive Analysis"
        title="The Elevated Beauty Method"
        subtitle="Reference: Natalie Setareh • Makeup education & transformation • September 2026"
      />

      <section>
        <div className="flex items-center gap-4 mb-6">
          <h2 className="font-serif font-bold text-2xl text-primary">Executive summary</h2>
          <div className="h-0.5 w-16 bg-secondary"></div>
        </div>
        <p className="font-serif italic text-xl text-primary leading-relaxed max-w-4xl">
          For women who want practical beauty confidence and greater visibility, The Elevated Beauty Method is an ongoing beauty-transformation community that combines makeup mastery, personal presence, and age-positive education. Unlike one-off tutorials and courses, EBM supports the woman she is becoming—not just the look she is learning.
        </p>
      </section>

      <section className="bg-secondary text-primary rounded-xl p-8">
        <h3 className="font-sans font-bold text-sm tracking-widest uppercase mb-3">Bottom Line</h3>
        <p className="font-sans text-lg font-medium leading-relaxed">
          Borrow Natalie's specificity and proof—not her fragmented site structure. EBM can win by turning feature-specific makeup education into a guided, ongoing identity transformation.
        </p>
      </section>

      <section>
        <div className="flex items-center gap-4 mb-8">
          <h2 className="font-serif font-bold text-2xl text-primary">Three strategic moves</h2>
          <div className="h-0.5 w-16 bg-secondary"></div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white border border-border rounded-xl p-8 relative overflow-hidden">
            <div className="w-8 h-8 rounded-full bg-primary text-secondary flex items-center justify-center font-bold font-sans text-sm mb-6">1</div>
            <h4 className="font-serif font-bold text-xl text-primary mb-4 pr-4">Create a tangible first win</h4>
            <p className="font-sans text-muted-foreground leading-relaxed text-sm">
              Launch a free "Elevated Everyday Face" path: skin type → undertone → feature mapping → five-minute look → day-to-night. A concrete result converts better than a broad library promise.
            </p>
          </div>
          
          <div className="bg-white border border-border rounded-xl p-8 relative overflow-hidden">
            <div className="w-8 h-8 rounded-full bg-primary text-secondary flex items-center justify-center font-bold font-sans text-sm mb-6">2</div>
            <h4 className="font-serif font-bold text-xl text-primary mb-4 pr-4">Personalize the method</h4>
            <p className="font-sans text-muted-foreground leading-relaxed text-sm">
              Use a short onboarding diagnostic to identify skin type, undertone, eye shape, life stage, and visibility goal. Turn the answers into a recommended path called "Your Method."
            </p>
          </div>
          
          <div className="bg-white border border-border rounded-xl p-8 relative overflow-hidden">
            <div className="w-8 h-8 rounded-full bg-primary text-secondary flex items-center justify-center font-bold font-sans text-sm mb-6">3</div>
            <h4 className="font-serif font-bold text-xl text-primary mb-4 pr-4">Build proof into the product</h4>
            <p className="font-sans text-muted-foreground leading-relaxed text-sm">
              Replace generic social activity with named transformation stories, before/after learning outcomes, and role-specific testimonials from everyday women, founders, and women over 40.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-primary text-primary-foreground rounded-xl p-8 md:p-10">
        <h3 className="font-serif font-bold text-2xl text-secondary mb-4">Where EBM can own the category</h3>
        <p className="font-sans text-lg md:text-xl leading-relaxed">
          Premium beauty education for women in transition: practical enough to use tomorrow, emotionally resonant enough to change how they show up.
        </p>
      </section>
    </div>
  );
}
