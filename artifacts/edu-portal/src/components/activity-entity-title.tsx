import type { ActivityItem } from "@workspace/api-client-react";

export function ActivityEntityTitle({ item, className }: { item: ActivityItem; className: string }) {
  const title = item.entityTitle;
  if (!title) return null;

  if (item.type === "announcement" && item.sourceAnnouncementId != null) {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    return (
      <a
        href={`${base}/community#announcement-${item.sourceAnnouncementId}`}
        className={`${className} underline underline-offset-2 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary`}
      >
        {title}
      </a>
    );
  }

  return <span className={className}>{title}</span>;
}