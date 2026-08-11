# Collaboration Guide for Sneha

## One-Time Setup

1. Install Claude Code (if working with AI-assisted development):
   ```
   npm install -g @anthropic-ai/claude-code
   ```

2. Clone the repo and install dependencies:
   ```
   git clone <repo-url>
   cd firebase-project
   npm install
   cd functions && npm install && cd ..
   ```

3. Log in to Firebase:
   ```
   npx firebase-tools login
   ```

## IAM Access

Asang needs to grant you `roles/firebase.admin` on project `deploymentportal-5ec3a`:

> Google Cloud Console → IAM & Admin → IAM → Add Principal → enter your Google account email → Role: **Firebase Admin** → Save

## Branching Rules

- **Always** create a feature branch before making any changes:
  ```
  git checkout -b alek/<feature-name>
  ```
- **Never** push directly to `main`.
- Open a pull request and request a review from Asang before merging.

## Before Each Session

Sync with the latest main to avoid conflicts:

```
git fetch origin
git rebase origin/main
```

## Preview Deployments

Deploy to a named preview channel (does not affect production):

```
npx firebase-tools hosting:channel:deploy alek-<feature-name> --only deployment-portal-instrumental
```

The command will print a preview URL you can share for review.

## Firebase Data Safety

- Firebase Realtime Database is **last-write-wins** on the same path.
- If you and Asang are both editing data for the same project simultaneously, writes can overwrite each other silently.
- **Communicate before editing the same project's records at the same time.**
- For new features that write to DB, use a dedicated sub-path (e.g., `appState/siTracker/<pid>/...`) to avoid collisions with existing data.

## Access

You have full admin access. Once you sign up at the app with your `@instrumental.com` email, you'll have immediate access to all views including **🔒 All SI Projects** — no role promotion needed.

---

# UX Standards

> Full guide: [UX_STANDARDS.md](UX_STANDARDS.md)

Apply these standards to all UI work in this project. The SI Deployment Portal is an **internal tool** (small CX team, desktop-primary) — treat it as **prototype tier** for `[SCALE]` items. All `[MUST]` items are still non-negotiable; skipping any requires explicit user sign-off noted in the completion summary.

**Current known gaps (do not regress; fix opportunistically):**
- No responsive breakpoints — inline px styles throughout; mobile layout is not supported (accepted limitation: desktop-only team)
- Firebase write operations do not disable buttons while pending (duplicate submission risk)
- No loading indicators while Firebase data is fetching
- Slide-out open/close does not trap or restore focus

**Fixed (do not revert):**
- Light theme muted text colors bumped to `#475569` / `#64748B` — WCAG AA compliant
- All theme toggle buttons have `aria-label` + `title`; AI button has `aria-label` + `aria-expanded`
- `SITabBoundary` error boundary wraps Timeline, Kanban, Meeting tabs; `SIDrillBoundary` wraps drill-in
- Focus moves to "← Back to Dashboard" button on drill-in navigation
- `*:focus-visible` global focus ring added in `index.html`
- `prefers-reduced-motion` global suppression added in `index.html`
- All 7 unguarded delete functions have `window.confirm()` guard
- Blocker and action item delete buttons restructured: small underlined "delete" text at bottom-right of each card (hard to accidentally click); confirm required
- `aria-label` added to all close `×` buttons in modals and panels
- `aria-label` added to delete buttons with only `title` attribute
- Health status dot gets `title` + `aria-label` from `HEALTH_LABELS`
- `siTracker` + `siProjects` `onValue` subscriptions now have error callbacks
- `aria-current="page"` added to all main nav buttons; `aria-expanded` on sub-nav toggle

---

# QA & Regression Prevention Rules

> Full guide: [QA_GUIDE.md](QA_GUIDE.md)

## Mandatory pre-deploy checklist (functions)

Before running `firebase deploy --only functions`, ALWAYS verify:

```bash
grep "^[A-Z]" functions/.env | cut -d= -f1
# Must list ALL of:
#   ANTHROPIC_API_KEY
#   HUBSPOT_TOKEN
```

**Never deploy functions if any required key is missing.** Stop and resolve before proceeding.

## Mandatory pre-change checklist

1. Understand what the change touches — read the relevant code first.
2. Identify every behavior that could be affected, not just the happy path.
3. State the risk before editing, not after.

## Mandatory post-change checklist

After every code change, before reporting done:

1. Run `npm run build` — must pass clean.
2. Manually verify the changed feature still works.
3. Explicitly check that adjacent features are not broken.
4. For functions deploys: re-verify `functions/.env` has all keys.

## Change discipline

- Make the smallest change necessary — never refactor unrelated code.
- Search for every call site before modifying shared code.
- Preserve existing behavior unless explicitly asked to change it.

## Completion report format

Every completed task must include:
- **Files changed**
- **Behavior changed**
- **Commands run and their results**
- **Remaining risks**
