# TEBM iPhone App: Apple Developer Conversation Handoff

Prepared for sharing with Claude. This is a compiled Markdown record of the relevant conversation, beginning with the user's announcement of Apple Developer Program approval. It is **not** an export of Replit's internal chat data or hidden instructions. The opening user question was preserved from the available conversation summary; the subsequent exchange is reproduced from the visible conversation.

## Current decisions and context for Claude

- The user has been approved for the Apple Developer Program and is considering an iPhone app for The Elevated Beauty Method (TEBM).
- The intended first release is for paying members of **The Elevated Method** (Tier 2). The free **Beauty Method** (Tier 1) can remain on the website rather than being built into the first iPhone release.
- The assistant's recommendation was a free-to-download app in which new members can subscribe through Apple in-app purchase and existing paid web members can sign in without paying again, using a shared membership-access system. This is a recommendation, **not a final user decision** about purchase channels.
- Important correction: An existing-web-members-only app is **not automatically exempt** from Apple's in-app purchase requirements for digital features. Apple's multiplatform rule generally permits previously purchased access when the same content/subscription/features are also available through in-app purchase, subject to exceptions that should not be assumed to apply to TEBM. US-storefront external-purchase-link rules differ from other storefronts.
- **The only currently confirmed Founding Member rules** are (1) the lowest possible pricing stays locked in permanently while the member maintains a member account in good standing, and (2) Founding Member availability is limited to **50**. Do not repeat older claims that cancellation automatically ends the founding rate or that a failed payment definitely preserves it. “Good standing” has not yet been defined.
- Earlier project documents record a $24/month founding rate and $48/month standard rate for The Elevated Method. The latest user message clarified the **rules**, not a new price. Confirm final cross-channel prices and founding-offer setup before implementation.
- If enrollment happens on both the website and iPhone, coordinate founding eligibility and the 50 available places across both channels; prevent accidental duplicate subscriptions. The exact enrollment and account-status policies remain to be decided.
- No mobile app was built as part of this discussion. The project guidance was updated to reflect the two current Founding Member rules and supersede contradictory older continuity language.

## Conversation

### 1. Before scoping the app

**User:** “I have been approved for the Apple Developer Program. Before we begin scoping out the build for TEBM's app, what do I need to do to ensure a seamless launch?”

**Assistant:**

Congratulations. Apple Developer Program approval is the first step; the smoothest launch will come from settling **what the first iPhone app includes** before we build it.

#### Do before scoping the app

1. **Set up App Store Connect.** Confirm the account holder, the name you want displayed as the seller, and who needs access. If TEBM will sell subscriptions in the app, complete Apple’s Paid Apps Agreement, tax, and banking information early. [Apple’s setup workflow](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow)
2. **Decide the first-release offer.** TEBM’s current launch plan is the free *Beauty Method* and paid *Elevated Method*—not the future tiers. Decide whether version one is free-only or lets people buy the paid membership on iPhone. That choice affects the architecture and review path. Digital content or features sold **inside** an iOS app generally require Apple in-app purchase; access purchased on the web needs to be planned against Apple’s multiplatform rules and storefront-specific exceptions. We should also define how the $24 founding rate, $48 standard rate, cancellations, and restored purchases work across web and app. [Apple’s payment rules](https://developer.apple.com/app-store/review/guidelines/#business)
3. **Settle account and privacy flows.** The portal already uses Clerk and offers Google sign-in. For iOS, we should check Apple’s equivalent-login requirement, provide account deletion **inside the app**, and publish a privacy policy that accurately covers account data. If MARI uses face photos or third-party AI processing, decide exactly what is uploaded, who processes it, how long it is kept, and what consent users see *before* upload. [Login and privacy rules](https://developer.apple.com/app-store/review/guidelines/#privacy) · [Account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
4. **Define a genuinely useful mobile experience.** Rather than simply wrapping the website, choose the core mobile journeys—such as the Radiant Audit, lessons and progress, and community participation. Apple says an app should offer more than a repackaged website. If community posting ships in version one, plan reporting, blocking, moderation, and a contact method from the outset. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

#### Prepare before submission

Have the final app name, icon, screenshots, description, support contact, privacy-policy URL, age-rating answers, and an App Review account that can reach paid or gated features. Run a **TestFlight** round on real iPhones, including sign-up, existing-member login, purchases if offered, account deletion, and weak-network behavior. Apple requires app-privacy disclosures in App Store Connect, and external TestFlight testing is available before release. [App privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/) · [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)

**The first decision I’d settle is whether version one launches free-only or includes the paid Elevated Method.** That determines much of the build scope and is easier to decide now than to retrofit later.

### 2. Paid-only app or both membership tiers?

**User:**

> Initially I considered that only a paying member would have the app, so version 1 would be the paid Elevated Method, not the Free membership tier 1 level.
>
> Is it easier to just build out for both or what are your thoughts?

**Assistant:**

I’d **build version one for paid Elevated Method members**, while keeping the free Beauty Method on the website. Building both experiences in the iPhone app from day one is more work: it adds free-member navigation, upgrade prompts, and more access rules without necessarily helping your first paid members.

The important distinction is **launching paid-only versus designing for paid-only forever**. I recommend:

- **Launch:** A free-to-download app that opens the full experience for Elevated Method members. The website remains the free discovery and sign-up path.
- **Build underneath:** One shared account and membership-access system that recognizes free and paid members. That makes a free in-app tier possible later without rebuilding the app.
- **Avoid double payment:** Existing paid web members should be able to sign in and receive their access. If people can subscribe through the iPhone app, we’ll also need to plan Apple in-app purchase, restoration, and how the founding rate works across purchase channels.

This keeps version one focused, but doesn’t close off a broader app later. The decision I’d make **before scoping** is whether new members can buy Elevated Method *inside the app*, or whether the first release serves existing paid members only. Apple’s rules for digital memberships make that distinction important; we should not assume a web-only checkout can simply be placed in the app.

### 3. Selling in the app versus existing members only

**User:**

> OK - I'm not sure which is better - the new members can buy The Elevated Method inside the app or whether the first release serves existing members only? What are the pros and cons in terms of Apple's rules for digital memberships?

**Assistant:**

**My recommendation: let new members buy The Elevated Method in the app, and let existing paid members sign in with the same account.** It takes more work up front, but it is the clearer App Store path for a membership that unlocks digital lessons and MARI features.

I need to qualify my earlier suggestion: **“existing members only” is not automatically an Apple-approved way to avoid in-app purchase.** Apple’s [multiplatform rule](https://developer.apple.com/app-store/review/guidelines/#business) generally permits access to a subscription bought on the web **provided that the same offering is also available as an in-app purchase**. Apple has exceptions for certain “reader” apps and free companions to paid web tools, but I would not assume TEBM’s mix of membership content and interactive MARI access qualifies.

| Approach | Advantages | Drawbacks and Apple-rule considerations |
|---|---|---|
| **Buy in app + existing-member sign-in** | New customers can join immediately; clearer path under Apple’s digital-purchase rules; existing members need not buy again. | Requires Apple subscription setup, purchase restoration, and one access system that handles both Apple and web billing. Apple’s commission affects the economics. |
| **Existing members only, no in-app purchase** | Less payment work initially; website remains the sales channel. | Greater review uncertainty for TEBM’s digital benefits, plus friction for someone who discovers the app first. We should not build on this assumption without validating that a specific Apple exception applies. |

There is a **US-storefront allowance for external purchase links**, but its rules differ from other storefronts; it is not a simple global substitute for planning in-app purchase. [Apple’s purchase-method rules](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase)

For TEBM, I’d scope **one paid member experience with two legitimate ways to arrive there**: subscribe through Apple in the app, or sign in with an existing paid web membership. Before building, we should decide how the **$24 founding rate and $48 standard rate** are offered on each channel, and make sure a member cannot accidentally pay twice.

### 4. Founding Member rules corrected

**User:**

> The only & current rules for the Founding Members are:
>
> - Price Lock Guarantee: Founding members secure the lowest possible pricing, which remains locked in permanently as long as they maintain a member account in good standing.
>
> - Limited Availability: the Founding Member will have a restricted capacity of 50.

**Assistant:**

Understood. The **only current Founding Member rules** are the permanent price lock while a member account remains in good standing, and a **50-member limit**.

I updated the project guidance so the older statements about cancellation and failed payments are no longer treated as policy. I have **not** defined “good standing” or assumed what happens in either case.

For the app, this means founding eligibility and the 50 places will need to stay consistent across web and iPhone sign-ups. We can decide the exact account-status rules before implementing enrollment and billing.

---

## Useful source links

- [Apple App Review Guidelines — payments, login, privacy, minimum functionality](https://developer.apple.com/app-store/review/guidelines/)
- [App Store Connect setup workflow](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow)
- [Apple account-deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [App privacy disclosures in App Store Connect](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)

Apple's policies can change. Check the latest guidelines when the app is scoped and again before submission.