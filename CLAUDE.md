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
