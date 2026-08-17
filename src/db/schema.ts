import { pgTable, text, integer, jsonb, primaryKey } from "drizzle-orm/pg-core";

/* ============================================================
   CAP Trellis — database schema (PostgreSQL / Drizzle)
   Dates are ISO strings ("YYYY-MM-DD"); timestamps are ISO datetime.
   ============================================================ */

// ---------- Organization (single row, id = 1) — white-label config ----------
export const organization = pgTable("organization", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  short: text("short").notNull(),
  tagline: text("tagline").notNull().default(""),
  region: text("region").notNull().default(""),
  accent: text("accent").notNull().default("#D14124"),
  logoMode: text("logo_mode").notNull().default("calv"), // 'calv' | 'wordmark' | 'upload'
  logoData: text("logo_data"),                            // data URL when logoMode = 'upload'
  fyStart: text("fy_start").notNull().default("October"),
  csbgCeiling: integer("csbg_ceiling").notNull().default(125), // % of FPL
  jurisdiction: text("jurisdiction").notNull().default("contiguous48"), // FPL table: 'contiguous48' | 'alaska' | 'hawaii'
  incomeLookbackDays: integer("income_lookback_days").notNull().default(90), // state income-documentation policy
  contactLine: text("contact_line").notNull().default(""), // phone + hours shown on the client portal
});

/* Structured income worksheet — entries annualize into the single `income`
   figure; the worksheet itself is retained for audit/documentation. */
export interface IncomeWorksheet {
  entries: Array<{ source: string; amount: number; period: "weekly" | "biweekly" | "twice-monthly" | "monthly" | "annual" }>;
  lookbackDays: number;   // agency policy at entry time
  annualized: number;     // computed total, mirrors the `income` column
}

/* Frozen eligibility determination — the exact guideline dollars, ceiling, and
   inputs a decision used. Written at submit, refreshed at approval; never
   recomputed afterward. */
export interface Determination {
  at: string;             // ISO datetime
  year: number;           // guideline year used
  jurisdiction: string | null;
  base: number;           // schedule dollars (household of 1)
  perAdditional: number;
  ceiling: number;        // % of FPL the decision was measured against
  income: number;
  hhSize: number;
  pct: number;            // computed % of FPL
  eligible: boolean;
}

// ---------- Users, sessions, program assignment ----------
export const users = pgTable("users", {
  id: text("id").primaryKey(),                  // short slug, e.g. "dr"
  name: text("name").notNull(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),                 // 'Case Worker' | 'Front Desk' | 'Program Manager' | 'Data Admin'
  access: text("access").notNull().default("assigned"), // 'all' | 'assigned'
  initials: text("initials").notNull(),
  active: integer("active").notNull().default(1),
  // TOTP MFA (RFC 6238) — secret is set at enrollment start, enabled only
  // after the first code verifies; recovery codes are scrypt hashes
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled").notNull().default(0),
  recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]),
  locale: text("locale").notNull().default("en"), // staff UI language: 'en' | 'es'
  uiScale: integer("ui_scale").notNull().default(100), // interface scale %, per user (90–125)
});

export const userPrograms = pgTable("user_programs", {
  userId: text("user_id").notNull(),
  programId: text("program_id").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.programId] })]);

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  // MFA-pending sessions: password verified, waiting on the TOTP code —
  // treated as signed-out everywhere except the /login/mfa step
  mfaPending: integer("mfa_pending").notNull().default(0),
  createdAt: text("created_at"),
  userAgent: text("user_agent"),
});

// ---------- Programs (configured per agency; type activates tools) ----------
export const programs = pgTable("programs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  short: text("short").notNull(),
  color: text("color").notNull(),
  type: text("type").notNull(),                 // program-type id from src/lib/program-types.ts
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  fplCeiling: integer("fpl_ceiling"),           // % of FPL; null = agency default (organization.csbg_ceiling)
  sort: integer("sort").notNull().default(0),
  active: integer("active").notNull().default(1),
});

// ---------- Required documents ----------
export const docTypes = pgTable("doc_types", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
});

export const programDocs = pgTable("program_docs", {
  programId: text("program_id").notNull(),
  docKey: text("doc_key").notNull(),
}, (t) => [primaryKey({ columns: [t.programId, t.docKey] })]);

// ---------- Clients (enrolled) ----------
export const clients = pgTable("clients", {
  id: text("id").primaryKey(),                  // "C-2417"
  first: text("first").notNull(),
  last: text("last").notNull(),
  dob: text("dob").notNull(),
  sex: text("sex"),
  race: text("race"),
  edu: text("edu"),
  work: text("work"),
  insurance: text("insurance"),
  military: text("military"),
  disability: integer("disability"),            // 1 | 0 | null (unknown)
  phone: text("phone"),
  address: text("address"),
  county: text("county"),
  hhType: text("hh_type"),
  hhSize: integer("hh_size").notNull().default(1),
  housing: text("housing"),
  income: integer("income").notNull().default(0), // annual gross $
  incomeSrc: text("income_src"),
  incomeWorksheet: jsonb("income_worksheet").$type<IncomeWorksheet>(), // structured entries behind `income`
  caseworkerId: text("caseworker_id"),
  enrolled: text("enrolled").notNull(),         // date of first enrollment
  fplYear: integer("fpl_year").notNull(),       // pinned guideline year (point-in-time integrity)
  nextFollowUp: text("next_follow_up"),
  flags: jsonb("flags").$type<string[]>().notNull().default([]),
  custom: jsonb("custom").$type<Record<string, string>>().notNull().default({}),
  status: text("status").notNull().default("active"), // 'active' | 'closed'
  createdAt: text("created_at").notNull(),
  importJobId: integer("import_job_id"),        // set by the client-migration importer → enables one-click undo
});

export const clientPrograms = pgTable("client_programs", {
  clientId: text("client_id").notNull(),
  programId: text("program_id").notNull(),
}, (t) => [primaryKey({ columns: [t.clientId, t.programId] })]);

// ---------- Applications (pre-enrollment eligibility pipeline) ----------
// stage: 'docs' → 'review' → 'decision' → terminal 'approved' | 'denied'
export const applications = pgTable("applications", {
  id: text("id").primaryKey(),                  // "A-1180"
  first: text("first").notNull(),
  last: text("last").notNull(),
  dob: text("dob").notNull(),
  phone: text("phone"),
  address: text("address"),
  county: text("county"),
  sex: text("sex"),
  race: text("race"),
  edu: text("edu"),
  work: text("work"),
  insurance: text("insurance"),
  military: text("military"),
  disability: integer("disability"),
  hhType: text("hh_type"),
  hhSize: integer("hh_size").notNull().default(1),
  housing: text("housing"),
  income: integer("income").notNull().default(0),
  incomeSrc: text("income_src"),
  incomeWorksheet: jsonb("income_worksheet").$type<IncomeWorksheet>(),
  determination: jsonb("determination").$type<Determination>(), // frozen eligibility math (see interface above)
  custom: jsonb("custom").$type<Record<string, string>>().notNull().default({}),
  programId: text("program_id").notNull(),
  caseworkerId: text("caseworker_id"),
  stage: text("stage").notNull().default("docs"),
  applied: text("applied").notNull(),
  fplYear: integer("fpl_year").notNull(),       // pinned guideline year at assessment
  notes: text("notes").notNull().default(""),
  decisionNote: text("decision_note"),
  decidedBy: text("decided_by"),
  decidedAt: text("decided_at"),
  clientId: text("client_id"),                  // set when approved → enrolled
  portalToken: text("portal_token").unique(),   // tokenized self-service link (no login wall)
});

export const applicationDocs = pgTable("application_docs", {
  applicationId: text("application_id").notNull(),
  docKey: text("doc_key").notNull(),
  status: text("status").notNull().default("missing"), // 'missing' | 'submitted' | 'verified'
  source: text("source"),                                // 'staff' | 'portal'
  updatedAt: text("updated_at"),
  // supporting file on record (scanned document) — required before plain Verify
  fileName: text("file_name"),                           // original filename, shown in the meta line
  filePath: text("file_path"),                           // stored copy, relative to data/uploads/
  fileBy: text("file_by"),
  fileAt: text("file_at"),                               // ISO date
  // verification sign-off
  verifiedBy: text("verified_by"),
  verifiedAt: text("verified_at"),                       // ISO date
  // signed exception — verified with no document retained (audited)
  bypassBy: text("bypass_by"),
  bypassAt: text("bypass_at"),                           // ISO date
  bypassReason: text("bypass_reason"),
}, (t) => [primaryKey({ columns: [t.applicationId, t.docKey] })]);

// ---------- Service taxonomy + log ----------
export const services = pgTable("services", {
  code: text("code").primaryKey(),              // "SRV 4e"
  domain: text("domain").notNull(),             // domain id: sda|emp|edu|inc|hou|hn|civ|tra
  label: text("label").notNull(),
  active: integer("active").notNull().default(1),
  sort: integer("sort").notNull().default(0),
});

// Per-program service availability. A program with NO rows here offers the full
// catalog (default); rows restrict its pickers to the listed codes.
export const programServices = pgTable("program_services", {
  programId: text("program_id").notNull(),
  code: text("code").notNull(),
}, (t) => [primaryKey({ columns: [t.programId, t.code] })]);

export const serviceLog = pgTable("service_log", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  date: text("date").notNull(),
  clientId: text("client_id").notNull(),
  code: text("code").notNull(),
  programId: text("program_id").notNull(),
  staffId: text("staff_id").notNull(),
  note: text("note").notNull().default(""),
  // optional supporting attachment (receipt, award letter, signed form …)
  fileName: text("file_name"),                  // original filename, shown in the UI
  filePath: text("file_path"),                  // stored copy, relative to data/uploads/
});

// ---------- Federal Poverty Guidelines (versioned, point-in-time pinning) ----------
export const fplSchedules = pgTable("fpl_schedules", {
  year: integer("year").primaryKey(),
  base: integer("base").notNull(),              // household of 1, annual $
  perAdditional: integer("per_additional").notNull(),
  effective: text("effective").notNull(),
  status: text("status").notNull().default("archived"), // 'active' | 'archived'
  // which official HHS table the dollars came from ('contiguous48'|'alaska'|'hawaii').
  // Informational: the dollars are stored above, so a later jurisdiction change
  // never rewrites pinned history.
  jurisdiction: text("jurisdiction"),
});

// ---------- Admin-editable answer lists + intake fields ----------
export const lists = pgTable("lists", {
  key: text("key").primaryKey(),                // 'sex' | 'race' | ...
  label: text("label").notNull(),
});

export const listValues = pgTable("list_values", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  listKey: text("list_key").notNull(),
  value: text("value").notNull(),
  sort: integer("sort").notNull().default(0),
});

export const intakeFields = pgTable("intake_fields", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  code: text("code").notNull().default(""),     // CSBG code, e.g. "C6"
  type: text("type").notNull(),                 // 'list' | 'choice' | 'yesno' | 'text' | 'number' | 'date'
  listKey: text("list_key"),                    // when type = 'list'
  optionsText: text("options_text"),            // when type = 'choice' (comma-separated)
  enabled: integer("enabled").notNull().default(1),
  builtin: integer("builtin").notNull().default(0),
  sort: integer("sort").notNull().default(0),
});

// ---------- FNPI outcomes ----------
// fnpi_progress holds the FY TARGETS per indicator. served/actual are a pre-system
// baseline (0 in a fresh seed); the reports rollup layers live outcome_log counts on
// top of them, so existing databases keep their historical aggregates.
export const fnpiProgress = pgTable("fnpi_progress", {
  code: text("code").primaryKey(),              // "FNPI 4b"
  label: text("label").notNull(),
  served: integer("served").notNull().default(0),
  target: integer("target").notNull().default(0),
  actual: integer("actual").notNull().default(0),
});

// ROMA agency goals (Org Standard 4.3 evidence): each goal links to the FNPI
// indicators that measure it, so assessment → plan → results stays traceable.
export const romaGoals = pgTable("roma_goals", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  fnpiCodes: jsonb("fnpi_codes").$type<string[]>().notNull().default([]),
  sort: integer("sort").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// Client-level outcome recording — one row per client × indicator × FY
// (the recording action upserts within the fiscal year, so counts stay unduplicated).
export const outcomeLog = pgTable("outcome_log", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  date: text("date").notNull(),
  clientId: text("client_id").notNull(),
  code: text("code").notNull(),                 // "FNPI 4b"
  programId: text("program_id").notNull(),
  staffId: text("staff_id").notNull(),
  status: text("status").notNull().default("achieved"), // 'working' | 'achieved'
  note: text("note").notNull().default(""),
});

// ---------- Integrations ----------
export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),                 // 'API' | 'Import' | 'CSV / XLSX'
  status: text("status").notNull(),             // 'connected' | 'attention' | 'ready'
  lastSync: text("last_sync").notNull().default(""),
  records: text("records").notNull().default(""),
  detail: text("detail").notNull().default(""),
});

// Durable linkage to external systems (HMIS client IDs, etc.) — one row per
// (system, external id); every sync after first linkage matches on this, not names.
export const clientExternalIds = pgTable("client_external_ids", {
  system: text("system").notNull(),             // 'hmis' | 'rxoffice' | …
  externalId: text("external_id").notNull(),
  clientId: text("client_id").notNull(),
  linkedAt: text("linked_at").notNull(),        // ISO datetime
  linkedBy: text("linked_by").notNull(),        // staff id, or 'sync'
}, (t) => [primaryKey({ columns: [t.system, t.externalId] })]);

/** An incoming client record held for duplicate review — enough to create the
    client (or enroll an existing one) when a human resolves the match. */
export interface HeldClientPayload {
  kind: "client";
  client: {
    first: string; last: string; dob: string;
    phone: string | null; address: string | null;
    sex: string | null; race: string | null; housing: string | null;
    hhType: string | null; hhSize: number;
    // remaining All Characteristics Report fields (optional — rows queued
    // before these import columns existed won't carry them)
    edu?: string | null; work?: string | null; insurance?: string | null;
    military?: string | null; disability?: number | null; incomeSrc?: string | null;
    county?: string | null;
    /** staff id resolved from the sheet's caseworker column (blank = resolver) */
    caseworkerId?: string | null;
    custom?: Record<string, string>;
    income: number; incomeWorksheet?: IncomeWorksheet;
    enrolled: string; fplYear: number;
  };
  programId: string;
  serviceCode?: string;
  serviceDate?: string;
  /** external-system linkage recorded on resolution (future API syncs) */
  externalId?: { system: string; id: string };
}

/* ---------- PA HMIS sync (MOU-scoped) ----------
   Snapshot of HMIS clients pulled for CACLV-owned projects. Per the signed
   MOU its ONLY permitted uses are (a) data-set matching for deduplication
   and (b) deidentified aggregate organization-wide reports. It must never
   populate client records or drive intake/outreach. Admin-only surface. */
export const hmisClients = pgTable("hmis_clients", {
  hmisId: text("hmis_id").primaryKey(),         // HMIS Client ID (the durable link key)
  first: text("first").notNull(),
  last: text("last").notNull(),
  dob: text("dob"),                             // ISO date when provided
  email: text("email"),                         // matching tiebreaker only
  phone: text("phone"),                         // matching tiebreaker only
  sex: text("sex"),                             // gender/sex as HMIS reports it
  race: text("race"),                           // race + ethnicity, combined text
  veteran: text("veteran"),
  insurance: text("insurance"),
  incomeSrc: text("income_src"),
  nonCash: text("non_cash"),                    // non-cash benefits, as reported
  services: jsonb("services").$type<Array<{ name: string; date: string }>>().notNull().default([]),
  household: jsonb("household").$type<Array<{ first: string; last: string; dob: string | null }>>().notNull().default([]),
  fetchedAt: text("fetched_at").notNull(),      // ISO datetime of the sync that wrote this row
});

// HMIS near-matches held for human review — link or dismiss, never create.
export const hmisReviews = pgTable("hmis_reviews", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  at: text("at").notNull(),                     // ISO datetime queued
  hmisId: text("hmis_id").notNull(),
  candidateIds: jsonb("candidate_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"), // 'pending' | 'resolved'
  resolution: text("resolution"),               // 'linked' | 'dismissed'
  resolvedClientId: text("resolved_client_id"),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
});

// Duplicate review queue — incoming records whose match against existing
// clients is ambiguous. Nothing merges silently; a human resolves each row.
export const matchReviews = pgTable("match_reviews", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  at: text("at").notNull(),                     // ISO datetime
  source: text("source").notNull(),             // integration id: 'sheets' | 'hmis' | …
  sourceRef: text("source_ref").notNull().default(""), // e.g. 'roster.csv row 12'
  payload: jsonb("payload").$type<HeldClientPayload>().notNull(),
  candidateIds: jsonb("candidate_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"), // 'pending' | 'resolved'
  resolution: text("resolution"),               // 'linked' | 'created' | 'dismissed'
  resolvedClientId: text("resolved_client_id"),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
});

// Spreadsheet import history (Data & integrations → Import spreadsheet)
/** What an HMIS sync did to records that already existed, so undo can put them
    back. Created clients need none of this — they carry `import_job_id` and are
    deleted outright — but links, queued reviews and blank-fills all landed on
    records that must survive an undo. */
export interface HmisSyncUndo {
  /** (system, external id) links this sync wrote. */
  links: Array<{ system: string; externalId: string }>;
  /** hmis_reviews rows this sync queued. */
  reviewIds: number[];
  /** Blank fields this sync filled, with the values that were there before. */
  enriched: Array<{ clientId: string; before: Record<string, unknown> }>;
}

export const importJobs = pgTable("import_jobs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  at: text("at").notNull(),                     // ISO datetime
  template: text("template").notNull(),         // 'clients' | 'pantry' | 'hmis' | …
  filename: text("filename").notNull(),         // or the sync's source, for 'hmis'
  imported: integer("imported").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  staffId: text("staff_id").notNull(),
  detail: text("detail").notNull().default(""),
  // reversal record for template 'hmis' (see HmisSyncUndo)
  hmisUndo: jsonb("hmis_undo").$type<HmisSyncUndo>(),
});

// ---------- Audit log ----------
export const auditLog = pgTable("audit_log", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  at: text("at").notNull(),                     // ISO datetime
  userId: text("user_id"),
  action: text("action").notNull(),             // e.g. 'application.approve', 'fpl.publish'
  entity: text("entity").notNull(),             // e.g. 'application'
  entityId: text("entity_id").notNull(),
  detail: text("detail").notNull().default(""),
});

// ---------- Misc demo aggregates (agency-wide stats that predate this system) ----------
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
});

/* ============================================================
   Program-tool tables (activated by program type capabilities)
   ============================================================ */

// --- attendance (youth/education) ---
export const classes = pgTable("classes", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  name: text("name").notNull(),
  site: text("site").notNull().default(""),
  schedule: text("schedule").notNull().default(""),
  srvCode: text("srv_code").notNull().default("SRV 2h"),
});

export const students = pgTable("students", {
  id: text("id").primaryKey(),
  classId: text("class_id").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id"),
  grade: text("grade").notNull().default(""),
  school: text("school").notNull().default(""),
  termPct: integer("term_pct").notNull().default(100),
});

export const classSessions = pgTable("class_sessions", {
  id: text("id").primaryKey(),
  classId: text("class_id").notNull(),
  date: text("date").notNull(),
  label: text("label").notNull(),
  posted: integer("posted").notNull().default(0),
});

export const attendanceMarks = pgTable("attendance_marks", {
  sessionId: text("session_id").notNull(),
  studentId: text("student_id").notNull(),
  mark: text("mark"),                           // 'p' | 'a' | 'e' | null
}, (t) => [primaryKey({ columns: [t.sessionId, t.studentId] })]);

// --- contractors / jobs (weatherization) ---
export const contractors = pgTable("contractors", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  name: text("name").notNull(),
  trade: text("trade").notNull().default(""),
  crews: integer("crews").notNull().default(1),
  phone: text("phone").notNull().default(""),
  insuranceExp: text("insurance_exp").notNull(),
  bpiExp: text("bpi_exp").notNull(),
  epaRrpExp: text("epa_rrp_exp").notNull(),
  qcPass: integer("qc_pass").notNull().default(100),
});

export const wxJobs = pgTable("wx_jobs", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  clientName: text("client_name").notNull(),
  clientId: text("client_id"),
  address: text("address").notNull().default(""),
  stage: text("stage").notNull().default("audit"), // 'audit' | 'install' | 'qc' | 'complete'
  contractorId: text("contractor_id"),
  funding: text("funding").notNull().default(""),
  measures: text("measures").notNull().default(""),
  started: text("started").notNull(),
});

// --- pantry network (food bank) ---
export const pantryAgencies = pgTable("pantry_agencies", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  name: text("name").notNull(),
  town: text("town").notNull().default(""),
  county: text("county").notNull().default(""),
  contact: text("contact").notNull().default(""),
  phone: text("phone").notNull().default(""),
  compliance: text("compliance").notNull().default("current"), // 'current' | 'site-visit-due'
});

export const pantryReports = pgTable("pantry_reports", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  agencyId: text("agency_id").notNull(),
  month: text("month").notNull(),               // "2026-05"
  status: text("status").notNull().default("missing"), // 'received' | 'missing'
  households: integer("households"),
  lbs: integer("lbs"),
});

// --- seminars (housing counseling) ---
export const seminars = pgTable("seminars", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  title: text("title").notNull(),
  date: text("date").notNull(),
  time: text("time").notNull().default(""),
  site: text("site").notNull().default(""),
  capacity: integer("capacity").notNull().default(0),
  registered: integer("registered").notNull().default(0),
  srvCode: text("srv_code").notNull().default("SRV 3a"),
});

export const seminarAttendees = pgTable("seminar_attendees", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  seminarId: text("seminar_id").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id"),
  applicationId: text("application_id"),
  intakeStatus: text("intake_status").notNull().default("not-started"), // 'enrolled' | 'in-progress' | 'not-started'
});

// --- construction projects (housing construction) ---
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  name: text("name").notNull(),
  town: text("town").notNull().default(""),
  buyer: text("buyer").notNull().default(""),
  budget: integer("budget").notNull().default(0),
  spent: integer("spent").notNull().default(0),
  pct: integer("pct").notNull().default(0),
});

export const projectMilestones = pgTable("project_milestones", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  projectId: text("project_id").notNull(),
  label: text("label").notNull(),
  done: integer("done").notNull().default(0),
  current: integer("current").notNull().default(0),
  sort: integer("sort").notNull().default(0),
});

export const projectRequirements = pgTable("project_requirements", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  projectId: text("project_id").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("current"), // 'current' | 'due'
});

// --- volunteers (outreach / food bank) ---
export const volunteers = pgTable("volunteers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  clientId: text("client_id"),
  lowIncome: integer("low_income").notNull().default(0),
  role: text("role").notNull().default(""),
  hoursFY: integer("hours_fy").notNull().default(0),
  lastShift: text("last_shift"),
});

export const volunteerPrograms = pgTable("volunteer_programs", {
  volunteerId: text("volunteer_id").notNull(),
  programId: text("program_id").notNull(),
}, (t) => [primaryKey({ columns: [t.volunteerId, t.programId] })]);

// --- loans (community loan fund) ---
export const loans = pgTable("loans", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  borrower: text("borrower").notNull(),
  clientId: text("client_id"),
  purpose: text("purpose").notNull().default(""),
  principal: integer("principal").notNull().default(0),
  balance: integer("balance").notNull().default(0),
  rate: text("rate").notNull().default(""),
  term: text("term").notNull().default(""),
  // structured terms behind the display strings — drive the amortization schedule
  rateBps: integer("rate_bps"),                 // annual rate in basis points (450 = 4.50%)
  termMonths: integer("term_months"),
  originated: text("originated"),               // disbursement date (ISO)
  status: text("status").notNull().default("current"), // 'current' | 'late' | 'paid'
  nextDue: text("next_due"),
  srvCode: text("srv_code").notNull().default("SRV 3b"),
});

// Payment ledger — one row per payment recorded against a loan, with the
// interest/principal split at the balance the payment was applied to.
export const loanPayments = pgTable("loan_payments", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  loanId: text("loan_id").notNull(),
  date: text("date").notNull(),
  amount: integer("amount").notNull(),
  interest: integer("interest").notNull().default(0),
  principal: integer("principal").notNull().default(0),
  balanceAfter: integer("balance_after").notNull(),
  staffId: text("staff_id").notNull(),
  note: text("note").notNull().default(""),
});

// Weatherization contractor expense vouchers (submitted → approved → paid)
export const wxVouchers = pgTable("wx_vouchers", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull(),
  contractorId: text("contractor_id").notNull(),
  jobId: text("job_id"),
  date: text("date").notNull(),
  amount: integer("amount").notNull(),
  memo: text("memo").notNull().default(""),
  status: text("status").notNull().default("submitted"), // 'submitted' | 'approved' | 'paid'
  createdBy: text("created_by").notNull(),
  decidedBy: text("decided_by"),
  paidAt: text("paid_at"),
});

// Type exports for convenience
export type Organization = typeof organization.$inferSelect;
export type User = typeof users.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type ApplicationDoc = typeof applicationDocs.$inferSelect;
export type ServiceLogEntry = typeof serviceLog.$inferSelect;
export type OutcomeLogEntry = typeof outcomeLog.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;
export type FplSchedule = typeof fplSchedules.$inferSelect;
export type IntakeField = typeof intakeFields.$inferSelect;
