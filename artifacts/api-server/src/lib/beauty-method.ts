export type BeautyDiagnostic = {
  skinType: string;
  undertone: string;
  featureNeeds: string[];
  lifeStage: string;
  visibilityGoal: string;
};

const sequence = [
  { number: 1, title: "Prepare Your Canvas", description: "A skin-first routine for smooth, lasting makeup.", accessTier: "Free" as const },
  { number: 2, title: "Even, Never Mask", description: "Build breathable coverage that still looks like you.", accessTier: "Free" as const },
  { number: 3, title: "Define Your Features", description: "Bring balance to brows, eyes, and natural structure.", accessTier: "Free" as const },
  { number: 4, title: "Add Life & Dimension", description: "Place warmth, color, and light with intention.", accessTier: "Free" as const },
  { number: 5, title: "Finish With Presence", description: "Refine the details that help you feel ready to be seen.", accessTier: "Free" as const },
];

export function buildBeautyMethod(diagnostic: BeautyDiagnostic | null) {
  if (!diagnostic) {
    return {
      completed: false,
      diagnostic: null,
      methodName: "Your Method",
      methodSummary: "Complete your five-question beauty diagnostic to reveal a pathway made for you.",
      focusAreas: [],
      sequence,
    };
  }

  const visibilityMethods: Record<string, string> = {
    "Everyday confidence": "The Polished Everyday Method",
    "Camera ready": "The Camera-Ready Method",
    "Executive presence": "The Executive Presence Method",
    "Personal brand": "The Visible Brand Method",
    "Special occasions": "The Occasion-Ready Method",
  };

  return {
    completed: true,
    diagnostic,
    methodName: visibilityMethods[diagnostic.visibilityGoal] ?? "Your Elevated Method",
    methodSummary: `Designed for ${diagnostic.skinType.toLowerCase()} skin with a ${diagnostic.undertone.toLowerCase()} undertone, this pathway builds ${diagnostic.visibilityGoal.toLowerCase()} through techniques that fit your ${diagnostic.lifeStage.toLowerCase()}.`,
    focusAreas: [`${diagnostic.skinType} skin preparation`, `${diagnostic.undertone} color harmony`, ...diagnostic.featureNeeds],
    sequence,
  };
}

const tierRank = { Free: 0, Elevated: 1, Premium: 2 } as const;

export function canAccessTier(memberTier: string, accessTier: string) {
  const memberRank = tierRank[memberTier as keyof typeof tierRank] ?? 0;
  const requiredRank = tierRank[accessTier as keyof typeof tierRank] ?? 2;
  return memberRank >= requiredRank;
}