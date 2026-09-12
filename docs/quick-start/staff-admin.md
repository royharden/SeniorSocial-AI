# LARGE-PRINT STAFF AND ADMIN GUIDE

## Start safely

1. Sign in with your own account.
2. Ask the organiser to confirm your organisation and role if unsure; this page does not show your signed-in identity.
3. Never use another person’s account.
4. Use only the information needed for your work.

## Work the human queues

1. Open the site's `/admin` address: **Staff dashboard**.
2. Under **Work queues**, read **Priority assistance**, **Rides**, **Moderation**, or **Translation review**.
3. If you see **Could not load this section.**, ask the service organiser for help.

These queue panels show status. They do not open original records or offer
ride, assistance, or moderation decision buttons in this build.
Those actions have APIs; use your approved staff workflow with the organiser's help.
Do not treat a displayed status as proof that you saved a decision.
Open `/translate` for the translation workbench and human-authored drafts.

AI suggestions are advisory. Staff and admins make decisions. A translation draft needs a qualified human reviewer and must still match the current source version.

## When AI is unavailable

- Directory search remains available.
- Reports still reach the human moderation queue.
- Assistance keeps the resident’s own words.
- Intake uses rules-based routing.
- Translation accepts human-authored drafts.
- Staff read the raw record instead of a summary.

Do not turn AI back on merely to finish a person’s task.

## Feature flags

There is no feature-flag control screen in this build. Authorized operators
use the admin flag API, which requires a scope and reason. Ask your operator
to verify the saved flag, audit record, and ordinary non-AI path.

A feature flag never replaces an authorization check.
