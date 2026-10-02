import { useEffect, useState } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Redirect, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { useProfileFreshness } from "@/hooks/use-profile-freshness";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY');
}

// Build your themed appearance object here
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/brand/tebm-master-logo-1920x1080.png`,
  },
  variables: {
    colorPrimary: "#FFECC2",
    colorForeground: "#F5EEE0",
    colorMutedForeground: "#A49574",
    colorDanger: "#e55",
    colorBackground: "#0A0A0A",
    colorInput: "#121212",
    colorInputForeground: "#F5EEE0",
    colorNeutral: "#1A1A1A",
    fontFamily: "Lato, sans-serif",
    borderRadius: "9999px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#0A0A0A] rounded-3xl w-[440px] max-w-full overflow-hidden border border-[#1A1A1A]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#F5EEE0] font-serif",
    headerSubtitle: "text-[#A49574]",
    socialButtonsBlockButtonText: "text-[#F5EEE0]",
    formFieldLabel: "text-[#A49574]",
    footerActionLink: "text-[#FFECC2]",
    footerActionText: "text-[#A49574]",
    dividerText: "text-[#A49574]",
    identityPreviewEditButton: "text-[#FFECC2]",
    formFieldSuccessText: "text-green-400",
    alertText: "text-[#F5EEE0]",
    logoBox: "flex justify-center",
    logoImage: "w-12 h-12",
    socialButtonsBlockButton: "border-[#1A1A1A] hover:bg-[#121212]",
    formButtonPrimary: "bg-[#FFECC2] text-[#0A0A0A] hover:bg-[#f5e0a0]",
    formFieldInput: "bg-[#121212] border-[#1A1A1A] text-[#F5EEE0]",
    footerAction: "text-[#A49574]",
    dividerLine: "bg-[#1A1A1A]",
    alert: "border-[#1A1A1A]",
    otpCodeFieldInput: "bg-[#121212] border-[#1A1A1A] text-[#F5EEE0]",
    formFieldRow: "",
    main: "",
  },
};

function MemberQuerySession() {
  const [queryClient] = useState(() => new QueryClient());
  const { user } = useUser();
  useProfileFreshness(user?.id, queryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
function SignInPage() {
  const pendingAudit = readPendingAudit();
  const joiningMembership = new URLSearchParams(window.location.search).get("membership") === "1";
  const viewingStories = new URLSearchParams(window.location.search).get("stories") === "1";
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up${joiningMembership ? "?membership=1" : ""}`}
        forceRedirectUrl={viewingStories ? `${basePath}/stories` : joiningMembership ? `${basePath}/membership` : pendingAudit ? `${basePath}/radiant-audit/complete` : undefined}
      />
    </div>
  );
}

function SignUpPage() {
  const pendingAudit = readPendingAudit();
  const joiningMembership = new URLSearchParams(window.location.search).get("membership") === "1";
  if (!pendingAudit && !joiningMembership && window.location.pathname === `${basePath}/sign-up`) {
    return <Redirect to="/radiant-audit" />;
  }
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in${joiningMembership ? "?membership=1" : ""}`}
        initialValues={pendingAudit ? { emailAddress: pendingAudit.email } : undefined}
        forceRedirectUrl={joiningMembership ? `${basePath}/membership` : pendingAudit ? `${basePath}/radiant-audit/complete` : undefined}
      />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/dashboard" /></Show>
      <Show when="signed-out"><LandingPage /></Show>
    </>
  );
}
// Import your page components
import LandingPage from '@/pages/landing';
import Dashboard from '@/pages/dashboard';
import MembershipPage from '@/pages/membership';
import CoursesPage from '@/pages/courses';
import CourseDetailPage from '@/pages/course-detail';
import LessonPage from '@/pages/lesson';
import CommunityPage from '@/pages/community';
import ProfilePage from '@/pages/profile';
import EditorialPage from '@/pages/editorial';
import MemberStoriesPage from '@/pages/member-stories';
import AnnouncementActivityReviewPage from '@/pages/announcement-activity-review';
import PublicStoriesPage from '@/pages/public-stories';
import RadiantAuditPage, { RadiantAuditCompletePage } from '@/pages/radiant-audit';
import { readPendingAudit } from '@/lib/radiant-audit-session';
import { pruneInvalidAuditDraft } from '@/lib/radiant-audit-draft';
import ElevatedRoutinePage from '@/pages/elevated-routine';
import GuidePrivacyPage from '@/pages/guide-privacy';
import GuidesPage from '@/pages/guides';

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in"><Component /></Show>
      <Show when="signed-out"><Redirect to="/" /></Show>
    </>
  );
}

function EditorialRoute() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  const role = user?.publicMetadata.role;
  if (role !== "admin" && role !== "owner" && role !== "editor") return <NotFound />;
  return <EditorialPage />;
}

function MemberStoriesRoute() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  const role = user?.publicMetadata.role;
  if (role !== "admin" && role !== "owner") return <NotFound />;
  return <MemberStoriesPage />;
}

function AnnouncementActivityReviewRoute() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  const role = user?.publicMetadata.role;
  if (role !== "admin" && role !== "owner") return <NotFound />;
  return <AnnouncementActivityReviewPage />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/the-elevated-routine" component={ElevatedRoutinePage} />
      <Route path="/guide-privacy" component={GuidePrivacyPage} />
      <Route path="/guides" component={() => <ProtectedRoute component={GuidesPage} />} />
      <Route path="/radiant-audit" component={RadiantAuditPage} />
      <Route path="/radiant-audit/complete" component={() => <ProtectedRoute component={RadiantAuditCompletePage} />} />
      <Route path="/dashboard" component={() => <ProtectedRoute component={Dashboard} />} />
      <Route path="/membership">
        <Show when="signed-in"><MembershipPage /></Show>
        <Show when="signed-out"><Redirect to="/sign-up?membership=1" /></Show>
      </Route>
      <Route path="/courses" component={() => <ProtectedRoute component={CoursesPage} />} />
      <Route path="/courses/:courseId" component={() => <ProtectedRoute component={CourseDetailPage} />} />
      <Route path="/courses/:courseId/lessons/:lessonId" component={() => <ProtectedRoute component={LessonPage} />} />
      <Route path="/community" component={() => <ProtectedRoute component={CommunityPage} />} />
      <Route path="/profile" component={() => <ProtectedRoute component={ProfilePage} />} />
      <Route path="/editorial" component={() => <ProtectedRoute component={EditorialRoute} />} />
      <Route path="/member-stories" component={() => <ProtectedRoute component={MemberStoriesRoute} />} />
      <Route path="/announcement-activity-review" component={() => <ProtectedRoute component={AnnouncementActivityReviewRoute} />} />
      <Route path="/stories" component={() => <ProtectedRoute component={PublicStoriesPage} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to continue learning" } },
        signUp: { start: { title: "Join The Elevated Beauty Method ™", subtitle: "Verify your email to create your account and continue" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <MemberQueryProvider />
    </ClerkProvider>
  );
}

function App() {
  useEffect(() => {
    pruneInvalidAuditDraft();
  }, []);
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;

function MemberQueryProvider() {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  // A response still in flight on the former member's client cannot populate
  // the next member's cache, even if it resolves after the auth change.
  return <MemberQuerySession key={user?.id ?? "signed-out"} />;
}
