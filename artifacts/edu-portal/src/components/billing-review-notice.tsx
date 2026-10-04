import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { getGetMembershipReviewNotificationsQueryKey, useGetMembershipReviewNotifications } from "@workspace/api-client-react";
import { InvoiceHistoryNotice } from "./invoice-history-notice";

export function BillingReviewNotice() {
  return <><ReviewNotice /><InvoiceHistoryNotice /></>;
}

function ReviewNotice() {
  const { user } = useUser();
  const canReview = ["owner", "admin"].includes(String(user?.publicMetadata.role));
  const notifications = useGetMembershipReviewNotifications({
    query: {
      queryKey: [...getGetMembershipReviewNotificationsQueryKey(), user?.id],
      enabled: Boolean(user?.id && canReview),
      staleTime: 0,
      refetchInterval: 30_000,
      refetchOnWindowFocus: "always",
    },
  });
  // Check current identity even when a previous account's cache is present.
  if (!user?.id || !canReview) return null;
  if (notifications.isError) return <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
    Billing review notifications could not be checked. They will retry automatically.
  </div>;
  const count = notifications.data?.length ?? 0;
  if (!count) return null;
  return <div role="status" className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
    Billing review needs attention: {count === 1 ? "one founding subscription has" : `${count} founding subscriptions have`} repeatedly failed automatic review.{" "}
    <Link href="/membership" className="underline font-medium">Review membership alerts</Link>
    <span className="block text-xs text-muted-foreground">This private notification clears after a successful review.</span>
  </div>;
}