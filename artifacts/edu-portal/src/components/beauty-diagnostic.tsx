import { useState } from "react";
import { 
  BeautyDiagnosticInput, 
  BeautyMethod,
  BeautyDiagnosticInputSkinType,
  BeautyDiagnosticInputUndertone,
  BeautyDiagnosticInputFeatureNeedsItem,
  BeautyDiagnosticInputLifeStage,
  BeautyDiagnosticInputVisibilityGoal,
  useSaveBeautyDiagnostic,
  getGetBeautyMethodQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Check, ArrowRight, Sparkles, ChevronRight, Lock, Unlock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

export function BeautyDiagnostic({ method }: { method?: BeautyMethod | null }) {
  if (!method || !method.completed) {
    return <DiagnosticWizard />;
  }

  return <MethodPathway method={method} />;
}

function DiagnosticWizard() {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Partial<BeautyDiagnosticInput>>({
    featureNeeds: [],
  });
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const saveDiagnostic = useSaveBeautyDiagnostic({
    mutation: {
      onSuccess: (data) => {
        // Update the beauty method cache immediately
        queryClient.setQueryData(getGetBeautyMethodQueryKey(), data);
        toast({ title: "Method generated", description: "Your custom pathway is ready." });
      },
      onError: () => {
        toast({ title: "Error", description: "Could not save your diagnostic. Please try again.", variant: "destructive" });
      }
    }
  });

  const steps = [
    {
      id: "skinType",
      title: "How does your skin usually feel?",
      subtitle: "This helps us tailor your prep and base recommendations.",
      options: Object.values(BeautyDiagnosticInputSkinType).map(v => ({ value: v, label: v })),
      type: "single"
    },
    {
      id: "undertone",
      title: "What is your primary undertone?",
      subtitle: "Crucial for finding your perfect color matches.",
      options: Object.values(BeautyDiagnosticInputUndertone).map(v => ({ value: v, label: v })),
      type: "single"
    },
    {
      id: "featureNeeds",
      title: "What areas do you want to focus on most?",
      subtitle: "Select all that apply. We'll prioritize these in your method.",
      options: Object.values(BeautyDiagnosticInputFeatureNeedsItem).map(v => ({ value: v, label: v })),
      type: "multi"
    },
    {
      id: "lifeStage",
      title: "What season of life are you currently in?",
      subtitle: "Beauty meets you where you are. This context matters.",
      options: Object.values(BeautyDiagnosticInputLifeStage).map(v => ({ value: v, label: v })),
      type: "single"
    },
    {
      id: "visibilityGoal",
      title: "What is your primary visibility goal?",
      subtitle: "How do you want to show up in the world?",
      options: Object.values(BeautyDiagnosticInputVisibilityGoal).map(v => ({ value: v, label: v })),
      type: "single"
    }
  ];

  const currentStep = steps[step];
  const isLastStep = step === steps.length - 1;

  const handleSelect = (val: string) => {
    if (currentStep.type === "single") {
      setFormData(prev => ({ ...prev, [currentStep.id]: val }));
    } else {
      const currentArr = (formData as any)[currentStep.id] as string[];
      if (currentArr.includes(val)) {
        setFormData(prev => ({ ...prev, [currentStep.id]: currentArr.filter(i => i !== val) }));
      } else {
        setFormData(prev => ({ ...prev, [currentStep.id]: [...currentArr, val] }));
      }
    }
  };

  const isCurrentStepValid = () => {
    const val = (formData as any)[currentStep.id];
    if (currentStep.type === "single") return !!val;
    return val && val.length > 0;
  };

  const handleNext = () => {
    if (!isCurrentStepValid()) return;
    
    if (isLastStep) {
      saveDiagnostic.mutate({ data: formData as BeautyDiagnosticInput });
    } else {
      setStep(s => s + 1);
    }
  };

  return (
    <Card className="border-primary/20 bg-card/40 overflow-hidden shadow-[0_0_50px_-15px_rgba(255,224,153,0.1)] mb-12">
      <div className="h-1 bg-muted w-full">
        <div 
          className="h-full bg-primary transition-all duration-500 ease-in-out" 
          style={{ width: `${((step + 1) / steps.length) * 100}%` }}
        />
      </div>
      <CardContent className="p-8 md:p-12">
        <div className="max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 text-primary font-medium text-xs tracking-widest uppercase mb-4">
            <Sparkles className="w-3.5 h-3.5" /> Discovery — {step + 1} of {steps.length}
          </div>
          
          <div className="min-h-[280px]">
            <h2 className="font-serif text-3xl md:text-4xl font-bold mb-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {currentStep.title}
            </h2>
            <p className="text-muted-foreground mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100">
              {currentStep.subtitle}
            </p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
              {currentStep.options.map(opt => {
                const isSelected = currentStep.type === "single" 
                  ? (formData as any)[currentStep.id] === opt.value
                  : ((formData as any)[currentStep.id] as string[])?.includes(opt.value);
                  
                return (
                  <button
                    key={opt.value}
                    onClick={() => handleSelect(opt.value)}
                    className={`
                      text-left px-6 py-4 rounded-xl border transition-all duration-200 flex items-center justify-between
                      ${isSelected 
                        ? 'border-primary bg-primary/10 text-primary shadow-[0_0_20px_-5px_rgba(255,224,153,0.2)]' 
                        : 'border-border bg-background hover:border-primary/50 hover:bg-card'}
                    `}
                  >
                    <span className={`font-medium ${isSelected ? 'text-primary' : 'text-foreground'}`}>{opt.label}</span>
                    {isSelected && <Check className="w-5 h-5 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-8 flex justify-end">
            <Button 
              onClick={handleNext} 
              disabled={!isCurrentStepValid() || saveDiagnostic.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full px-8 h-12"
            >
              {saveDiagnostic.isPending ? "Generating..." : isLastStep ? "Reveal My Method" : "Next Step"}
              {!saveDiagnostic.isPending && <ArrowRight className="w-4 h-4 ml-2" />}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MethodPathway({ method }: { method: BeautyMethod }) {
  return (
    <div className="space-y-8 mb-12 animate-in fade-in duration-700">
      <div className="bg-card border border-primary/20 rounded-3xl p-8 md:p-12 relative overflow-hidden shadow-[0_0_50px_-15px_rgba(255,224,153,0.15)]">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/3 pointer-events-none"></div>
        
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 text-primary font-medium text-sm tracking-widest uppercase mb-4">
            <Sparkles className="w-4 h-4" /> Your Custom Pathway
          </div>
          <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4 text-foreground">{method.methodName}</h2>
          <p className="text-xl text-muted-foreground max-w-3xl leading-relaxed mb-8">
            {method.methodSummary}
          </p>
          
          <div className="flex flex-wrap gap-2 mb-12">
            {method.focusAreas.map(area => (
              <span key={area} className="px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-sm font-medium">
                {area}
              </span>
            ))}
          </div>

          <div className="space-y-4">
            <h3 className="font-serif text-2xl font-bold mb-6 border-b border-border/50 pb-4">Your Recommended Sequence</h3>
            
            {method.sequence.map((step, index) => (
              <div key={index} className="flex gap-4 md:gap-6 bg-background/50 border border-border p-5 rounded-2xl hover:border-primary/30 transition-colors group">
                <div className="shrink-0 w-10 h-10 rounded-full bg-card border border-primary/20 flex items-center justify-center text-primary font-serif font-bold text-lg">
                  {step.number}
                </div>
                <div className="flex-1">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mb-2">
                    <h4 className="font-bold text-lg">{step.title}</h4>
                    {step.accessTier === "Free" ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                        <Unlock className="w-3 h-3" /> Included
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium border border-primary/20">
                        <Lock className="w-3 h-3" /> {step.accessTier} Tier
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-sm leading-relaxed mb-3">{step.description}</p>
                  <Button variant="link" className="p-0 h-auto text-primary hover:text-primary/80 group-hover:underline" asChild>
                    <Link href="/courses">Find in Library <ChevronRight className="w-4 h-4 ml-1" /></Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function BeautyDiagnosticSkeleton() {
  return (
    <Card className="border-border bg-card/40 mb-12">
      <CardContent className="p-12">
        <Skeleton className="h-4 w-32 mb-6 bg-muted" />
        <Skeleton className="h-10 w-2/3 mb-4 bg-muted" />
        <Skeleton className="h-6 w-1/2 mb-12 bg-muted" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full bg-muted rounded-xl" />)}
        </div>
      </CardContent>
    </Card>
  );
}
