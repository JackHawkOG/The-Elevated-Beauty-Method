import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Library, Users, User, LogOut, MessageSquare } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarProvider, SidebarTrigger, SidebarFooter } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const masterLogo = `${import.meta.env.BASE_URL}brand/tebm-master-logo-1920x1080.png`;
const masterMonogram = `${import.meta.env.BASE_URL}brand/tebm-master-monogram.png`;

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  return (
    <SidebarProvider>
      <div className="flex min-h-screen bg-background text-foreground w-full">
        <Sidebar className="border-r border-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="p-4">
            <Link href="/dashboard" className="flex items-center justify-center overflow-hidden rounded-xl transition-opacity hover:opacity-90">
              <img
                src={masterLogo}
                alt="The Elevated Beauty Method"
                className="h-auto w-full object-contain"
              />
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
                <SidebarMenuButton onClick={() => signOut({ redirectUrl: "/" })} className="text-muted-foreground hover:text-foreground">
                  <LogOut /> <span>Log out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          <header className="h-16 flex items-center px-6 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 md:hidden">
            <SidebarTrigger />
            <img
              src={masterMonogram}
              alt="The Elevated Beauty Method"
               className="ml-4 h-11 w-auto object-contain"
            />
          </header>
          <div className="flex-1 overflow-auto">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}