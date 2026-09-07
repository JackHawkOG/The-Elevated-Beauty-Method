import React from 'react';
import { PageHeader, SectionTitle, Bullet } from './Shared';

const landscapeData = [
  {
    alt: "EBM",
    stage: "Working MVP",
    price: "$0 / $29 mo / $49 mo + $1,500",
    strength: "Transformation + ongoing community",
    weakness: "Proof, pathways and entitlements not yet mature",
    isEbm: true
  },
  {
    alt: "Natalie Setareh",
    stage: "Independent educator",
    price: "$127 course; $9.99–$19.99 guides",
    strength: "Specific, practical, inclusive curriculum",
    weakness: "Experience fragmented across site, shop and Thinkific"
  },
  {
    alt: "YouTube / Instagram",
    stage: "Mature platforms",
    price: "Free / ad-supported",
    strength: "Infinite volume and convenience",
    weakness: "Low trust, weak personalization, product bias"
  },
  {
    alt: "Sephora / Ulta classes",
    stage: "Retail education",
    price: "Often free or low-cost",
    strength: "Hands-on help and product trial",
    weakness: "Retail sales incentive; weak continuity"
  },
  {
    alt: "Online pro academies",
    stage: "Established schools",
    price: "From ~$49/mo; higher total tuition",
    strength: "Structure, feedback and certification",
    weakness: "Career-led; excessive for everyday learners"
  }
];

export function Landscape() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="01 / Landscape"
        title="Competitive landscape"
        subtitle="Pricing and features reflect publicly visible pages accessed in September 2026."
      />

      <section className="overflow-x-auto pb-4">
        <div className="min-w-[800px] border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-5 bg-primary text-cream p-4 font-sans font-bold text-xs tracking-wider uppercase">
            <div className="col-span-1 pl-2">Alternative</div>
            <div className="col-span-1">Stage</div>
            <div className="col-span-1">Public price</div>
            <div className="col-span-1">Primary strength</div>
            <div className="col-span-1">Primary weakness</div>
          </div>
          
          <div className="divide-y divide-border bg-white">
            {landscapeData.map((row, i) => (
              <div 
                key={i} 
                className={`grid grid-cols-5 p-5 items-center transition-colors ${row.isEbm ? 'bg-secondary/10' : 'hover:bg-muted/30'}`}
              >
                <div className={`col-span-1 pr-4 font-sans text-sm ${row.isEbm ? 'font-bold text-primary' : 'font-medium text-primary'}`}>
                  {row.alt}
                </div>
                <div className="col-span-1 pr-4 font-sans text-sm text-muted-foreground leading-snug">
                  {row.stage}
                </div>
                <div className="col-span-1 pr-4 font-sans text-sm text-muted-foreground leading-snug">
                  {row.price}
                </div>
                <div className="col-span-1 pr-4 font-sans text-sm text-muted-foreground leading-snug">
                  {row.strength}
                </div>
                <div className="col-span-1 pr-2 font-sans text-sm text-muted-foreground leading-snug">
                  {row.weakness}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <SectionTitle title="What the reference proves" />
        <div className="flex flex-col gap-2 pl-2">
          <Bullet>
            <strong className="text-primary font-medium">Specific outcomes create trust:</strong> skin type, undertone, face and eye shape, a five-day sequence, a workbook, video instruction, support, and one-year access.
          </Bullet>
          <Bullet>
            <strong className="text-primary font-medium">Natalie's own testimonials</strong> emphasize confidence, faster routines, smarter product shopping, and advice suited to the individual—not trend imitation.
          </Bullet>
          <Bullet color="bg-destructive">
            No independent review corpus was found for Natalie's course; the proof cited here is seller-published and should be treated as directional.
          </Bullet>
        </div>
      </section>
    </div>
  );
}
