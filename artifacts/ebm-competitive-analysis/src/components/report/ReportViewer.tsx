import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Menu, X } from 'lucide-react';
import { ExecutiveSummary } from './Page1';
import { Landscape } from './Page2';
import { FeatureMatrix } from './Page3';
import { Positioning } from './Page4';
import { Opportunity } from './Page5';
import { ActionPlan } from './Page6';
import { Evidence } from './Page7';

const pages = [
  { id: 1, component: ExecutiveSummary, title: "Executive summary" },
  { id: 2, component: Landscape, title: "Landscape" },
  { id: 3, component: FeatureMatrix, title: "Product" },
  { id: 4, component: Positioning, title: "Positioning" },
  { id: 5, component: Opportunity, title: "Opportunity" },
  { id: 6, component: ActionPlan, title: "Action" },
  { id: 7, component: Evidence, title: "Evidence" },
];

export function ReportViewer() {
  const [currentPage, setCurrentPage] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentPage]);

  const CurrentComponent = pages[currentPage - 1].component;
  const totalPages = pages.length;

  const goNext = () => {
    if (currentPage < totalPages) setCurrentPage(p => p + 1);
  };

  const goPrev = () => {
    if (currentPage > 1) setCurrentPage(p => p - 1);
  };

  return (
    <div className="min-h-screen bg-popover text-foreground selection:bg-secondary selection:text-primary">
      {/* Top Navigation Bar */}
      <nav className="sticky top-0 z-50 bg-popover/90 backdrop-blur-md border-b border-border px-4 md:px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary rounded flex items-center justify-center p-2">
            <img src={`${import.meta.env.BASE_URL}ebm-logo.svg`} alt="EBM Logo" className="w-full h-full object-contain" />
          </div>
          <div className="hidden md:block">
            <h1 className="font-sans font-bold text-sm tracking-widest uppercase text-primary">
              The Elevated Beauty Method
            </h1>
            <p className="font-sans text-xs text-muted-foreground">
              Competitive Analysis
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <span className="font-sans text-sm font-medium text-muted-foreground hidden sm:block">
            Page {currentPage} of {totalPages}
          </span>
          <button 
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 text-primary hover:bg-black/5 rounded-full transition-colors"
          >
            {menuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </nav>

      {/* Dropdown Menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 bg-popover/95 backdrop-blur-sm pt-24 px-4 md:px-8">
          <div className="max-w-2xl mx-auto flex flex-col gap-2">
            <h3 className="font-sans font-bold text-xs tracking-widest uppercase text-muted-foreground mb-4">Table of Contents</h3>
            {pages.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setCurrentPage(p.id);
                  setMenuOpen(false);
                }}
                className={`flex items-center justify-between p-4 rounded-xl text-left transition-colors ${
                  currentPage === p.id 
                    ? 'bg-primary text-secondary' 
                    : 'hover:bg-black/5 text-primary'
                }`}
              >
                <span className="font-serif text-xl">{p.title}</span>
                <span className="font-sans text-sm opacity-50">0{p.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-32">
        <div className="bg-background rounded-2xl md:rounded-[2rem] shadow-xl border border-black/5 overflow-hidden min-h-[600px]">
          <div className="px-6 md:px-16 pb-8 md:pb-16">
            <CurrentComponent />
          </div>
        </div>
      </main>

      {/* Bottom Floating Navigation */}
      <div className="fixed bottom-0 left-0 right-0 z-30 p-4 md:p-8 pointer-events-none flex justify-center">
        <div className="bg-primary text-secondary rounded-full shadow-2xl pointer-events-auto flex items-center p-2 border border-black/10">
          <button 
            onClick={goPrev}
            disabled={currentPage === 1}
            className="p-3 rounded-full hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-all"
            aria-label="Previous page"
          >
            <ChevronLeft size={24} />
          </button>
          
          <div className="px-6 flex items-center gap-2 font-sans font-medium text-sm">
            <span>{currentPage}</span>
            <span className="opacity-50">/</span>
            <span className="opacity-50">{totalPages}</span>
          </div>

          <button 
            onClick={goNext}
            disabled={currentPage === totalPages}
            className="p-3 rounded-full hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-all"
            aria-label="Next page"
          >
            <ChevronRight size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}
