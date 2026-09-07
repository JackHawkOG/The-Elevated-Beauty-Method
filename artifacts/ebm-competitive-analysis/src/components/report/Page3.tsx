import React from 'react';
import { PageHeader, SectionTitle } from './Shared';

const matrix = [
  ["Skin type & undertone", 5, "●", "●", "◐", "◐", "●"],
  ["Face / eye feature mapping", 5, "◐", "●", "◐", "◐", "●"],
  ["Clear beginner pathway", 5, "◐", "●", "○", "◐", "●"],
  ["Identity & confidence work", 5, "●", "◐", "○", "○", "◐"],
  ["Age-positive beauty", 4, "●", "◐", "◐", "◐", "◐"],
  ["Visibility / camera presence", 4, "●", "◐", "◐", "○", "◐"],
  ["Ongoing community", 4, "●", "◐", "◐", "○", "●"],
  ["Progress tracking", 4, "●", "●", "◐", "○", "●"],
  ["Digital guides / workbook", 4, "◐", "●", "○", "○", "◐"],
  ["Visible customer proof", 5, "○", "●", "◐", "◐", "●"],
  ["Tiered recurring membership", 3, "◐", "○", "○", "○", "◐"],
  ["Personalized support", 4, "◐", "●", "○", "●", "●"],
];

const getSymbolColor = (symbol: string, colIndex: number) => {
  if (colIndex < 2) return "text-primary";
  if (symbol === "●") return "text-chart-3"; // green
  if (symbol === "◐") return "text-chart-4"; // amber
  if (symbol === "○") return "text-destructive"; // rose
  return "text-muted-foreground";
};

export function FeatureMatrix() {
  return (
    <div className="flex flex-col gap-12 animate-in fade-in duration-700">
      <PageHeader 
        kicker="02 / Product"
        title="Feature matrix"
        subtitle="● strong / live   ◐ partial / planned   ○ absent or not evident   • Weight = buyer importance (1–5)"
      />

      <section className="overflow-x-auto">
        <div className="min-w-[800px] border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-12 bg-primary text-cream p-4 font-sans font-bold text-xs tracking-wider uppercase">
            <div className="col-span-5 pl-2">Capability</div>
            <div className="col-span-1 text-center">Wt.</div>
            <div className="col-span-1 text-center">EBM</div>
            <div className="col-span-1 text-center">Natalie</div>
            <div className="col-span-1 text-center">Social</div>
            <div className="col-span-1 text-center">Retail</div>
            <div className="col-span-2 text-center">Pro</div>
          </div>
          
          <div className="divide-y divide-border bg-white">
            {matrix.map((row, i) => (
              <div 
                key={i} 
                className={`grid grid-cols-12 p-4 items-center transition-colors ${i % 2 !== 0 ? 'bg-secondary/10' : 'bg-white'} hover:bg-muted/30`}
              >
                <div className="col-span-5 pr-4 font-sans text-sm font-medium text-primary">
                  {row[0]}
                </div>
                <div className="col-span-1 text-center font-sans text-sm text-muted-foreground">
                  {row[1]}
                </div>
                {row.slice(2).map((val, j) => (
                  <div key={j} className={`${j === 4 ? 'col-span-2' : 'col-span-1'} text-center font-sans text-lg ${getSymbolColor(val as string, j + 2)}`}>
                    {val}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-secondary/30 border border-secondary/50 text-primary rounded-xl p-6 md:p-8">
        <p className="font-sans text-sm md:text-base leading-relaxed font-bold">
          Priority gap: EBM already has the broadest transformation proposition, but Natalie currently communicates the learning journey and individual relevance more convincingly.
        </p>
      </section>
    </div>
  );
}
