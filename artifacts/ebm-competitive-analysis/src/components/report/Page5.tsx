import React from 'react';
import { PageHeader, SectionTitle, Card } from './Shared';

export function Opportunity() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="04 / Opportunity"
        title="White space & Kano analysis"
        subtitle="What the category expects, what improves preference, and what can make EBM memorable."
      />

      <section>
        <SectionTitle title="Three under-served opportunities" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card 
            number={1}
            title="Life-stage pathways"
            copy="Organize the same core beauty skills around real moments: Everyday Elevation, On-Camera Visibility, Reinvention After 40, and Artist-to-Expert."
          />
          <Card 
            number={2}
            title="Prestige without intimidation"
            copy="Combine the polish of a luxury beauty brand with beginner-safe language, practical shopping guidance, and visible “start here” direction."
          />
          <Card 
            number={3}
            title="Practice-to-presence loop"
            copy="Move beyond watching videos: complete a look, reflect on confidence, share a result, receive feedback, and apply it in a real visibility moment."
          />
        </div>
      </section>

      <section>
        <SectionTitle title="Kano map" />
        
        <div className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row shadow-sm rounded-xl overflow-hidden border border-border">
            <div className="bg-destructive text-destructive-foreground p-6 md:w-48 flex items-center justify-center shrink-0">
              <span className="font-sans font-bold text-sm tracking-[0.2em] uppercase">Basics</span>
            </div>
            <div className="bg-white p-6 md:p-8 flex items-center w-full">
              <p className="font-sans text-sm md:text-base text-primary leading-relaxed">
                Clear curriculum • mobile-ready video • progress • accessible captions • secure account • explicit tier access
              </p>
            </div>
          </div>

          <div className="flex flex-col md:flex-row shadow-sm rounded-xl overflow-hidden border border-border">
            <div className="bg-chart-4 text-white p-6 md:w-48 flex items-center justify-center shrink-0">
              <span className="font-sans font-bold text-sm tracking-[0.2em] uppercase">Performance</span>
            </div>
            <div className="bg-white p-6 md:p-8 flex items-center w-full">
              <p className="font-sans text-sm md:text-base text-primary leading-relaxed">
                More personalization • faster feedback • stronger workbooks • longer access • better search • more live sessions
              </p>
            </div>
          </div>

          <div className="flex flex-col md:flex-row shadow-sm rounded-xl overflow-hidden border border-border">
            <div className="bg-chart-3 text-white p-6 md:w-48 flex items-center justify-center shrink-0">
              <span className="font-sans font-bold text-sm tracking-[0.2em] uppercase">Delighters</span>
            </div>
            <div className="bg-white p-6 md:p-8 flex items-center w-full">
              <p className="font-sans text-sm md:text-base text-primary leading-relaxed">
                Beauty identity profile • visibility rehearsals • age-positive pathways • reinvention circles • camera-look reviews
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
