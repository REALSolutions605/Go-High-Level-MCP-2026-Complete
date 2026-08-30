import * as https from 'https';
import { URL } from 'url';

// ─── PAE Result Write-Back ────────────────────────────────────────────────────
// The Pre-Analysis Engine used to return its verdict in the HTTP response to
// GHL's custom-webhook action. That never worked: the analysis takes 27-38s and
// the action times out long before, so `custom_webhook.1.response.verdict` was
// always empty, every deal fell to the router's None catch-all, and the note GHL
// wrote rendered "Verdict:" as a blank — a silent failure that looks fine.
//
// Results are now written INTO GoHighLevel as custom fields on the OPPORTUNITY,
// and PAE-W2 routes on the stored field instead of on a response body.
//
// Failure is deliberately visible. `paew2_status` moves QUEUED -> ANALYZING ->
// COMPLETE | FAILED, so an analysis that never landed is distinguishable from a
// genuine PASS verdict: a PASS carries status COMPLETE, a lost analysis is stuck
// on ANALYZING (or carries FAILED plus `paew2_error`).
// ─────────────────────────────────────────────────────────────────────────────

export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void;

const GHL_VERSION = '2021-07-28';

/** Custom field key prefix owned by the PAE write-back. Chosen to avoid the
 *  prefixes already in use in this location: paew0_, paebp_, buyer_, buy_box_. */
export const PREFIX = 'paew2_';

/**
 * Short key -> GHL custom field key suffix. Field IDs are resolved at runtime
 * from `fieldKey` rather than hardcoded, so recreating a field in GHL does not
 * silently break the write-back.
 */
export const RESULT_FIELDS = {
  status: `${PREFIX}status`,
  verdict: `${PREFIX}verdict`,
  compositeScore: `${PREFIX}composite_score`,
  pipelineRoute: `${PREFIX}pipeline_route`,
  reasoning: `${PREFIX}reasoning`,
  keyRisks: `${PREFIX}key_risks`,
  /** Single highest-priority risk, for the alert. The full list is keyRisks. */
  topRisk: `${PREFIX}top_risk`,
  dataCompleteness: `${PREFIX}data_completeness`,
  missingFields: `${PREFIX}missing_fields`,
  analysisTimestamp: `${PREFIX}analysis_timestamp`,
  requestId: `${PREFIX}request_id`,
  error: `${PREFIX}error`,
} as const;

/**
 * Fields rendered into an internal notification, where a blank is dangerous.
 *
 * Today's test proved the failure mode is a merge token rendering BLANK rather
 * than literal — a note that reads "Verdict:" followed by nothing looks fine to
 * a human skimming it. Any field that appears in an alert therefore gets a
 * definite value rather than an empty string. See {@link definiteText}.
 */
export const NOTIFICATION_FIELDS: ReadonlyArray<ResultFieldKeyName> = [
  'verdict',
  'compositeScore',
  'reasoning',
  'topRisk',
];

type ResultFieldKeyName = keyof typeof RESULT_FIELDS;

/**
 * Coerce a value destined for an alert into something that always reads as an
 * answer. An empty reasoning field must say so, not render as whitespace.
 */
export function definiteText(value: unknown, whenEmpty: string): string {
  if (value === null || value === undefined) return whenEmpty;
  const s = Array.isArray(value)
    ? value.filter((x) => x !== null && x !== undefined && String(x).trim()).join(' | ')
    : String(value);
  return s.trim() ? s.trim() : whenEmpty;
}

/** First entry of a key-risk list, or a definite statement that there is none. */
export function topRiskOf(risks: unknown): string {
  if (Array.isArray(risks)) {
    const first = risks.find((r) => r !== null && r !== undefined && String(r).trim());
    return first ? String(first).trim() : 'None identified';
  }
  return definiteText(risks, 'None identified');
}

export type ResultFieldKey = keyof typeof RESULT_FIELDS;

/** Fields GHL stores as NUMERICAL — written as numbers, not strings. */
const NUMERIC_FIELDS: ReadonlySet<ResultFieldKey> = new Set<ResultFieldKey>([
  'compositeScore',
  'dataCompleteness',
]);

/**
 * Lifecycle of one analysis, as seen from the opportunity record.
 *
 *  QUEUED    — PAE-W2 stamped the card before calling the webhook. If the card
 *              still says QUEUED, /pae/analyze was never reached.
 *  ANALYZING — the endpoint accepted the payload and started work. Still
 *              ANALYZING after the workflow's wait means the run died.
 *  COMPLETE  — a verdict was written. Only this state makes `paew2_verdict`
 *              trustworthy, including when the verdict is PASS.
 *  FAILED    — the run ended in a handled error; `paew2_error` says which.
 */
export type AnalysisStatus = 'QUEUED' | 'ANALYZING' | 'COMPLETE' | 'FAILED';

/** Values written in one write-back call. Only supplied keys are sent. */
export type ResultValues = Partial<Record<ResultFieldKey, string | number>>;

// ── Configuration ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.PAE_WRITEBACK_TIMEOUT_MS ?? 15000) || 15000
);

/** Field-id map cache TTL. Custom fields change rarely; a stale id is fatal. */
const FIELD_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.PAE_WRITEBACK_FIELD_CACHE_TTL_MS ?? 10 * 60 * 1000) ||
    10 * 60 * 1000
);

/** LARGE_TEXT fields still have a practical ceiling; keep write payloads sane. */
const MAX_TEXT_LEN = 4000;

// ── Minimal HTTPS JSON helper ─────────────────────────────────────────────────

function requestJson(
  method: 'GET' | 'PUT' | 'POST',
  urlStr: string,
  token: string,
  body?: object,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
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
      { hostname: url.hostname, path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => {
          raw += c.toString();
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
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

function baseUrl(): string {
  return (process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com').replace(
    /\/+$/,
    ''
  );
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Derive the routing token PAE-W2 branches on.
 *
 * `pipeline_route` used to be the literal string 'DEFAULT' on every success
 * path, which carried no information at all. It now mirrors the verdict, and
 * anything unrecognised — including a missing verdict — becomes UNROUTED so the
 * catch-all branch is reached deliberately rather than by accident.
 */
export function derivePipelineRoute(verdict: unknown): string {
  const v = typeof verdict === 'string' ? verdict.trim().toUpperCase() : '';
  switch (v) {
    case 'PROCEED':
    case 'WHOLESALE':
    case 'REVIEW':
    case 'PASS':
      return v;
    default:
      return 'UNROUTED';
  }
}

/** True when an id looks like a usable GHL record id rather than an unresolved
 *  merge token ("{{opportunity.id}}") or an empty string. */
export function isUsableGhlId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 64) return false;
  if (v.includes('{{') || v.includes('}}')) return false;
  return /^[A-Za-z0-9_-]+$/.test(v);
}

function clampText(value: string): string {
  return value.length > MAX_TEXT_LEN
    ? value.slice(0, MAX_TEXT_LEN - 3) + '...'
    : value;
}

/**
 * Build the `customFields` array for PUT /opportunities/{id}.
 *
 * Keys with no resolved field id are dropped and reported, so a missing field in
 * GHL surfaces in the logs instead of silently voiding the whole write.
 */
export function buildCustomFieldPayload(
  values: ResultValues,
  idByFieldKey: Record<string, string>
): {
  customFields: Array<{ id: string; field_value: string | number }>;
  unresolved: string[];
} {
  const customFields: Array<{ id: string; field_value: string | number }> = [];
  const unresolved: string[] = [];

  for (const [shortKey, raw] of Object.entries(values) as Array<
    [ResultFieldKey, string | number | undefined]
  >) {
    if (raw === undefined || raw === null) continue;

    const suffix = RESULT_FIELDS[shortKey];
    const id = idByFieldKey[suffix];
    if (!id) {
      unresolved.push(suffix);
      continue;
    }

    let field_value: string | number;
    if (NUMERIC_FIELDS.has(shortKey)) {
      const n = Number(raw);
      field_value = Number.isFinite(n) ? n : 0;
    } else {
      field_value = clampText(String(raw));
    }

    customFields.push({ id, field_value });
  }

  return { customFields, unresolved };
}

// ── Field id resolution ───────────────────────────────────────────────────────

let fieldCache: { at: number; map: Record<string, string> } | null = null;

/** Test/ops hook — drop the cached field-id map. */
export function clearFieldCache(): void {
  fieldCache = null;
}

/**
 * Map `paew2_*` field key suffixes to GHL custom field IDs for the location's
 * opportunity model. Throws on failure — the caller turns that into a FAILED
 * status where it can, and logs it where it cannot.
 */
export async function resolveFieldIds(
  log: LogFn
): Promise<Record<string, string>> {
  const now = Date.now();
  if (fieldCache && now - fieldCache.at < FIELD_CACHE_TTL_MS) {
    return fieldCache.map;
  }

  const token = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    throw new Error('GHL_API_KEY or GHL_LOCATION_ID not configured');
  }

  const res = await requestJson(
    'GET',
    `${baseUrl()}/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`,
    token
  );
  if (res.statusCode !== 200) {
    throw new Error(`opportunity custom field fetch returned ${res.statusCode}`);
  }

  const fields = res.body?.customFields ?? res.body?.customField ?? [];
  const map: Record<string, string> = {};
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (!f || typeof f.id !== 'string' || typeof f.fieldKey !== 'string') continue;
      const short = f.fieldKey.replace(/^opportunity\./, '');
      if (short.startsWith(PREFIX)) map[short] = f.id;
    }
  }

  const missing = Object.values(RESULT_FIELDS).filter((k) => !map[k]);
  if (missing.length) {
    log('warn', 'PAE write-back: opportunity custom fields missing in GHL', {
      missing,
    });
  }

  fieldCache = { at: now, map };
  return map;
}

// ── Write-back ────────────────────────────────────────────────────────────────

export interface WriteResult {
  ok: boolean;
  /** Populated when ok is false. Safe to surface in logs. */
  error?: string;
  /** Field keys that had no matching custom field in GHL. */
  unresolved?: string[];
}

/**
 * Write PAE result fields onto an opportunity.
 *
 * GHL's PUT /opportunities/{id} wants the pipeline the opportunity lives in, so
 * the record is read first. Never throws: the caller is a background task with
 * nobody to catch for it.
 */
export async function writeAnalysisFields(
  opportunityId: string,
  values: ResultValues,
  log: LogFn
): Promise<WriteResult> {
  try {
    if (!isUsableGhlId(opportunityId)) {
      return { ok: false, error: `Unusable opportunity id: ${String(opportunityId)}` };
    }

    const token = process.env.GHL_API_KEY;
    if (!token) return { ok: false, error: 'GHL_API_KEY not configured' };

    const idByFieldKey = await resolveFieldIds(log);
    const { customFields, unresolved } = buildCustomFieldPayload(values, idByFieldKey);

    if (!customFields.length) {
      return {
        ok: false,
        error: 'No PAE result fields could be resolved to GHL custom field IDs',
        unresolved,
      };
    }

    const url = `${baseUrl()}/opportunities/${encodeURIComponent(opportunityId)}`;

    const current = await requestJson('GET', url, token);
    if (current.statusCode !== 200) {
      return {
        ok: false,
        error: `GET opportunity returned ${current.statusCode}`,
        unresolved,
      };
    }
    const pipelineId = current.body?.opportunity?.pipelineId;

    const put = await requestJson('PUT', url, token, {
      ...(pipelineId ? { pipelineId } : {}),
      customFields,
    });

    if (put.statusCode < 200 || put.statusCode >= 300) {
      return {
        ok: false,
        error:
          `PUT opportunity returned ${put.statusCode}: ` +
          JSON.stringify(put.body).slice(0, 500),
        unresolved,
      };
    }

    log('info', 'PAE write-back: fields written', {
      opportunityId,
      fields: customFields.length,
      unresolved: unresolved.length,
    });
    return { ok: true, unresolved };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'unknown write-back error' };
  }
}
