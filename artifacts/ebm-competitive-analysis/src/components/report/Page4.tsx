import React from 'react';
import { PageHeader, SectionTitle, Bullet } from './Shared';

export function Positioning() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="03 / Positioning"
        title="The white-space position"
        subtitle="The attractive corner combines individual relevance with an ongoing transformation ecosystem."
      />

      <section>
        <div className="rounded-xl overflow-hidden border border-border shadow-sm mb-12 bg-primary">
          <img 
            src={`${import.meta.env.BASE_URL}positioning-map.png`}
            alt="Positioning map showing EBM in the high individual relevance and high ongoing transformation quadrant" 
            className="w-full h-auto object-contain"
          />
        </div>
      </section>

      <section>
        <SectionTitle title="Interpretation" />
        <div className="flex flex-col gap-4 pl-2">
          <Bullet>
            Natalie is strong on personalization to the learner, but the experience is primarily a course-and-guide funnel rather than a recurring identity community.
          </Bullet>
          <Bullet>
            Pro academies provide structure and feedback, but their career and certification emphasis overshoots the everyday woman's job-to-be-done.
          </Bullet>
          <Bullet>
            EBM can occupy the premium upper-right by making its promised transformation operational: diagnostic onboarding, guided pathways, live support, and member milestones.
          </Bullet>
        </div>
      </section>

      <section className="bg-primary text-secondary rounded-xl p-8 text-center md:text-left">
        <h3 className="font-serif font-bold text-2xl md:text-3xl leading-snug">
          Own this phrase: "The method for how you look, feel, and show up."
        </h3>
      </section>
    </div>
  );
}
