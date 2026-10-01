import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Library, User, LogOut, MessageSquare, ClipboardCheck, Quote } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarProvider, SidebarTrigger, SidebarFooter } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getListMemberStoryRemovalAlertsQueryKey, useListMemberStoryRemovalAlerts } from "@workspace/api-client-react";
import { clearAuditDraftOnSignOut } from "@/lib/radiant-audit-draft";
import { BillingReviewNotice } from "@/components/billing-review-notice";

const masterLogo = `${import.meta.env.BASE_URL}brand/tebm-master-logo-transparent.png`;

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const canReview = ["admin", "owner", "editor"].includes(String(user?.publicMetadata.role));
  const canManageStories = ["admin", "owner"].includes(String(user?.publicMetadata.role));
  const removalAlerts = useListMemberStoryRemovalAlerts({
    query: {
      queryKey: [...getListMemberStoryRemovalAlertsQueryKey(), user?.id],
      enabled: Boolean(user?.id && canManageStories),
      refetchInterval: 30_000,
      refetchOnWindowFocus: "always",
      staleTime: 0,
    },
  });
  const latestRemoval = canManageStories ? removalAlerts.data?.[0] : undefined;
  const removalCount = canManageStories ? removalAlerts.data?.length ?? 0 : 0;

  return (
    <SidebarProvider>
      <div className="flex min-h-screen bg-background text-foreground w-full">
        <Sidebar className="border-r border-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="p-4">
            <Link href="/dashboard" className="flex items-center justify-center overflow-hidden rounded-xl transition-opacity hover:opacity-90">
              <span className="relative block w-full">
                <img src={masterLogo} alt="The Elevated Beauty Method ™" className="block h-auto w-full object-contain" />
                <img src={masterLogo} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full object-contain" style={{ clipPath: "inset(76% 0 12% 0)", filter: "brightness(2.2)" }} />
                <span aria-hidden="true" className="absolute bottom-[17%] right-[5.5%] translate-y-1/2 text-[clamp(5px,0.9vw,12px)] leading-none text-[#c9a478]/80">™</span>
              </span>
            </Link>
          </SidebarHeader>
          <SidebarContent className="px-2 py-4">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location === "/dashboard"}>
                  <Link href="/dashboard"><LayoutDashboard /> <span>Dashboard</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.startsWith("/courses")}>
                  <Link href="/courses"><Library /> <span>Courses</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {canReview && <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.startsWith("/editorial")}>
                  <Link href="/editorial" data-testid="link-editorial"><ClipboardCheck /> <span>Draft review</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>}
              {canManageStories && <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.startsWith("/member-stories")}>
                   <Link href="/member-stories"><Quote /> <span>Member stories</span>{removalCount > 0 && <span className="ml-auto rounded-full bg-destructive px-2 text-xs text-destructive-foreground" aria-label={`${removalCount} outstanding story removal requests`}>{removalCount}</span>}</Link>
                </SidebarMenuButton>
              </SidebarMenuItem>}
              {canManageStories && <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location === "/announcement-activity-review"}>
                  <Link href="/announcement-activity-review"><ClipboardCheck /> <span>Announcement feed review</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>}
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location === "/stories"}>
                  <Link href="/stories"><Quote /> <span>View stories &amp; request removal</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.startsWith("/community")}>
                  <Link href="/community"><MessageSquare /> <span>Community</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.startsWith("/profile")}>
                  <Link href="/profile"><User /> <span>Profile</span></Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="p-4 border-t border-border">
            <div className="flex items-center gap-3 mb-4 px-2">
              <Avatar className="w-10 h-10 border border-border">
                <AvatarImage src={user?.imageUrl} />
                <AvatarFallback className="bg-muted text-muted-foreground">{user?.firstName?.[0]}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col flex-1 overflow-hidden">
                <span className="text-sm font-medium text-foreground truncate">{user?.fullName}</span>
                <span className="text-xs text-muted-foreground truncate">{user?.primaryEmailAddress?.emailAddress}</span>
              </div>
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => {
                   if (!clearAuditDraftOnSignOut(user?.id)) return;
                  void signOut({ redirectUrl: "/" });
                }} className="text-muted-foreground hover:text-foreground">
                  <LogOut /> <span>Log out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          <BillingReviewNotice />
          <header className="h-20 flex items-center px-4 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 md:hidden">
            <SidebarTrigger />
            <Link href="/dashboard" aria-label="The Elevated Beauty Method ™ home" className="ml-3 block w-[min(44vw,150px)]">
              <span className="relative block w-full">
                <img src={masterLogo} alt="The Elevated Beauty Method ™" className="block h-auto w-full object-contain" />
                <img src={masterLogo} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full object-contain" style={{ clipPath: "inset(76% 0 12% 0)", filter: "brightness(2.2)" }} />
                <span aria-hidden="true" className="absolute bottom-[17%] right-[5.5%] translate-y-1/2 text-[clamp(5px,1.1vw,8px)] leading-none text-[#c9a478]/80">™</span>
              </span>
            </Link>
          </header>
           {canManageStories && removalAlerts.isError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
             Could not check outstanding story removal requests. <Link href="/member-stories" className="underline">Open member stories</Link> to review them.
           </div>}
           {latestRemoval && !removalAlerts.isError && <div role="status" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
            <Link href={`/member-stories#story-${latestRemoval.storyId}`} className="font-semibold text-foreground underline underline-offset-2">
               {removalCount} outstanding story removal {removalCount === 1 ? "request" : "requests"} — review private request for story #{latestRemoval.storyId}
            </Link>
          </div>}
          <div className="flex-1 overflow-auto">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}