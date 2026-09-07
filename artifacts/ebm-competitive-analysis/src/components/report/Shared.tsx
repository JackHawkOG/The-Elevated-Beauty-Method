import React from 'react';

export function PageHeader({ 
  kicker, 
  title, 
  subtitle 
}: { 
  kicker: string; 
  title: string; 
  subtitle?: string 
}) {
  return (
    <header className="bg-primary text-primary-foreground -mx-6 md:-mx-16 p-8 md:p-16 mb-8 md:mb-12 border-b-[6px] border-secondary relative">
      <div className="text-secondary font-sans font-bold text-xs tracking-[0.2em] uppercase mb-4">
        {kicker}
      </div>
      <h1 className="font-serif text-4xl md:text-5xl lg:text-6xl text-cream mb-4 md:mb-6">
        {title}
      </h1>
      {subtitle && (
        <p className="font-sans text-sm md:text-base text-cream/70 max-w-2xl leading-relaxed">
          {subtitle}
        </p>
      )}
    </header>
  );
}

export function SectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-4 mb-8">
      <h2 className="font-serif font-bold text-2xl text-primary">{title}</h2>
      <div className="h-0.5 w-16 bg-secondary"></div>
    </div>
  );
}

export function Bullet({ children, color = "bg-secondary" }: { children: React.ReactNode, color?: string }) {
  return (
    <div className="flex items-start gap-4 mb-4">
      <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${color}`}></div>
      <p className="font-sans text-muted-foreground leading-relaxed text-base">
        {children}
      </p>
    </div>
  );
}

export function Card({ 
  number, 
  title, 
  copy 
}: { 
  number?: string | number, 
  title: string, 
  copy: string 
}) {
  return (
    <div className="bg-white border border-border rounded-xl p-8 relative overflow-hidden flex flex-col">
      {number && (
        <div className="w-8 h-8 rounded-full bg-primary text-secondary flex items-center justify-center font-bold font-sans text-sm mb-6">
          {number}
        </div>
      )}
      <h4 className="font-serif font-bold text-xl text-primary mb-4">{title}</h4>
      <p className="font-sans text-muted-foreground leading-relaxed text-sm mt-auto">
        {copy}
      </p>
    </div>
  );
}
