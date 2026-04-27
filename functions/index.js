const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { buildProjectDetails, buildCommercialFolders } = require("./checklists");

admin.initializeApp();
const db = admin.database();

/* ═══ CONFIG ═══ */
const OBJECT_TYPE = "2-39524389";
const PROPERTIES = [
  "project_name", "hs_object_id", "app_project_id__c", "number_of_stations__c",
  "company_codename", "hs_pipeline", "hs_pipeline_stage",
  "associated_cs_program_id_last", "deploy_location_from_opportunity__c",
  "deploy_region__c", "deployzen_datazen_tpm", "hde__hardware_design_engineer_",
  "standard_cameras", "number_of_cameras__c", "regular_lenses", "tc_lense",
  "type_of_lenses", "led_light_controllers", "standard_station_frames",
  "large_station_frames", "computers", "monitor_screens", "barcode_scanners",
  "station_bom_details_hde", "hs_createdate", "hs_lastmodifieddate",
].join(",");

const PIPELINES = {
  "680801112": { label: "Hardware Deployment Pipeline", order: 0 },
  "680446891": { label: "Data Source Deployment Pipeline", order: 1 },
  "679446421": { label: "MES Integration Pipeline", order: 2 },
  "682405760": { label: "Station Return", order: 3 },
  "684527408": { label: "Image Source Deployment Pipeline", order: 4 },
  "1919898345": { label: "Data Analytics", order: 5 },
  // v4.0.1 — SI Partner Deployment pipeline.
  "2206979797": { label: "SI Partner Deployment", order: 6 },
};

// v4.0.1 — SI Partner Deployment pipeline ID + stage mapping.
const SI_PARTNER_PIPELINE_ID = "2206979797";
// Map: HubSpot stage ID → SI Kanban stage key (sird|dfm|quote|po|build|fat|sat|live)
const SI_PARTNER_STAGE_MAP = {
  "3539976891": "sird",
  "3539976892": "dfm",
  "3545524981": "quote",
  "3545524982": "po",
  "3545524983": "build",
  "3545524984": "fat",
  "3545524985": "sat",
  "3545525946": "live",
};

const STAGES = {
  "1053337914": { label: "Deal SG6/7 Pipeline", closed: false, order: 0 },
  "997715736":  { label: "Kickoff", closed: false, order: 1 },
  "999736172":  { label: "Scope Verify w/Customer", closed: false, order: 2 },
  "1067748453": { label: "Design Queue", closed: false, order: 3 },
  "997715738":  { label: "InProgress Station/Nest Design", closed: false, order: 4 },
  "997715739":  { label: "Awaiting Nest Approval", closed: false, order: 5 },
  "997715740":  { label: "Station Configuration", closed: false, order: 6 },
  "997715741":  { label: "Shipment & Logistics", closed: false, order: 7 },
  "997715742":  { label: "Setup & Verification", closed: false, order: 8 },
  "997715743":  { label: "First Image in App", closed: false, order: 9 },
  "997715737":  { label: "Complete-Project/Deployment", closed: true, order: 10 },
  "1053255817": { label: "Cancel-Project/Deployment", closed: true, order: 11 },
  "3118657221": { label: "Pre-Deal Lost", closed: true, order: 12 },
  "997709588": { label: "Scope Reviewed w/Customer", closed: false, order: 0 },
  "997549163": { label: "Scope Validated", closed: false, order: 1 },
  "997549164": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2 },
  "997549165": { label: "Sample Data Received", closed: false, order: 3 },
  "997549166": { label: "Test Data Uploaded", closed: false, order: 4 },
  "997549167": { label: "Test Data Verified", closed: false, order: 5 },
  "997549168": { label: "Data Upload to Final Project", closed: false, order: 6 },
  "997549169": { label: "Data Upload Automated", closed: false, order: 7 },
  "997709589": { label: "Project Complete", closed: true, order: 8 },
  "997780264": { label: "MES Questionnaire Share w/CM", closed: false, order: 0 },
  "997677454": { label: "CM MES Spec Received", closed: false, order: 1 },
  "997677455": { label: "CM MES API Validated", closed: false, order: 2 },
  "997677456": { label: "MES Implementation", closed: false, order: 3 },
  "997677457": { label: "MES Test", closed: false, order: 4 },
  "997677458": { label: "MES Routing Enforcement", closed: false, order: 5 },
  "997780265": { label: "Project Complete", closed: true, order: 6 },
  "999818661": { label: "Send Shipment & Packaging Info to CM", closed: false, order: 0 },
  "999761080": { label: "Station Shipped to Inst", closed: false, order: 1 },
  "999761081": { label: "Station Components Verified", closed: false, order: 2 },
  "999761152": { label: "Station Kits Returned", closed: false, order: 3 },
  "999818662": { label: "Project Complete", closed: true, order: 4 },
  "1002465694": { label: "Scope Reviewed w/Customer", closed: false, order: 0 },
  "1002419978": { label: "Scope Validated", closed: false, order: 1 },
  "1002419979": { label: "S3 Bucket & Test PRJ Creation", closed: false, order: 2 },
  "1002419980": { label: "Sample Data Received", closed: false, order: 3 },
  "1002419981": { label: "Test Data Uploaded", closed: false, order: 4 },
  "1002419982": { label: "Test Data Verified", closed: false, order: 5 },
  "1002419983": { label: "Data Upload to Final Project", closed: false, order: 6 },
  "1002419984": { label: "Data Upload Automated", closed: false, order: 7 },
  "1002465695": { label: "Project Complete", closed: true, order: 8 },
  "3040887544": { label: "Ideation", closed: false, order: 0 },
  "3039176431": { label: "Kick-off", closed: false, order: 1 },
  "3039176432": { label: "In Progress", closed: false, order: 2 },
  "3040887545": { label: "Completed", closed: true, order: 3 },
  // v4.0.1 — SI Partner Deployment pipeline stages
  "3539976891": { label: "SIRD",  closed: false, order: 0 },
  "3539976892": { label: "DFM",   closed: false, order: 1 },
  "3545524981": { label: "Quote", closed: false, order: 2 },
  "3545524982": { label: "PO",    closed: false, order: 3 },
  "3545524983": { label: "Build", closed: false, order: 4 },
  "3545524984": { label: "FAT",   closed: false, order: 5 },
  "3545524985": { label: "SAT",   closed: false, order: 6 },
  "3545525946": { label: "Live",  closed: false, order: 7 },
};

const CODENAME_MAP = {
  "allsorts": "Aescape", "altoids": "Alta Motors", "toffee/rolo parent": "Amazon",
  "abba-zaba": "Anduril Industries", "atomic fireball": "Apple", "almond joy": "Arista",
  "andes": "August, Inc.", "aero": "Axon", "bonbon": "Backbone", "baby ruth": "Bang & Olufsen",
  "starburst": "Block, Inc.", "butterfingers": "Bose", "coffee crisp": "Carbon Revolution",
  "cachou": "Cerebras Systems", "crunch bar": "ChargePoint", "mamba": "Meraki / CISCO",
  "cherry pie": "Cora (Wisk Aero)", "cotton candy": "Cruise Automation", "donut": "DJI",
  "eclipse": "Eargo", "eclair": "Ecobee", "toffee": "Eero", "espresso": "Empatica",
  "xigua": "Exponent", "fanta": "F5", "fortune cookie": "Fitbit", "flan": "FLIR Systems",
  "flanby": "Flock Safety", "fruit stripe": "Fossil", "gummybear": "Glowforge",
  "gobstoppers": "Google", "gumdrop": "GoPro", "gelato": "Gridware", "haribo": "Henkel",
  "hbo": "Honeywell", "hot tamale": "Humane", "icee": "Intuitive Surgical",
  "jelly belly": "Jabil", "juicy fruit": "Juul Labs", "keebler": "Keysight Technologies",
  "key lime pie": "Kitty Hawk", "knish": "KNS", "lot 100": "L3Harris Technologies",
  "airheads": "Lab 126 (Amazon)", "life savers": "Lenovo", "licorice": "Light",
  "lemondrop": "Logitech", "laffy taffy": "Lutron Electronics", "m&m's": "Mabe",
  "milkyway": "Meraki (POC)", "fundip": "Meta", "mars": "Microsoft", "mike n ike": "Microtek",
  "mentos": "Motorola Mobility", "mint": "Motorola Solutions", "nilla": "Nest",
  "necco": "Netgear", "forrest gump": "Nike", "nougat": "Nokia / Withings",
  "nerds": "NVIDIA Data Centers", "oreo": "Oculus", "otter pops": "Opal Camera",
  "opera": "OURA", "orbit": "Owletcare", "pez": "P2i", "kitkat": "Pearl Auto",
  "peeps": "Peloton", "pop rocks": "Poly", "pop tarts": "Puffco",
  "quality street": "QSC Audio Products", "reese's": "Razer", "rolo": "Ring",
  "razzle": "Rocket EMS", "smarties": "Seacomp", "skor": "Sesame AI", "snickers": "Snap",
  "sweetarts": "Softmatter", "sour patch kids": "SolarEdge",
  "spearmint": "Spellman High Voltage", "spree": "Spire", "sunnyhills": "Supermicro",
  "toblerone": "Tesla", "twizzlers": "Toast", "tribala": "Tractian",
  "violet crumble": "Valve", "vanilla": "Velodyne", "viennetta": "View",
  "warheads": "Whirlpool", "whoppers": "Whoop", "skittles": "Xylem (Sensus)",
  "zingers": "Zebra Technologies", "zero": "ZT Systems", "zots": "Zwift",
};

/* ═══ HELPERS ═══ */
function decodeCodename(codename) {
  if (!codename) return null;
  return CODENAME_MAP[codename.trim().toLowerCase()] || codename;
}

function extractStationsFromName(name) {
  if (!name) return null;
  const patterns = [/(\d+)\s*station\s*kit/i, /(\d+)\s*stations?/i, /(\d+)st\b/i, /\bx(\d+)\b/i];
  for (const p of patterns) {
    const m = name.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function mapHubspotToProject(obj) {
  const p = obj.properties || {};
  const stageId = p.hs_pipeline_stage;
  const pipelineId = p.hs_pipeline;
  const stage = STAGES[stageId] || {};
  const pipeline = PIPELINES[pipelineId] || {};
  const name = p.project_name || `HubSpot Project ${obj.id}`;
  const codename = p.company_codename || null;
  const customer = decodeCodename(codename) || "";
  const stationsFromField = p.number_of_stations__c ? parseInt(p.number_of_stations__c) : null;
  const stationsFromName = extractStationsFromName(name);
  const stations = stationsFromField || stationsFromName || 0;
  // v4.0.1 — SI flag now combines: name contains [SI] OR project lives in SI Partner Deployment pipeline.
  const isFromSiPartner = pipelineId === SI_PARTNER_PIPELINE_ID;
  const isSI = isFromSiPartner || /\[SI\]/i.test(name);
  // siStage is set ONLY for projects in SI Partner Deployment pipeline (drives the Kanban).
  // Falls back to "sird" if a stage ID isn't in the map yet.
  const siStage = isFromSiPartner ? (SI_PARTNER_STAGE_MAP[stageId] || "sird") : null;
  const isClosed = stage.closed === true;

  return {
    id: `hs_${obj.id}`,
    hubspotId: obj.id,
    name,
    customer,
    codename,
    appProjectId: p.app_project_id__c || null,
    stations,
    isSI,
    siStage,
    hubspotPipelineId: pipelineId || null,
    hubspotPipelineLabel: pipeline.label || null,
    hubspotStageId: stageId || null,
    hubspotStageLabel: stage.label || null,
    hubspotStageClosed: isClosed,
    hubspotStageOrder: stage.order ?? 99,
    csProgramId: p.associated_cs_program_id_last || null,
    deployLocation: p.deploy_location_from_opportunity__c || null,
    deployRegion: p.deploy_region__c || null,
    tpm: p.deployzen_datazen_tpm || null,
    hde: p.hde__hardware_design_engineer_ || null,
    hardware: {
      cameras: p.standard_cameras || p.number_of_cameras__c || null,
      lenses: p.regular_lenses || null,
      tcLense: p.tc_lense || null,
      lensType: p.type_of_lenses || null,
      ledControllers: p.led_light_controllers || null,
      standardFrames: p.standard_station_frames || null,
      largeFrames: p.large_station_frames || null,
      computers: p.computers || null,
      monitors: p.monitor_screens || null,
      barcodeScanner: p.barcode_scanners || null,
      bomDetails: p.station_bom_details_hde || null,
    },
    status: isClosed ? "inactive" : "active",
    si: isSI ? "" : "N/A",
    cm: "",
    partyNames: {
      instrumental: "Instrumental",
      si: isSI ? "" : "N/A",
      customer: customer || "",
      cm: "",
    },
    hubspotCreatedAt: p.hs_createdate || null,
    hubspotUpdatedAt: p.hs_lastmodifieddate || null,
    syncedAt: new Date().toISOString(),
    source: "hubspot",
  };
}

async function fetchAllHubspotObjects(token) {
  const all = [];
  let after = null;
  do {
    const url = `https://api.hubapi.com/crm/v3/objects/${OBJECT_TYPE}?limit=100&properties=${PROPERTIES}${after ? `&after=${after}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HubSpot API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    all.push(...(data.results || []));
    after = data.paging?.next?.after || null;
  } while (after);
  return all;
}

/* ═══ SYNC LOG — v4.0.1: append-only history of all syncs ═══ */
async function writeSyncLogEntry(entry) {
  const id = `${entry.startedAt}_${Math.random().toString(36).slice(2, 7)}`;
  await db.ref(`hubspotSync/log/${id}`).set(entry);
}

/* ═══ CORE SYNC LOGIC ═══ */
// syncCtx: { type: "manual" | "scheduled", actorUid?: string, actorEmail?: string }
async function runSync(token, commit, syncCtx) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const ctx = syncCtx || { type: "scheduled" };
  await db.ref("hubspotSync/status").set({ state: "running", startedAt, type: ctx.type });

  try {
    const objects = await fetchAllHubspotObjects(token);
    const incoming = objects.map(mapHubspotToProject);

    // Load existing projects to detect new vs updated. DB may have legacy array shape or v3.1.0 object shape.
    const snap = await db.ref("appState/projects").once("value");
    const existing = snap.val() || {};
    const existingArr = Array.isArray(existing) ? existing : Object.values(existing);
    const existingByHsId = {};
    existingArr.forEach(p => { if (p && p.hubspotId) existingByHsId[p.hubspotId] = p; });

    const newProjects = incoming.filter(p => !existingByHsId[p.hubspotId]);
    const updatedProjects = incoming.filter(p => !!existingByHsId[p.hubspotId]);

    const summary = {
      total: incoming.length,
      newCount: newProjects.length,
      updatedCount: updatedProjects.length,
      syncedAt: startedAt,
    };

    if (!commit) {
      // Preview mode — write to hubspotPreview only
      const previewMap = {};
      incoming.forEach(p => { previewMap[p.hubspotId] = p; });
      await db.ref("hubspotPreview").set({ projects: previewMap, summary });
      await db.ref("hubspotSync/status").set({ state: "preview_ready", ...summary });
      await writeSyncLogEntry({
        startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
        type: ctx.type, mode: "preview",
        actorUid: ctx.actorUid || "system", actorEmail: ctx.actorEmail || null,
        state: "preview_ready", total: incoming.length, newCount: newProjects.length, updatedCount: updatedProjects.length, error: null,
      });
      return { success: true, preview: true, ...summary };
    }

    // Apply mode — merge into appState/projects and create checklist templates
    const merged = [...existingArr];

    // Update existing
    for (const incoming_p of updatedProjects) {
      const idx = merged.findIndex(p => p.hubspotId === incoming_p.hubspotId);
      if (idx >= 0) {
        // Preserve manually-set fields, overwrite HubSpot fields
        merged[idx] = {
          ...merged[idx],
          name: incoming_p.name,
          customer: incoming_p.customer,
          codename: incoming_p.codename,
          appProjectId: incoming_p.appProjectId,
          stations: incoming_p.stations || merged[idx].stations,
          isSI: incoming_p.isSI,
          // v4.0.1: only overwrite siStage when the incoming project is from the SI Partner pipeline.
          // Hardware Deployment [SI] projects shouldn't have their siStage clobbered to null.
          siStage: incoming_p.siStage != null ? incoming_p.siStage : merged[idx].siStage,
          hubspotPipelineId: incoming_p.hubspotPipelineId,
          hubspotPipelineLabel: incoming_p.hubspotPipelineLabel,
          hubspotStageId: incoming_p.hubspotStageId,
          hubspotStageLabel: incoming_p.hubspotStageLabel,
          hubspotStageClosed: incoming_p.hubspotStageClosed,
          hubspotStageOrder: incoming_p.hubspotStageOrder,
          status: incoming_p.status,
          hardware: incoming_p.hardware,
          syncedAt: incoming_p.syncedAt,
        };
      }
    }

    // Add new projects
    for (const np of newProjects) {
      merged.push(np);
    }

    // Write as object keyed by project ID (v3.1.0 schema — enables per-project DB rules)
    const mergedObj = {};
    merged.forEach(p => { if (p && p.id) mergedObj[p.id] = p; });
    await db.ref("appState/projects").set(mergedObj);
    // Ensure schema version is set so the app-side migration can skip
    await db.ref("_schemaVersion").set("v3.2.0");

    // Create project templates for new projects (v3.2.0 unified structure)
    const docDataSnap = await db.ref("appState/docData").once("value");
    const docData = docDataSnap.val() || {};

    for (const np of newProjects) {
      const pid = np.id;
      if (!docData[pid]) {
        docData[pid] = {};
      }
      if (!docData[pid].projectDetails) {
        docData[pid].projectDetails = buildProjectDetails(np.isSI);
      }
      if (!docData[pid].commercial) {
        docData[pid].commercial = buildCommercialFolders();
      }
    }

    if (newProjects.length > 0) {
      await db.ref("appState/docData").set(docData);
    }

    await db.ref("hubspotPreview").set(null);
    await db.ref("hubspotSync/status").set({ state: "success", ...summary });
    await writeSyncLogEntry({
      startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
      type: ctx.type, mode: "apply",
      actorUid: ctx.actorUid || "system", actorEmail: ctx.actorEmail || null,
      state: "success", total: incoming.length, newCount: newProjects.length, updatedCount: updatedProjects.length, error: null,
    });

    return { success: true, preview: false, ...summary };
  } catch (err) {
    console.error("HubSpot sync error:", err);
    await db.ref("hubspotSync/status").set({ state: "error", error: err.message, startedAt });
    await writeSyncLogEntry({
      startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
      type: (syncCtx || {}).type || "scheduled", mode: commit ? "apply" : "preview",
      actorUid: (syncCtx || {}).actorUid || "system", actorEmail: (syncCtx || {}).actorEmail || null,
      state: "error", total: 0, newCount: 0, updatedCount: 0, error: String(err.message || err).slice(0, 500),
    });
    throw err;
  }
}

/* ═══ APPLY CHECKLIST TEMPLATE to existing project (v3.2.0 unified structure) ═══ */
async function applyChecklistToProject(projectId, isSI) {
  const snap = await db.ref(`appState/docData/${projectId}/projectDetails`).once("value");
  const existing = snap.val() || [];
  const existingArr = Array.isArray(existing) ? existing : Object.values(existing);

  const hasChecklist = existingArr.some(c => c.type === "checklist");
  if (hasChecklist) return { skipped: true, reason: "Checklist already exists" };

  const newCats = buildProjectDetails(isSI);
  // Preserve existing non-checklist categories, add checklists
  const checklistCats = newCats.filter(c => c.type === "checklist");
  const merged = [...existingArr, ...checklistCats];
  await db.ref(`appState/docData/${projectId}/projectDetails`).set(merged);

  // Also ensure commercial folders exist
  const commSnap = await db.ref(`appState/docData/${projectId}/commercial`).once("value");
  if (!commSnap.val()) {
    await db.ref(`appState/docData/${projectId}/commercial`).set(buildCommercialFolders());
  }
  return { success: true };
}

/* ═══ SCHEDULED SYNC — Tue & Fri 9am PDT (16:00 UTC) ═══ */
exports.scheduledHubspotSync = functions.pubsub
  .schedule("0 16 * * 2,5")
  .timeZone("America/Los_Angeles")
  .onRun(async () => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) { console.error("HubSpot token not configured"); return; }
    await runSync(token, true, { type: "scheduled", actorUid: "system", actorEmail: null });
  });

/* ═══ MANUAL SYNC — callable from Admin Panel ═══ */
exports.manualHubspotSync = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  if (user?.role !== "admin" && !user?.superAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admins only.");
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new functions.https.HttpsError("internal", "HubSpot token not configured.");

  const commit = data?.commit === true;
  return await runSync(token, commit, {
    type: "manual",
    actorUid: context.auth.uid,
    actorEmail: (context.auth.token?.email || user?.email || null),
  });
});

/* ═══ APPLY CHECKLIST — callable from Admin Panel ═══ */
exports.applyChecklistTemplate = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  if (user?.role !== "admin" && !user?.superAdmin) {
    throw new functions.https.HttpsError("permission-denied", "Admins only.");
  }

  const { projectId, isSI } = data || {};
  if (!projectId) throw new functions.https.HttpsError("invalid-argument", "projectId required.");

  return await applyChecklistToProject(projectId, !!isSI);
});

/* ═══ AI PROJECT BOT — v3.3.0: Claude-powered Q&A per project ═══ */
exports.askProjectBot = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  // Only Instrumental users can use the bot
  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  const email = context.auth.token?.email || "";
  if (user?.role !== "admin" && !email.endsWith("@instrumental.com")) {
    throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");
  }

  const { projectId, question, action, sectionId } = data || {};
  if (!projectId) throw new functions.https.HttpsError("invalid-argument", "projectId required.");
  if (!question && !action) throw new functions.https.HttpsError("invalid-argument", "question or action required.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured. Add ANTHROPIC_API_KEY to functions/.env");

  // Build project context from DB
  const [projSnap, docSnap] = await Promise.all([
    db.ref(`appState/projects/${projectId}`).once("value"),
    db.ref(`appState/docData/${projectId}`).once("value"),
  ]);
  const project = projSnap.val() || {};
  const docData = docSnap.val() || {};

  // Flatten project context into a readable summary for the AI
  const contextParts = [];
  contextParts.push(`Project: ${project.name || projectId}`);
  contextParts.push(`Customer: ${project.customer || "Unknown"}`);
  contextParts.push(`Status: ${project.status || "unknown"}, Stations: ${project.stations || 0}, SI Involved: ${project.isSI ? "Yes" : "No"}`);
  if (project.hubspotPipelineLabel) contextParts.push(`Pipeline: ${project.hubspotPipelineLabel}, Stage: ${project.hubspotStageLabel || "Unknown"}`);
  if (project.hardware) contextParts.push(`Hardware: ${JSON.stringify(project.hardware)}`);

  // Include checklist data
  const pdCats = docData.projectDetails || docData.instrumental || [];
  const pdArr = Array.isArray(pdCats) ? pdCats : Object.values(pdCats);
  pdArr.forEach(cat => {
    if (cat.type === "checklist" && cat.milestones) {
      contextParts.push(`\nChecklist: ${cat.name}`);
      cat.milestones.forEach(ms => {
        const activeItems = (ms.checklist || []).filter(ck => !ck.na);
        const doneCount = activeItems.filter(ck => ck.checked).length;
        contextParts.push(`  ${ms.name}: ${doneCount}/${activeItems.length} complete`);
        activeItems.forEach(ck => {
          contextParts.push(`    ${ck.checked ? "[x]" : "[ ]"} ${ck.label}${ck.ownership ? " (Owner: " + ck.ownership + ")" : ""}${ck.projectedDate ? " Due: " + ck.projectedDate : ""}${ck.actualDate ? " Done: " + ck.actualDate : ""}`);
        });
      });
    }
    if (cat.items && cat.items.length > 0) {
      contextParts.push(`\nFolder: ${cat.name} (${cat.items.length} documents)`);
      cat.items.forEach(item => contextParts.push(`  - ${item.name}${item.url ? " [" + item.url + "]" : ""}`));
    }
  });

  // Include program details
  const progData = docData._programDetails || {};
  if (progData.tasks && progData.tasks.length > 0) {
    contextParts.push(`\nProgram Tasks & Milestones:`);
    progData.tasks.forEach(t => contextParts.push(`  ${t.type === "milestone" ? "🏁" : "📋"} ${t.name} — ${t.date || "No date"}${t.endDate ? " to " + t.endDate : ""}`));
  }

  const projectContext = contextParts.join("\n");

  // Build the prompt
  let systemPrompt = `You are an AI assistant for Instrumental's Deployment Portal. You help the Customer Experience team manage deployment projects. You have access to the following project data:\n\n${projectContext}\n\nAnswer questions accurately based on this data. If information is not available in the data, say so clearly. Be concise and actionable.`;

  let userMessage = question || "";

  // Section-filling action
  if (action === "fill_section" && sectionId) {
    systemPrompt += `\n\nThe user wants you to suggest content for a section of the project. Analyze the project data and any uploaded documents to generate appropriate entries.`;
    userMessage = `Based on the project data, suggest what should be filled in for the "${sectionId}" section. Provide specific, actionable items.`;
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const answer = response.content?.[0]?.text || "No response generated.";
    return { answer, projectName: project.name };
  } catch (err) {
    console.error("AI Bot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

/* ═══ v4.0.0 SECURITY ═══ */

// Audit log writer — server-only. Rules block client writes (auditLog/.write: false).
// Shape: auditLog/{isoTs_random}: { ts, actor, action, target, meta }
async function writeAuditEntry(actor, action, target, meta) {
  const ts = new Date().toISOString();
  const id = `${ts}_${Math.random().toString(36).slice(2, 8)}`;
  await db.ref(`auditLog/${id}`).set({ ts, actor, action, target: target || null, meta: meta || null });
}

// URL validator — reject empty, non-https, javascript:, data: URIs.
function validateUrl(u) {
  if (u == null || u === "") return "";
  if (typeof u !== "string") throw new functions.https.HttpsError("invalid-argument", "URL must be a string.");
  const t = u.trim();
  if (!/^https:\/\//i.test(t)) throw new functions.https.HttpsError("invalid-argument", "URL must start with https://.");
  if (/^javascript:|^data:|^vbscript:|^file:/i.test(t)) throw new functions.https.HttpsError("invalid-argument", "Disallowed URL scheme.");
  if (t.length > 2048) throw new functions.https.HttpsError("invalid-argument", "URL too long.");
  return t;
}

async function requireAdmin(context) {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const snap = await db.ref(`users/${context.auth.uid}`).once("value");
  const u = snap.val();
  if (u?.role !== "admin") throw new functions.https.HttpsError("permission-denied", "Admins only.");
  return u;
}

/* ── provisionUser: first-time sign-in. Replaces client-side bootstrap + auto-approve. ── */
exports.provisionUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const email = (context.auth.token?.email || "").toLowerCase();
  const name = context.auth.token?.name || email;
  const photoURL = context.auth.token?.picture || null;

  // Idempotent — if user already exists, return it.
  const existing = (await db.ref(`users/${uid}`).once("value")).val();
  if (existing) return { status: "exists", user: existing };

  const isInstDomain = /@instrumental\.com$/i.test(email);
  if (isInstDomain) {
    // Auto-approve as Instrumental user (role=user, partyId=instrumental).
    // Admins must be promoted explicitly via adminSetRole by an existing admin.
    const allProj = (await db.ref("appState/projects").once("value")).val() || {};
    const projIds = Object.keys(allProj);
    const nu = {
      id: uid,
      name,
      email,
      photoURL,
      role: "user",
      partyId: "instrumental",
      projects: projIds,
      createdAt: new Date().toISOString(),
    };
    await db.ref(`users/${uid}`).set(nu);
    await writeAuditEntry(uid, "provision_instrumental", uid, { email });
    return { status: "provisioned_instrumental", user: nu };
  }

  // External user → pendingUsers for admin approval.
  const pending = { id: uid, name, email, photoURL, requestedAt: new Date().toISOString() };
  await db.ref(`pendingUsers/${uid}`).set(pending);
  await writeAuditEntry(uid, "request_access", uid, { email });
  return { status: "pending", pending };
});

/* ── Admin callables with audit logging ── */

exports.adminApproveUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { pendingId, projectIds } = data || {};
  if (!pendingId) throw new functions.https.HttpsError("invalid-argument", "pendingId required.");
  const pu = (await db.ref(`pendingUsers/${pendingId}`).once("value")).val();
  if (!pu) throw new functions.https.HttpsError("not-found", "Pending user not found.");

  const selProjIds = Array.isArray(projectIds) ? projectIds : [];
  const nu = {
    id: pu.id,
    name: pu.name,
    email: pu.email,
    photoURL: pu.photoURL || null,
    role: "user",
    partyId: "external",
    projects: selProjIds,
    createdAt: new Date().toISOString(),
  };
  await db.ref(`users/${pu.id}`).set(nu);
  const updates = {};
  selProjIds.forEach(pid => { updates[`access/${pid}/${pu.id}`] = true; });
  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  await db.ref(`pendingUsers/${pendingId}`).set(null);
  await writeAuditEntry(caller.id, "approve_user", pu.id, { email: pu.email, projectIds: selProjIds });
  return { ok: true };
});

exports.adminDenyUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { pendingId } = data || {};
  if (!pendingId) throw new functions.https.HttpsError("invalid-argument", "pendingId required.");
  const pu = (await db.ref(`pendingUsers/${pendingId}`).once("value")).val();
  await db.ref(`pendingUsers/${pendingId}`).set(null);
  await writeAuditEntry(caller.id, "deny_user", pendingId, { email: pu?.email || null });
  return { ok: true };
});

exports.adminDeleteUser = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid } = data || {};
  if (!uid) throw new functions.https.HttpsError("invalid-argument", "uid required.");
  if (uid === caller.id) throw new functions.https.HttpsError("failed-precondition", "Cannot delete self.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");

  // Sweep access maps across all projects
  const allAccess = (await db.ref("access").once("value")).val() || {};
  const accessUpdates = {};
  Object.keys(allAccess).forEach(pid => { if (allAccess[pid] && allAccess[pid][uid]) accessUpdates[`access/${pid}/${uid}`] = null; });
  const allCommercial = (await db.ref("commercialAccess").once("value")).val() || {};
  const commUpdates = {};
  Object.keys(allCommercial).forEach(pid => { if (allCommercial[pid] && allCommercial[pid][uid]) commUpdates[`commercialAccess/${pid}/${uid}`] = null; });

  const updates = { ...accessUpdates, ...commUpdates, [`users/${uid}`]: null };
  await db.ref().update(updates);
  await writeAuditEntry(caller.id, "delete_user", uid, { email: target.email, role: target.role });
  return { ok: true };
});

exports.adminSetRole = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, role } = data || {};
  if (!uid || !role) throw new functions.https.HttpsError("invalid-argument", "uid and role required.");
  if (role !== "user" && role !== "admin") throw new functions.https.HttpsError("invalid-argument", "role must be 'user' or 'admin'.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");
  if (role === "admin" && !/@instrumental\.com$/i.test((target.email || "").toLowerCase())) {
    throw new functions.https.HttpsError("failed-precondition", "Only @instrumental.com users can be admins.");
  }
  const updates = { [`users/${uid}/role`]: role };
  if (role === "admin") updates[`users/${uid}/partyId`] = "instrumental";
  await db.ref().update(updates);
  await writeAuditEntry(caller.id, "set_role", uid, { oldRole: target.role, newRole: role, email: target.email });
  return { ok: true };
});

exports.adminSetProjectAccess = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, projectId, grant } = data || {};
  if (!uid || !projectId) throw new functions.https.HttpsError("invalid-argument", "uid and projectId required.");
  const target = (await db.ref(`users/${uid}`).once("value")).val();
  if (!target) throw new functions.https.HttpsError("not-found", "User not found.");

  const nextProjects = new Set(target.projects || []);
  if (grant) nextProjects.add(projectId); else nextProjects.delete(projectId);
  const needsAccessMap = target.role !== "admin" && !/@instrumental\.com$/i.test((target.email || "").toLowerCase());

  const updates = { [`users/${uid}/projects`]: Array.from(nextProjects) };
  if (needsAccessMap) updates[`access/${projectId}/${uid}`] = grant ? true : null;
  await db.ref().update(updates);
  await writeAuditEntry(caller.id, grant ? "grant_project" : "revoke_project", uid, { projectId, email: target.email });
  return { ok: true };
});

exports.adminSetCommercialAccess = functions.https.onCall(async (data, context) => {
  const caller = await requireAdmin(context);
  const { uid, projectId, grant } = data || {};
  if (!uid || !projectId) throw new functions.https.HttpsError("invalid-argument", "uid and projectId required.");
  await db.ref(`commercialAccess/${projectId}/${uid}`).set(grant ? true : null);
  await writeAuditEntry(caller.id, grant ? "grant_commercial" : "revoke_commercial", uid, { projectId });
  return { ok: true };
});

/* ── v4.1.0 placeholders (commented until HubSpot write + files scopes arrive) ──
exports.syncHubspotWriteback = functions.https.onCall(async (data, context) => { });
exports.syncHubspotFiles = functions.https.onCall(async (data, context) => { });
*/

/* ═══ CHAT BOT — v4.0.0: conversational chat for all authed users, scoped to accessible projects ═══ */
exports.chatBot = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).once("value");
  const user = userSnap.val();
  if (!user) throw new functions.https.HttpsError("permission-denied", "User record not found.");

  const { question, history } = data || {};
  if (!question || typeof question !== "string") throw new functions.https.HttpsError("invalid-argument", "question required.");
  if (question.length > 4000) throw new functions.https.HttpsError("invalid-argument", "question too long.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured.");

  // Determine which projects this user can see.
  const isInstrumental = user.role === "admin" || user.partyId === "instrumental";
  const allProjects = (await db.ref("appState/projects").once("value")).val() || {};
  let accessibleProjects;
  if (isInstrumental) {
    accessibleProjects = Object.values(allProjects).filter(p => p);
  } else {
    const allowedIds = new Set(user.projects || []);
    accessibleProjects = Object.values(allProjects).filter(p => p && allowedIds.has(p.id));
  }

  // Build context — keep small for external users (only their projects), larger for Instrumental.
  const cap = isInstrumental ? 60 : 30;
  const lines = [];
  lines.push(`User: ${user.name} (${user.role}, ${user.partyId}). They have access to ${accessibleProjects.length} project(s).`);
  accessibleProjects.slice(0, cap).forEach(p => {
    lines.push(`• ${p.name} (${p.customer || "?"}) — pipeline: ${p.hubspotPipelineLabel || "?"}, stage: ${p.hubspotStageLabel || "?"}, status: ${p.status || "?"}, stations: ${p.stations || 0}${p.isSI ? ", SI" : ""}`);
  });

  const systemPrompt = `You are a friendly AI assistant for Instrumental's Deployment Portal. You help ${isInstrumental ? "the Customer Experience team" : "external partners (customers, SI, CM)"} with questions about their hardware deployment projects. Use the data below. If the user asks about something outside their accessible projects or beyond the data, say so politely.

ACCESSIBLE PROJECTS:
${lines.join("\n")}

Be conversational, concise, and helpful. Use the user's name (${user.name.split(" ")[0]}) occasionally. Format lists with bullets when listing multiple things.`;

  const trimmedHistory = Array.isArray(history) ? history.slice(-12).filter(m => m && m.role && m.text) : [];
  const messages = [
    ...trimmedHistory.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text).slice(0, 4000) })),
    { role: "user", content: question.trim() },
  ];

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const answer = response.content?.[0]?.text || "No response generated.";
    return { answer };
  } catch (err) {
    console.error("chatBot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

/* ═══ GLOBAL AI SEARCH/CHAT — v4.0.0: cross-project Q&A for Instrumental users ═══ */
/* Differs from askProjectBot: no projectId required; aggregates all active projects + their key data. */
exports.askGlobalBot = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");

  const userSnap = await db.ref(`users/${context.auth.uid}`).once("value");
  const user = userSnap.val();
  const email = (context.auth.token?.email || "").toLowerCase();
  if (user?.role !== "admin" && !email.endsWith("@instrumental.com")) {
    throw new functions.https.HttpsError("permission-denied", "Instrumental users only.");
  }

  const { question, history } = data || {};
  if (!question || typeof question !== "string") throw new functions.https.HttpsError("invalid-argument", "question required.");
  if (question.length > 4000) throw new functions.https.HttpsError("invalid-argument", "question too long.");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new functions.https.HttpsError("internal", "Anthropic API key not configured. Add ANTHROPIC_API_KEY to functions/.env");

  // Pull cross-project context. Cap to avoid huge prompts.
  const [projSnap, docSnap, overviewSnap] = await Promise.all([
    db.ref("appState/projects").once("value"),
    db.ref("appState/docData").once("value"),
    db.ref("appState/projectOverview").once("value"),
  ]);
  const projects = projSnap.val() || {};
  const docData = docSnap.val() || {};
  const overviews = overviewSnap.val() || {};

  const projArr = Object.values(projects).filter(p => p && p.status === "active").slice(0, 80);
  const lines = [];
  lines.push(`There are ${Object.keys(projects).length} total projects. ${projArr.length} active projects summarized below.`);
  projArr.forEach(p => {
    const ov = overviews[p.id] || {};
    const pdd = docData[p.id] || {};
    const pdCats = pdd.projectDetails || [];
    const pdArr = Array.isArray(pdCats) ? pdCats : Object.values(pdCats);
    let totalItems = 0, doneItems = 0;
    pdArr.forEach(c => {
      if (c?.type === "checklist" && c.milestones) {
        c.milestones.forEach(ms => (ms.checklist || []).forEach(ck => { if (!ck.na) { totalItems++; if (ck.checked) doneItems++; } }));
      }
    });
    const hwOv = pdd._hardwareOverride || {};
    const cameras = parseInt((hwOv.cameras?.value ?? p.hardware?.cameras ?? "").toString().match(/\d+/)?.[0] || "0");
    const computers = parseInt((hwOv.computers?.value ?? p.hardware?.computers ?? "").toString().match(/\d+/)?.[0] || "0");
    lines.push(`• ${p.name} (${p.customer || "?"}) — ${p.hubspotPipelineLabel || "?"} → ${p.hubspotStageLabel || "?"}; ${p.isSI ? "SI; " : ""}stations:${p.stations || 0}; cameras:${cameras}; computers:${computers}; checklist:${doneItems}/${totalItems}; CSProgID:${p.csProgramId || "—"}; status:"${(ov.projectStatus || "").substring(0, 120)}"`);
  });

  const systemPrompt = `You are an AI assistant for Instrumental's Deployment Portal, helping the Customer Experience team manage hardware deployment projects across all customers. You can answer questions that span multiple projects — e.g. "which projects are blocked", "what's our total camera demand", "list projects in CAD review". Use only the data below. If a question can't be answered from this data, say so plainly.

PROJECT DATA:
${lines.join("\n")}

Keep answers concise and actionable. Use bullet points or short tables when listing multiple projects. Reference projects by name, not ID.`;

  // Build messages array including conversation history (capped).
  const trimmedHistory = Array.isArray(history) ? history.slice(-10).filter(m => m && m.role && m.text) : [];
  const messages = [
    ...trimmedHistory.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text).slice(0, 4000) })),
    { role: "user", content: question.trim() },
  ];

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    const answer = response.content?.[0]?.text || "No response generated.";
    await writeAuditEntry(context.auth.uid, "global_bot_query", null, { qLen: question.length });
    return { answer };
  } catch (err) {
    console.error("Global Bot error:", err);
    throw new functions.https.HttpsError("internal", "AI service error: " + (err.message || String(err)));
  }
});

