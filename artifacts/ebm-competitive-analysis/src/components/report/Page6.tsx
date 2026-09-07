import React from 'react';
import { PageHeader, SectionTitle, Bullet } from './Shared';

export function ActionPlan() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="05 / Action"
        title="90-day action plan"
        subtitle="Sequence matters: prove a first transformation before expanding the catalog."
      />

      <section className="flex flex-col gap-6">
        {/* Phase 1 */}
        <div className="flex flex-col md:flex-row bg-white rounded-xl border border-border overflow-hidden shadow-sm">
          <div className="bg-secondary text-primary p-8 md:w-56 flex flex-col items-center justify-center shrink-0 border-b md:border-b-0 md:border-r border-border">
            <span className="font-sans font-bold text-xs tracking-[0.2em] uppercase mb-4 text-center">Days 1–30</span>
            <span className="font-serif font-bold text-6xl text-center">01</span>
          </div>
          <div className="p-8 flex flex-col justify-center">
            <h3 className="font-serif font-bold text-2xl text-primary mb-4">Build the "Start Here" conversion path</h3>
            <p className="font-sans text-muted-foreground text-base leading-relaxed mb-6">
              Add a five-question beauty diagnostic and a free five-part Elevated Everyday Face pathway. Show the exact lesson sequence before sign-up. End with one concrete deliverable: a repeatable 10-minute look.
            </p>
            <p className="font-sans font-bold text-chart-3 text-sm tracking-wide">
              Primary metric: diagnostic completion → free membership conversion
            </p>
          </div>
        </div>

        {/* Phase 2 */}
        <div className="flex flex-col md:flex-row bg-white rounded-xl border border-border overflow-hidden shadow-sm">
          <div className="bg-primary text-secondary p-8 md:w-56 flex flex-col items-center justify-center shrink-0 border-b md:border-b-0 md:border-r border-border">
            <span className="font-sans font-bold text-xs tracking-[0.2em] uppercase mb-4 text-center">Days 31–60</span>
            <span className="font-serif font-bold text-6xl text-center">02</span>
          </div>
          <div className="p-8 flex flex-col justify-center">
            <h3 className="font-serif font-bold text-2xl text-primary mb-4">Make membership differences tangible</h3>
            <p className="font-sans text-muted-foreground text-base leading-relaxed mb-6">
              Label every course and resource by tier. Add locked previews, upgrade prompts, and a comparison view that explains outcomes—not just content quantity. Connect the $29 tier to workshops and feedback; reserve transformation intensives for premium.
            </p>
            <p className="font-sans font-bold text-chart-3 text-sm tracking-wide">
              Primary metric: free → $29 trial or subscription intent
            </p>
          </div>
        </div>

        {/* Phase 3 */}
        <div className="flex flex-col md:flex-row bg-white rounded-xl border border-border overflow-hidden shadow-sm">
          <div className="bg-primary text-secondary p-8 md:w-56 flex flex-col items-center justify-center shrink-0 border-b md:border-b-0 md:border-r border-border">
            <span className="font-sans font-bold text-xs tracking-[0.2em] uppercase mb-4 text-center">Days 61–90</span>
            <span className="font-serif font-bold text-6xl text-center">03</span>
          </div>
          <div className="p-8 flex flex-col justify-center">
            <h3 className="font-serif font-bold text-2xl text-primary mb-4">Install the transformation proof loop</h3>
            <p className="font-sans text-muted-foreground text-base leading-relaxed mb-6">
              Collect structured member stories at enrollment and after key milestones. Ask what changed in routine, product confidence, camera comfort, and willingness to be seen. Feature proof beside the relevant pathway.
            </p>
            <p className="font-sans font-bold text-chart-3 text-sm tracking-wide">
              Primary metric: pathway completion + usable transformation stories
            </p>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle title="Trap-setting questions" />
        <div className="flex flex-col gap-4 pl-2">
          <Bullet>
            Are you looking for another tutorial—or a method tailored to your features, season of life, and visibility goals?
          </Bullet>
          <Bullet>
            What happens after you finish the course: do you keep growing, receive feedback, and have a community to return to?
          </Bullet>
          <Bullet>
            Are you only learning makeup, or are you preparing to show up differently in your business, relationships, and next chapter?
          </Bullet>
        </div>
      </section>
    </div>
  );
}
