# Rebuilding Deployment Portal from Scratch

**Version:** v4.0.0

This walks through a complete rebuild of the Deployment Portal from nothing to a deployed, admin-seeded v4.0.0 instance.

---

## 0. Prerequisites

- Node 20+ installed locally (`node --version`)
- A Firebase project with:
  - Realtime Database enabled
  - Authentication (Google provider) enabled
  - Cloud Functions enabled (needs Blaze billing plan)
  - Hosting configured
- HubSpot Private App token with read scopes on your Custom Object
- Anthropic Claude API key
- Access to the Firebase Console (for manual admin seed)

---

## 1. Clone + install

```bash
git clone <repo-url> firebase-project
cd firebase-project
npm install
cd functions && npm install && cd ..
```

## 2. Configure Firebase

Edit `.firebaserc` — set your project ID:

```json
{
  "projects": { "default": "your-project-id" },
  "targets": { "your-project-id": { "hosting": { "deployment-portal-instrumental": ["your-site-id"] } } }
}
```

Edit `src/firebase.js` — update the `firebaseConfig` object with your web app's credentials from the Firebase Console.

## 3. Configure secrets

Create `functions/.env` (gitignored):

```
HUBSPOT_TOKEN=pat-na2-YOUR_TOKEN
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY
```

## 4. Deploy security rules FIRST

This matters. v4.0.0 rules forbid client-side bootstrap, so if you deploy the app before the rules you could briefly allow the old escalation path.

```bash
npx firebase-tools deploy --only database
```

## 5. Deploy Cloud Functions

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

Functions deployed:
- `scheduledHubspotSync` (cron, Tue/Fri 9am PDT)
- `manualHubspotSync` (admin-triggered)
- `applyChecklistTemplate`
- `askProjectBot` (Claude AI)
- `provisionUser` (sign-in flow)
- `adminApproveUser`, `adminDenyUser`, `adminDeleteUser`, `adminSetRole`, `adminSetProjectAccess`, `adminSetCommercialAccess`

## 6. Seed first admin manually

**Critical** — the client-side bootstrap is gone. Without this step the first sign-in will land in `pendingUsers` with no one to approve it.

See `PRE_DEPLOY_RUNBOOK_4.0.0.md` § "First admin seed" for the exact console steps.

## 7. Build + deploy hosting

```bash
npm run build
npx firebase-tools deploy --only hosting:deployment-portal-instrumental
```

## 8. First sign-in

Sign in with the Google account you seeded. The app should load, show the admin panel, and let you trigger a manual HubSpot sync.

---

## Schema reference

Top-level DB nodes:

| Node | Purpose | Write |
|---|---|---|
| `users/{uid}` | User records | Admin (via callable) + self for langPref only |
| `pendingUsers/{uid}` | External users awaiting approval | CF (`provisionUser`) |
| `access/{pid}/{uid}` | Per-project access map (external users) | Admin |
| `commercialAccess/{pid}/{uid}` | Commercial tab grants | Admin |
| `appState/projects/{pid}` | Project records (HubSpot-synced) | Admin + HubSpot CF |
| `appState/docData/{pid}` | Per-project docs, checklists, hardware override | Admin + Instrumental |
| `appState/projectOverview/{pid}` | v4.0.0 — 8-field overview | Admin + Instrumental |
| `appState/progress/{uid}` | User's UI progress state | Self |
| `appState/demandCustomTypes` | Custom hardware categories | Admin + Instrumental |
| `appState/statusMessage` | Admin-broadcast banner | Admin |
| `auditLog/{id}` | Audit trail | Server-only (CFs) |
| `hubspotSync/` | Sync status | Server-only |
| `hubspotPreview/` | Sync dry-run preview | Server-only, admin read |
| `_schemaVersion` | Migration sentinel | Admin |
| `_backup/` | One-shot migration backups | Admin |

## Known HubSpot property wiring (v4.0.0)

The Project Overview field "Target Build Date at Deal Close" expects `project.targetBuildDateAtDealClose` but the HubSpot property key is **not yet wired** in `functions/index.js` PROPERTIES. When the correct HubSpot internal name is known, add it to:
1. `PROPERTIES` const (around line 11)
2. The transform object (around line 150) — map to `targetBuildDateAtDealClose`

The UI already renders the field — it'll show "—" until the wiring is added.

## v4.1.0 expansion points (commented in code)

`functions/index.js` has placeholders for:
- `syncHubspotWriteback` — pushes Project Overview edits back to HubSpot (needs write scope)
- `syncHubspotFiles` — pulls HubSpot file attachments into webapp, with AI classification (needs files scope)
