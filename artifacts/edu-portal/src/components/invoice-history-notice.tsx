import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { getGetMembershipInvoiceHistoryNoticeQueryKey, useGetMembershipInvoiceHistoryNotice } from "@workspace/api-client-react";

export function InvoiceHistoryNotice() {
  const { user } = useUser();
  const canReview = ["owner", "admin"].includes(String(user?.publicMetadata.role));
  const notice = useGetMembershipInvoiceHistoryNotice({
    query: {
      queryKey: [...getGetMembershipInvoiceHistoryNoticeQueryKey(), user?.id],
      enabled: Boolean(user?.id && canReview),
      gcTime: 0,
      staleTime: 0,
      retry: false,
      refetchInterval: 30_000,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  if (!user?.id || !canReview) return null;
  if (notice.isError) return <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
    Invoice history recovery notices could not be checked. No recovery status can be confirmed. They will retry automatically.{" "}
    <Link href="/membership/invoice-history" className="underline font-medium">View pending invoice history</Link>
  </div>;
  const count = notice.data?.overdueCount ?? 0;
  if (!count) return null;
  return <div role="status" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
    Invoice history recovery needs attention: automatic history lookups for ended memberships have failed at least {notice.data!.failedAttemptThreshold} times.{" "}
    <Link href="/membership/invoice-history" className="underline font-medium">Review pending invoice history</Link>
    <span className="block text-xs text-muted-foreground">This private operational notice clears after history recovery. Missing history is not proof of payment failure. Access remains ended.</span>
  </div>;
}