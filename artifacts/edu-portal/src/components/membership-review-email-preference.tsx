import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMembershipReviewEmailPreference, useUpdateMembershipReviewEmailPreference,
  getGetMembershipReviewEmailPreferenceQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function MembershipReviewEmailPreference() {
  const { user } = useUser();
  const owner = user?.publicMetadata.role === "owner";
  const queryClient = useQueryClient();
  const queryKey = [...getGetMembershipReviewEmailPreferenceQueryKey(), user?.id];
  const preference = useGetMembershipReviewEmailPreference({
    query: { queryKey, enabled: owner, gcTime: 0, refetchInterval: 60000, refetchOnMount: "always", refetchOnWindowFocus: "always" },
  });
  const update = useUpdateMembershipReviewEmailPreference();
  if (!owner) return null;
  return <section className="rounded-2xl border border-border bg-card p-6" aria-labelledby="review-email-title">
    <h2 id="review-email-title" className="font-serif text-2xl">Owner outage emails</h2>
    <p className="mt-2 text-sm text-muted-foreground">Optional service-outage emails go to your verified primary account email through Resend, even while you are signed out. They include a private review link, never member identities or payment details. This does not subscribe you to marketing.</p>
    {preference.isError ? <p role="alert" className="mt-3 text-destructive">Email preferences could not be checked. Try again later.</p>
      : preference.isPending ? <p className="mt-3">Checking email preferences…</p>
        : <>
          <p className="mt-3" role="status">Outage emails are {preference.data?.enabled ? "on" : "off"}.</p>
          {!preference.data?.available && <p role="alert">Email delivery needs a configured published review link.</p>}
          <Button className="mt-3" variant="outline"
            disabled={update.isPending || (!preference.data?.enabled && !preference.data?.available)}
            onClick={() => update.mutate({ data: { enabled: !preference.data?.enabled } }, {
              onSuccess: data => {
                queryClient.setQueryData(queryKey, data);
                void queryClient.invalidateQueries({ queryKey: getGetMembershipReviewEmailPreferenceQueryKey() });
              },
            })}>
            {update.isPending ? "Saving…" : preference.data?.enabled ? "Turn off outage emails" : "Enable outage emails"}
          </Button>
        </>}
    {update.isError && <p role="alert" className="mt-3 text-destructive">Your preference was not saved. Verify your primary account email and try again.</p>}
  </section>;
}