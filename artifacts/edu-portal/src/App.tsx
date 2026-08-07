import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Redirect, Router as WouterRouter } from 'wouter';
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

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
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#FFECC2",
    colorForeground: "#F5EEE0",
    colorMutedForeground: "#A39575",
    colorDanger: "#e55",
    colorBackground: "#0A0A0A",
    colorInput: "#1a1a14",
    colorInputForeground: "#F5EEE0",
    colorNeutral: "#2F2B23",
    fontFamily: "Lato, sans-serif",
    borderRadius: "6px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#111108] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#2F2B23]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#F5EEE0] font-serif",
    headerSubtitle: "text-[#A39575]",
    socialButtonsBlockButtonText: "text-[#F5EEE0]",
    formFieldLabel: "text-[#A39575]",
    footerActionLink: "text-[#FFECC2]",
    footerActionText: "text-[#A39575]",
    dividerText: "text-[#A39575]",
    identityPreviewEditButton: "text-[#FFECC2]",
    formFieldSuccessText: "text-green-400",
    alertText: "text-[#F5EEE0]",
    logoBox: "flex justify-center",
    logoImage: "w-12 h-12",
    socialButtonsBlockButton: "border-[#2F2B23] hover:bg-[#1a1a14]",
    formButtonPrimary: "bg-[#FFECC2] text-[#0A0A0A] hover:bg-[#f5e0a0]",
    formFieldInput: "bg-[#1a1a14] border-[#2F2B23] text-[#F5EEE0]",
    footerAction: "text-[#A39575]",
    dividerLine: "bg-[#2F2B23]",
    alert: "border-[#2F2B23]",
    otpCodeFieldInput: "bg-[#1a1a14] border-[#2F2B23] text-[#F5EEE0]",
    formFieldRow: "",
    main: "",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsub = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsub;
  }, [addListener, qc]);
  return null;
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
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
import CoursesPage from '@/pages/courses';
import CourseDetailPage from '@/pages/course-detail';
import LessonPage from '@/pages/lesson';
import CommunityPage from '@/pages/community';
import ProfilePage from '@/pages/profile';

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in"><Component /></Show>
      <Show when="signed-out"><Redirect to="/" /></Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/dashboard" component={() => <ProtectedRoute component={Dashboard} />} />
      <Route path="/courses" component={() => <ProtectedRoute component={CoursesPage} />} />
      <Route path="/courses/:courseId" component={() => <ProtectedRoute component={CourseDetailPage} />} />
      <Route path="/courses/:courseId/lessons/:lessonId" component={() => <ProtectedRoute component={LessonPage} />} />
      <Route path="/community" component={() => <ProtectedRoute component={CommunityPage} />} />
      <Route path="/profile" component={() => <ProtectedRoute component={ProfilePage} />} />
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
        signUp: { start: { title: "Join The Elevated Beauty Method", subtitle: "Free access to all content" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;