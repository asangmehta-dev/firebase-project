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
  const isSI = /\[SI\]/i.test(name);
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

/* ═══ CORE SYNC LOGIC ═══ */
async function runSync(token, commit) {
  const startedAt = new Date().toISOString();
  await db.ref("hubspotSync/status").set({ state: "running", startedAt });

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

    return { success: true, preview: false, ...summary };
  } catch (err) {
    console.error("HubSpot sync error:", err);
    await db.ref("hubspotSync/status").set({ state: "error", error: err.message, startedAt });
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
    await runSync(token, true);
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
  return await runSync(token, commit);
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
