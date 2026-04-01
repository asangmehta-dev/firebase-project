# Deployment Portal

A React 18 web application for managing multi-party hardware deployment projects. Built for Instrumental to coordinate documentation, milestones, and program details across four stakeholder groups: Instrumental, Systems Integrator (SI), Customer, and Contract Manufacturer (CM).

---

## Live URL

**Primary:** https://deployment-portal-instrumental.web.app/
**Legacy (Cloud Run + IAP):** https://deployment-portal-901459055521.us-central1.run.app/

---

## Features

- **Multi-party access control** — Role-based views for Instrumental, SI, Customer, and CM parties
- **Project overview dashboard** — Per-party folder/document counts and milestone progress bars
- **Checklist milestones** — OK2Contract, OK2Ship, OK2Build with checklists, signatures, and linked resources
- **Program Details** — Task and milestone timeline with drag-to-reorder
- **Customer dashboard** — Station count and key milestone dates pulled from Program Details
- **Document management** — Upload links and PDFs per folder, with per-document language tagging
- **Training section** — White / Blue / Black Belt training materials per party
- **Admin panel** — User approval, role management, restricted folder access grants
- **Multi-language UI** — English, Español, Tiếng Việt, 繁體中文, 简体中文
- **Site status banner** — Admin-editable broadcast message shown to all users
- **Inline editing** — Admins can edit milestone descriptions and checklist labels in place

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite |
| Database | Firebase Realtime Database |
| Auth | Firebase Authentication (Google OAuth) |
| Hosting | Firebase Hosting |
| Legacy hosting | Docker + Nginx on Google Cloud Run (with IAP) |
| Styles | Inline styles only (no CSS files) |

---

## Project Structure

```
firebase-project/
├── src/
│   ├── App.jsx          # Entire application (single file)
│   ├── main.jsx         # React entry point
│   └── firebase.js      # Firebase SDK init
├── public/
├── firebase.json        # Firebase Hosting config
├── .firebaserc          # Firebase project + hosting target
├── database.rules.json  # Firebase Realtime Database security rules
├── Dockerfile           # For Cloud Run deployment
├── nginx.conf           # Nginx config for Docker container
├── vite.config.js
└── package.json
```

---

## Local Development

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev
```

---

## Deployment

### Firebase Hosting (primary)

```bash
npm run build
npx firebase-tools deploy --only hosting:deployment-portal-instrumental
```

### Cloud Run (legacy — keeps IAP protection)

```bash
docker build -t gcr.io/deploymentportal-5ec3a/deployment-portal .
docker push gcr.io/deploymentportal-5ec3a/deployment-portal
gcloud run deploy deployment-portal \
  --image gcr.io/deploymentportal-5ec3a/deployment-portal \
  --platform managed \
  --region us-central1
```

### One-time Firebase Hosting setup (already done)

```bash
npx firebase-tools login
npx firebase-tools hosting:sites:create deployment-portal-instrumental
npx firebase-tools target:apply hosting deployment-portal-instrumental deployment-portal-instrumental
```

---

## Access Control

| Role | Who | Access |
|------|-----|--------|
| SuperAdmin | One designated user (`superAdmin: true` in DB) | All admin powers + can promote others to admin |
| Admin | Explicitly granted by SuperAdmin | Full read/write, user management, all parties |
| User — Instrumental | Manually approved, `partyId: instrumental` | Overview + Instrumental docs |
| User — Customer | Manually approved, `partyId: customer` | Overview + Customer docs |
| User — SI | Manually approved, `partyId: si` | SI docs only |
| User — CM | Manually approved, `partyId: cm` | CM docs only |

New users sign in with Google and land in a pending queue until an admin approves them and assigns a party.

---

## Firebase Project

**Project ID:** `deploymentportal-5ec3a`
**Hosting site:** `deployment-portal-instrumental`
**Database:** Firebase Realtime Database (default)

---

## Version History

| Version | Description |
|---------|-------------|
| v2.0.0 | Baseline — multi-party portal with milestones, documents, training, admin panel |
| v2.1.0 | Firebase Hosting URL, multi-language UI, Instrumental/Customer dashboards, milestone % progress, inline editing |
| v2.1.1 | Chronological milestone sort, drag-to-reorder for Program Details and Checklist Milestones |
| v2.2.0 | Language dropdown moved to sidebar bottom, clickable party cards, item count fix, superAdmin role, @instrumental.com no longer auto-admin |
| v2.2.1 | Fixed broken IIFE in overview party cards — non-admin users can only navigate to their own party |

---

## Security

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for a full security assessment.
