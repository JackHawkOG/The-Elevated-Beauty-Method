import React from 'react';
import { PageHeader, SectionTitle } from './Shared';

const sources = [
  ["1", "Natalie Setareh — 7 Ways to Learn Makeup at Home", "https://nataliesetareh.com/learn-makeup-at-home/"],
  ["2", "Natalie Setareh — Learn Makeup in 5 Days", "https://nataliesetareh.com/learnmakeup"],
  ["3", "Natalie Setareh — Makeup Learning Lab / Shop", "https://nataliesetareh.com/shop"],
  ["4", "Natalie Setareh — Makeup for Beginners guide", "https://nataliesetareh.com/makeup-for-beginners"],
  ["5", "Thinkific — Learn Makeup in 5 Days curriculum", "https://makeupforbeginners.thinkific.com/courses/learn"],
  ["6", "Create Your Signature Look — Makeup coaching", "https://createyoursignaturelook.com/makeup"],
  ["7", "QC Makeup Academy — Online makeup courses", "https://www.qcmakeupacademy.com/online-makeup-courses"],
  ["8", "Online Makeup Academy — Programs and tuition", "https://www.onlinemakeupacademy.com/programs-and-tuition"],
  ["9", "EBM working product — current app and supplied membership brief", "Current Replit project and user-provided source document"],
];

export function Evidence() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="06 / Evidence"
        title="Sources & confidence notes"
        subtitle="Public pages accessed September 2026. Pricing and product details may change."
      />

      <section>
        <div className="flex flex-col gap-6">
          {sources.map((source, i) => (
            <div key={i} className="flex items-start gap-4 md:gap-6">
              <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-primary text-secondary flex items-center justify-center shrink-0 font-bold font-sans text-sm md:text-base mt-1">
                {source[0]}
              </div>
              <div className="flex flex-col gap-1 pt-1">
                <h4 className="font-sans font-bold text-base md:text-lg text-primary">
                  {source[1]}
                </h4>
                <a 
                  href={source[2].startsWith('http') ? source[2] : '#'} 
                  target="_blank" 
                  rel="noreferrer"
                  className="font-sans text-sm text-muted-foreground hover:text-chart-4 transition-colors break-all"
                >
                  {source[2]}
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-secondary/30 border border-secondary/50 text-primary rounded-xl p-6 md:p-8 mt-4">
        <h4 className="font-sans font-bold text-xs tracking-[0.2em] uppercase mb-4 text-primary">Confidence Note</h4>
        <p className="font-sans text-sm md:text-base leading-relaxed font-medium">
          Natalie's strengths and testimonials are based primarily on her own public pages; no meaningful independent review corpus was found. The positioning map and feature ratings are analyst judgments, clearly separated from sourced facts.
        </p>
      </section>
    </div>
  );
}
