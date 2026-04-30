#!/usr/bin/env node
/**
 * One-time upload: Deployment Requirement master docs → Firebase Storage
 * Usage:  node scripts/upload_deployment_requirements.js
 * Prereq: npx firebase-tools login (authenticate first)
 *
 * Source files must exist at: ~/Desktop/External - Deployment Requirements/
 * Uploads to: gs://deploymentportal-5ec3a.appspot.com/templates/deployment_requirements/
 */

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

// Init with application default credentials (firebase-tools login sets these up)
admin.initializeApp({ storageBucket: "deploymentportal-5ec3a.appspot.com" });
const bucket = admin.storage().bucket();

const SRC_DIR = path.join(process.env.HOME, "Desktop", "External - Deployment Requirements");
const DEST_PREFIX = "templates/deployment_requirements";

const FILES = [
  "3 Self-Deploy_Main Installation Document - 250708.pdf",
  "Instrumental Internet Requirements.pdf",
  "Instrumental Station Space Requirements.pdf",
  "MES Questionnaire v4.pdf",
  "OPS-00003_Rev 00_Instrumental Network Requirements.pdf",
  "OPS-00004_Rev01_INST - Facility Requirements Intro Slides.pptx",
  "PWR-APAC-2026.1_SiteReadinessSpec.pdf",
  "PWR-EU-2026.1_SiteReadinessSpec.pdf",
  "PWR-US-2026.2_SiteReadinessSpec.pdf",
  "Regional_Power_Slides.pptx",
];

const MIME_MAP = {
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function upload() {
  console.log(`Source: ${SRC_DIR}`);
  console.log(`Destination bucket prefix: ${DEST_PREFIX}\n`);

  let ok = 0, fail = 0;
  for (const filename of FILES) {
    const localPath = path.join(SRC_DIR, filename);
    const destPath = `${DEST_PREFIX}/${filename}`;
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_MAP[ext] || "application/octet-stream";

    if (!fs.existsSync(localPath)) {
      console.error(`  MISSING  ${filename}`);
      fail++;
      continue;
    }
    try {
      await bucket.upload(localPath, {
        destination: destPath,
        metadata: { contentType, cacheControl: "public, max-age=31536000" },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/deploymentportal-5ec3a.appspot.com/o/${encodeURIComponent(destPath)}?alt=media`;
      console.log(`  OK  ${filename}`);
      console.log(`      ${url}`);
      ok++;
    } catch (e) {
      console.error(`  FAIL  ${filename}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} uploaded, ${fail} failed.`);
  if (fail === 0) console.log("All files uploaded. The deployment requirements folder will now work for all users.");
}

upload().catch(e => { console.error(e); process.exit(1); });
