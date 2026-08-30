import * as https from 'https';
import { URL } from 'url';

// ─── PAE Buyer Profile Loader ─────────────────────────────────────────────────
// Loads buyer buy-box profiles from GoHighLevel CONTACT records and renders them
// into the text block format the Pre-Analysis Engine's waterfall already expects.
//
// Storage model (see docs): profiles live on contacts tagged `pae-buyer-profile`,
// with buy-box data in `contact.paebp_*` custom fields. Scalars are typed fields;
// naturally-nested dimensions (per-asset-class scores, statuses, geography tiers,
// strategy scores) are stored as line-oriented `Key = Value` text, one per line.
//
// This module NEVER throws to its caller. Every entry point resolves to a value;
// failures degrade to an empty profile list so deal analysis still runs.
// ─────────────────────────────────────────────────────────────────────────────

export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void;

// ── Configuration ─────────────────────────────────────────────────────────────

const GHL_VERSION = '2021-07-28';

/** Contacts must carry this tag to be treated as a buyer profile. */
export const PROFILE_TAG = 'pae-buyer-profile';

/** Custom field key prefix owned by this system. */
const PREFIX = 'paebp_';

/**
 * Hard cap on how many profiles are rendered into the system prompt.
 * Each rendered profile costs roughly 500-700 input tokens (measured). The
 * waterfall itself only
 * ever emits the top 3 recommendations, so rendering more profiles improves
 * match quality without growing the output. Kept low anyway to bound input cost
 * and latency. Tunable via PAE_MAX_PROFILES.
 */
const MAX_RENDERED_PROFILES = Math.max(
  0,
  Number(process.env.PAE_MAX_PROFILES ?? 8) || 8
);

/** Profile fetch cache TTL. Tunable via PAE_PROFILE_CACHE_TTL_MS. */
const CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.PAE_PROFILE_CACHE_TTL_MS ?? 10 * 60 * 1000) || 10 * 60 * 1000
);

/** Per-request budget for the whole profile load. Never block analysis on GHL. */
const FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.PAE_PROFILE_FETCH_TIMEOUT_MS ?? 8000) || 8000
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuyerProfile {
  contactId: string;
  profileId: string;
  profileName: string;
  priority: number;
  profileRole: string;
  relationshipType: string;
  feeStructure: string;
  geographyTiers: Array<[string, string]>;
  assetClassPriorities: Array<[string, string]>;
  buyBoxStatus: Array<[string, string]>;
  sizeMinimums: Array<[string, string]>;
  priceCeilings: Array<[string, string]>;
  capRateTargets: Array<[string, string]>;
  strategyScores: Array<[string, string]>;
  conditionRules: Array<[string, string]>;
  dealTypesInScope: string[];
  specialRules: string[];
  equityMinimumPct: string;
  arvMaxPct: string;
  cashflowMinPerDoor: string;
  wholesaleSpreadMin: string;
  wholesaleSpreadTarget: string;
  motivationSensitivity: string;
}

export interface ProfileLoadResult {
  profiles: BuyerProfile[];
  /** Where the data came from — for logging and the audit trail. */
  source: 'cache' | 'ghl' | 'none';
  /** Populated when the load failed or was skipped. Analysis continues regardless. */
  degradedReason?: string;
  /** Count of tagged contacts found before the render cap was applied. */
  found: number;
}

// ── Minimal HTTPS JSON helper ─────────────────────────────────────────────────

function requestJson(
  method: 'GET' | 'POST',
  urlStr: string,
  token: string,
  body?: object,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (e: any) {
      reject(new Error(`Invalid GHL URL: ${urlStr}`));
      return;
    }

    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => {
          raw += c.toString();
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {
            parsed = raw;
          }
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GHL request timed out after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Line-oriented value parsing ───────────────────────────────────────────────

/**
 * Parse `Key = Value` lines into pairs. Deliberately forgiving: blank lines,
 * comment lines (`#`), and lines without a separator are skipped rather than
 * failing the whole profile. A single malformed line must never cost Steven a
 * buyer in the waterfall.
 */
export function parsePairs(raw: unknown): Array<[string, string]> {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([^=:]+)\s*[=:]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (!key) continue;
    out.push([key, val]);
  }
  return out;
}

/** Parse a plain list: one item per line, or a single comma-separated line. */
export function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 1 && lines[0].includes(',')) {
    return lines[0]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return lines;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  return String(v).trim();
}

// ── Mapping: GHL contact → BuyerProfile ───────────────────────────────────────

/**
 * Map a GHL contact record to a BuyerProfile.
 * `fieldKeyById` maps custom field IDs to their `contact.<key>` field keys,
 * because /contacts/search returns custom field values keyed by ID only.
 * Returns null when the contact is not an active profile.
 */
export function mapContactToProfile(
  contact: any,
  fieldKeyById: Record<string, string>
): BuyerProfile | null {
  if (!contact || typeof contact !== 'object') return null;

  // Flatten custom fields into { paebp_xxx: value }
  const cf: Record<string, unknown> = {};
  const rawFields = Array.isArray(contact.customFields) ? contact.customFields : [];
  for (const f of rawFields) {
    if (!f || typeof f !== 'object') continue;
    // Support both shapes: {id, value} and {key/fieldKey, value/field_value}
    const explicitKey =
      typeof f.fieldKey === 'string' ? f.fieldKey : typeof f.key === 'string' ? f.key : '';
    const key = explicitKey || fieldKeyById[f.id] || '';
    if (!key) continue;
    const short = key.replace(/^contact\./, '');
    if (!short.startsWith(PREFIX)) continue;
    cf[short] = f.value !== undefined ? f.value : f.field_value;
  }

  // Active gate: the flag field must say yes. Absent flag = not a profile.
  const activeRaw = str(cf[`${PREFIX}active`]).toLowerCase();
  const isActive = ['yes', 'y', 'true', '1', 'active'].includes(activeRaw);
  if (!isActive) return null;

  const name =
    [str(contact.firstName), str(contact.lastName)].filter(Boolean).join(' ').trim() ||
    str(contact.contactName) ||
    str(contact.email) ||
    'Unnamed Profile';

  const priorityRaw = Number(str(cf[`${PREFIX}priority`]));

  return {
    contactId: str(contact.id),
    profileId: str(cf[`${PREFIX}profile_id`]) || `PROFILE-${str(contact.id).slice(-6)}`,
    profileName: name,
    priority: Number.isFinite(priorityRaw) && priorityRaw > 0 ? priorityRaw : 999,
    profileRole: str(cf[`${PREFIX}profile_role`]) || 'Outside Buyer',
    relationshipType:
      str(cf[`${PREFIX}relationship_type`]).toUpperCase() === 'PROVEN_INTERNAL'
        ? 'PROVEN_INTERNAL'
        : 'UNPROVEN_EXTERNAL',
    feeStructure: str(cf[`${PREFIX}fee_structure`]),
    geographyTiers: parsePairs(cf[`${PREFIX}geography_tiers`]),
    assetClassPriorities: parsePairs(cf[`${PREFIX}asset_class_priorities`]),
    buyBoxStatus: parsePairs(cf[`${PREFIX}buy_box_status`]),
    sizeMinimums: parsePairs(cf[`${PREFIX}size_minimums`]),
    priceCeilings: parsePairs(cf[`${PREFIX}price_ceilings`]),
    capRateTargets: parsePairs(cf[`${PREFIX}cap_rate_targets`]),
    strategyScores: parsePairs(cf[`${PREFIX}strategy_scores`]),
    conditionRules: parsePairs(cf[`${PREFIX}condition_rules`]),
    dealTypesInScope: parseList(cf[`${PREFIX}deal_types_in_scope`]),
    specialRules: parseList(cf[`${PREFIX}special_rules`]),
    equityMinimumPct: str(cf[`${PREFIX}equity_minimum_pct`]),
    arvMaxPct: str(cf[`${PREFIX}arv_max_pct`]),
    cashflowMinPerDoor: str(cf[`${PREFIX}cashflow_min_per_door`]),
    wholesaleSpreadMin: str(cf[`${PREFIX}wholesale_spread_min`]),
    wholesaleSpreadTarget: str(cf[`${PREFIX}wholesale_spread_target`]),
    motivationSensitivity: str(cf[`${PREFIX}motivation_sensitivity`]).toUpperCase() || 'MEDIUM',
  };
}

// ── Rendering: BuyerProfile → prompt block ────────────────────────────────────

function section(title: string, lines: string[]): string {
  if (!lines.length) return '';
  return `\n${title}\n${lines.join('\n')}\n`;
}

/**
 * Render a profile in exactly the block format used by the hardcoded
 * PROFILE-001 block, so the waterfall reads new profiles the same way.
 */
export function renderProfile(p: BuyerProfile): string {
  const head = [
    '--- BEGIN BUY BOX PROFILE ---',
    `PROFILE_ID: ${p.profileId}`,
    `PROFILE_NAME: ${p.profileName}`,
    `PRIORITY: ${p.priority}`,
    `PROFILE_ROLE: ${p.profileRole}`,
    'PROFILE_TYPE: BUYER',
    `RELATIONSHIP_TYPE: ${p.relationshipType}`,
    `FEE_STRUCTURE: ${p.feeStructure || 'Not specified'}`,
  ].join('\n');

  const buyBox = section(
    'BUY_BOX_STATUS_BY_ASSET_CLASS:',
    p.buyBoxStatus.map(([k, v]) => `  ${k}: ${v.toUpperCase()}`)
  );

  const priorities = section(
    'ACQUISITION_PRIORITY_ORDER:',
    p.assetClassPriorities.map(([k, v], i) => `${i + 1}. ${k} — score weight ${v}`)
  );

  const geography = section(
    'GEOGRAPHY_PREFERENCES:',
    p.geographyTiers.map(([k, v]) => `- ${k} — score range ${v}`)
  );

  const financial: string[] = [];
  if (p.equityMinimumPct)
    financial.push(`- seller_equity_minimum: ${p.equityMinimumPct}% for acquisition consideration`);
  if (p.arvMaxPct)
    financial.push(
      `- arv_max_pct: ${p.arvMaxPct}% — HARD CEILING on all-in cost as a percentage of ARV`
    );
  if (p.cashflowMinPerDoor)
    financial.push(
      `- cashflow_minimum_per_door: $${p.cashflowMinPerDoor}/month after PITI and management`
    );
  if (p.wholesaleSpreadMin || p.wholesaleSpreadTarget)
    financial.push(
      `- wholesale_spread_target: $${p.wholesaleSpreadMin || '0'} minimum, $${
        p.wholesaleSpreadTarget || p.wholesaleSpreadMin || '0'
      } target net spread`
    );
  for (const [k, v] of p.priceCeilings) financial.push(`- price_ceiling_${k.toLowerCase()}: ${v}`);
  for (const [k, v] of p.capRateTargets) financial.push(`- cap_rate_preferred_${k.toLowerCase()}: ${v}`);
  for (const [k, v] of p.sizeMinimums) financial.push(`- size_minimum_${k.toLowerCase()}: ${v}`);

  const strategy = section(
    'STRATEGY_PREFERENCES:',
    p.strategyScores.map(([k, v]) => `- ${k} — score ${v}`)
  );

  const dealTypes = section(
    'DEAL_TYPES_IN_SCOPE:',
    p.dealTypesInScope.map((d) => `- ${d}`)
  );

  const condition = section(
    'CONDITION_RULES:',
    p.conditionRules.map(([k, v]) => `- ${k} — ${v}`)
  );

  const motivation = section('MOTIVATION_SENSITIVITY:', [
    `- ${p.motivationSensitivity} — weight seller motivation and timing urgency accordingly`,
  ]);

  const special = section(
    'SPECIAL_RULES:',
    p.specialRules.map((s) => `- ${s}`)
  );

  return (
    head +
    '\n' +
    buyBox +
    priorities +
    geography +
    section('FINANCIAL_THRESHOLDS:', financial) +
    strategy +
    dealTypes +
    condition +
    motivation +
    special +
    '--- END BUY BOX PROFILE ---'
  );
}

export function renderProfiles(profiles: BuyerProfile[]): string {
  if (!profiles.length) return '';
  return '\n\n' + profiles.map(renderProfile).join('\n\n');
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let cache: { at: number; result: ProfileLoadResult } | null = null;

/** Test/ops hook — drop the cached profile set. */
export function clearProfileCache(): void {
  cache = null;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Build an id → fieldKey map for the location's contact custom fields, so
 * values returned by /contacts/search (which are keyed by field ID) can be
 * resolved to `paebp_*` names.
 */
async function fetchFieldKeyMap(
  baseUrl: string,
  token: string,
  locationId: string
): Promise<Record<string, string>> {
  const res = await requestJson(
    'GET',
    `${baseUrl}/locations/${encodeURIComponent(locationId)}/customFields?model=contact`,
    token
  );
  if (res.statusCode !== 200) {
    throw new Error(`custom field fetch returned ${res.statusCode}`);
  }
  const fields = res.body?.customFields ?? res.body?.customField ?? [];
  const map: Record<string, string> = {};
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && typeof f.id === 'string' && typeof f.fieldKey === 'string') {
        map[f.id] = f.fieldKey;
      }
    }
  }
  return map;
}

async function fetchTaggedContacts(
  baseUrl: string,
  token: string,
  locationId: string
): Promise<any[]> {
  const res = await requestJson('POST', `${baseUrl}/contacts/search`, token, {
    locationId,
    pageLimit: 50,
    filters: { tags: [PROFILE_TAG] },
  });
  if (res.statusCode !== 200) {
    throw new Error(`contact search returned ${res.statusCode}`);
  }
  const contacts = res.body?.contacts;
  return Array.isArray(contacts) ? contacts : [];
}

/**
 * Load active buyer profiles from GHL.
 *
 * Fail-soft contract: this function does not throw. On any error — missing
 * credentials, network failure, non-200, malformed payload — it returns an
 * empty profile list with a `degradedReason`. The caller renders no extra
 * profiles and the sovereign (Profile 001) evaluation proceeds unchanged.
 */
export async function loadBuyerProfiles(log: LogFn): Promise<ProfileLoadResult> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.result, source: 'cache' };
  }

  const token = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const baseUrl = (process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com').replace(
    /\/+$/,
    ''
  );

  const fail = (reason: string): ProfileLoadResult => {
    const result: ProfileLoadResult = {
      profiles: [],
      source: 'none',
      degradedReason: reason,
      found: 0,
    };
    // Cache negative results too, briefly, so a GHL outage does not turn every
    // analyze call into an extra failing round trip.
    cache = { at: now, result };
    return result;
  };

  if (!token || !locationId) {
    log('warn', 'PAE profiles: GHL credentials not configured; waterfall will run with no profiles');
    return fail('GHL_API_KEY or GHL_LOCATION_ID not configured');
  }

  try {
    const [fieldKeyById, contacts] = await Promise.all([
      fetchFieldKeyMap(baseUrl, token, locationId),
      fetchTaggedContacts(baseUrl, token, locationId),
    ]);

    const mapped: BuyerProfile[] = [];
    for (const c of contacts) {
      try {
        const p = mapContactToProfile(c, fieldKeyById);
        if (p) mapped.push(p);
      } catch (e: any) {
        log('warn', 'PAE profiles: skipped unmappable contact', {
          contactId: c?.id,
          error: e?.message,
        });
      }
    }

    mapped.sort((a, b) => a.priority - b.priority || a.profileId.localeCompare(b.profileId));
    const capped = mapped.slice(0, MAX_RENDERED_PROFILES);

    const result: ProfileLoadResult = {
      profiles: capped,
      source: 'ghl',
      found: mapped.length,
      degradedReason:
        mapped.length > capped.length
          ? `${mapped.length} active profiles found; rendered top ${capped.length} (PAE_MAX_PROFILES)`
          : undefined,
    };
    cache = { at: now, result };
    log('info', 'PAE profiles: loaded from GHL', {
      contactsMatched: contacts.length,
      activeProfiles: mapped.length,
      rendered: capped.length,
    });
    return result;
  } catch (err: any) {
    log('error', 'PAE profiles: load failed, continuing without waterfall profiles', {
      error: err?.message,
    });
    return fail(`GHL profile load failed: ${err?.message ?? 'unknown error'}`);
  }
}
