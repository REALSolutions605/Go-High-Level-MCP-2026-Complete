import * as https from 'https';
import { URL } from 'url';
import type { Application, Request, Response } from 'express';

// ─── COMMS-W1 Open-Status Endpoint ────────────────────────────────────────────
// POST /comms/open-status — called by the GHL workflow "COMMS-W1 — Verified Send"
// (4c1eb578-8e53-4747-bbf3-f2419582467f, location T0EYPXXzbxqjVy81nxnW) from a
// custom_webhook node 48 hours after the email goes out.
//
// WHY THIS EXISTS
// In July 2026 fourteen emails were sent and reported as successful. Four were
// never seen by a human. GHL reported `delivered` for all of them, and
// `delivered` only means the receiving mail server accepted the message. This
// endpoint reports whether the message was actually OPENED, so non-receipt
// becomes visible instead of silent.
//
// SOURCE OF TRUTH
// GHL's own email record. GET /conversations/messages/email/{id} returns a
// `status` that progresses queued → sent → delivered → opened → clicked.
// Confirmed live on message A9ekRATo68X9Hco0aOIA (status "opened",
// dateUpdated ~3 minutes after dateAdded). No Mailgun integration is needed or
// wanted here.
//
// FAIL-SAFE CONTRACT — the single most important property of this file.
// Every failure path (GHL unreachable, contact not found, no matching message,
// malformed payload, timeout, unexpected throw) returns HTTP 200 with
// `opened: "NO"` and an `evidence` string naming the failure. This handler
// never throws to Express and never leaves the workflow without a response.
// COMMS-W1's None branch routes "not opened" to "notify Steven", so a failure
// surfaces to a human. Returning "YES" on uncertainty, or erroring into
// silence, would recreate the exact bug this system exists to eliminate.
//
// Auth: x-pae-secret header, matched against COMMS_WEBHOOK_SECRET (falling back
// to PAE_WEBHOOK_SECRET). Registered BEFORE the MCP bearer-token middleware so
// GHL can reach it.
// ─────────────────────────────────────────────────────────────────────────────

export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void;

// ── Configuration ─────────────────────────────────────────────────────────────

/** Contacts API version, as used everywhere else in this repo. */
const GHL_VERSION_CONTACTS = '2021-07-28';

/**
 * Conversations/messages API version. GHL versions this family separately and
 * src/clients/ghl-api-client.ts already pins 2021-04-15 for it
 * (getConversationHeaders). Matched here rather than re-guessed.
 */
const GHL_VERSION_CONVERSATIONS = '2021-04-15';

/** Per-request network budget. Tunable via COMMS_FETCH_TIMEOUT_MS. */
const FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.COMMS_FETCH_TIMEOUT_MS ?? 10_000) || 10_000
);

/**
 * Hard wall-clock deadline for the whole lookup. If resolution has not finished
 * by then, the handler answers "NO" anyway. The workflow must always get a
 * response. Tunable via COMMS_DEADLINE_MS.
 */
const DEADLINE_MS = Math.max(
  2000,
  Number(process.env.COMMS_DEADLINE_MS ?? 25_000) || 25_000
);

/** How many conversations / messages to scan when hunting for the message. */
const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES_PER_CONVERSATION = 100;

/** Email statuses that mean a human actually opened the message. */
const OPENED_STATUSES = new Set(['opened', 'clicked']);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Response contract. These key names are FIXED — COMMS-W1's router does a
 *  literal string comparison and will silently mis-route if they change. */
export interface OpenStatusResponse {
  /** The STRING "YES" or "NO". Never a boolean. "YES" only for opened/clicked. */
  opened: 'YES' | 'NO';
  open_count: number;
  recipient_name: string;
  recipient_email: string;
  sent_at: string;
  message_id: string;
  body_stored_empty: boolean;
  /** Human-readable statement of what was actually observed. */
  evidence: string;
  // ── Diagnostics (additive; the router ignores these) ──
  subject: string;
  status: string;
  project: string;
  visibility: string;
  checked_at: string;
}

export interface OpenStatusInput {
  contactId: string;
  contactEmail: string;
  subject: string;
  project: string;
  visibility: string;
}

export interface HttpResult {
  statusCode: number;
  body: any;
}

/** Injectable transport so failure paths can be exercised without a network. */
export type HttpJson = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body?: object
) => Promise<HttpResult>;

// ── HTTPS transport ───────────────────────────────────────────────────────────

export const httpsJson: HttpJson = (method, urlStr, headers, body) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (_) {
      reject(new Error(`invalid GHL URL: ${urlStr}`));
      return;
    }

    const payload = body ? JSON.stringify(body) : undefined;
    const outHeaders: Record<string, string | number> = { ...headers };
    if (payload) {
      outHeaders['Content-Type'] = 'application/json';
      outHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method, headers: outHeaders },
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
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`GHL request timed out after ${FETCH_TIMEOUT_MS}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });

// ── Input parsing ─────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function pick(src: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(src[k]);
    if (v) return v;
  }
  return '';
}

/**
 * The workflow's payload key names have drifted across versions, so accept the
 * documented name plus the plausible aliases rather than 400-ing on a rename.
 * A rename must degrade into a "NO" with evidence, never into a wrong "YES".
 */
export function parseInput(raw: unknown): OpenStatusInput {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    contactId: pick(body, ['contact_id', 'contactId', 'contact', 'id']),
    contactEmail: pick(body, ['contact_email', 'contactEmail', 'email', 'recipient_email', 'to']),
    subject: pick(body, ['subject', 'email_subject', 'emailSubject', 'message_subject']),
    project: pick(body, ['project', 'project_label', 'projectLabel', 'label']),
    visibility: pick(body, ['visibility', 'visible', 'visibility_flag', 'visibilityFlag']),
  };
}

// ── Subject matching ──────────────────────────────────────────────────────────

/**
 * Normalize a subject for comparison: casefold, strip reply/forward prefixes,
 * collapse whitespace, and fold the several dash characters GHL and mail
 * clients interchange (— – −) onto a plain hyphen. The July subjects used an
 * em dash; a workflow field that round-trips through a form can come back with
 * a hyphen.
 */
export function normalizeSubject(s: string): string {
  return str(s)
    .toLowerCase()
    .replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/[‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function subjectMatches(candidate: string, wanted: string): boolean {
  const a = normalizeSubject(candidate);
  const b = normalizeSubject(wanted);
  if (!b) return true; // no subject supplied → any outbound email is a candidate
  if (!a) return false;
  if (a === b) return true;
  // Tolerate truncation on either side (GHL truncates long subjects in some views).
  return a.startsWith(b) || b.startsWith(a);
}

// ── Message shape helpers ─────────────────────────────────────────────────────

export interface CandidateMessage {
  /** Conversation message record id (the thread id on the email record). */
  recordId: string;
  /** Email message id — what /conversations/messages/email/{id} takes. */
  emailMessageId: string;
  subject: string;
  dateAdded: string;
  /** Conversation-level stored body, used as a fallback for the CDATA check. */
  body: string;
}

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Extract outbound email candidates from a /conversations/{id}/messages payload.
 * The email message id lives at meta.email.messageIds — the conversation record
 * id (e.g. whsEIMo95AFbaPoNxrXv) is NOT the email message id
 * (e.g. A9ekRATo68X9Hco0aOIA), and only the latter carries `status`.
 */
export function extractOutboundEmails(messagesPayload: any): CandidateMessage[] {
  const list =
    (Array.isArray(messagesPayload?.messages?.messages) && messagesPayload.messages.messages) ||
    (Array.isArray(messagesPayload?.messages) && messagesPayload.messages) ||
    (Array.isArray(messagesPayload) && messagesPayload) ||
    [];

  const out: CandidateMessage[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (str(m.direction).toLowerCase() !== 'outbound') continue;

    const isEmail =
      str(m.messageType).toUpperCase() === 'TYPE_EMAIL' ||
      m.type === 3 ||
      str(m.type).toUpperCase() === 'TYPE_EMAIL';
    if (!isEmail) continue;

    const emailMeta = m.meta?.email ?? {};
    const ids = Array.isArray(emailMeta.messageIds) ? emailMeta.messageIds.map(str).filter(Boolean) : [];
    // Last id = most recent send attempt for this record.
    const emailMessageId = ids.length ? ids[ids.length - 1] : '';
    if (!emailMessageId) continue;

    out.push({
      recordId: str(m.id),
      emailMessageId,
      subject: str(emailMeta.subject),
      dateAdded: str(m.dateAdded),
      body: typeof m.body === 'string' ? m.body : '',
    });
  }
  return out;
}

/** Most recent candidate whose subject matches. Newest wins on ties. */
export function pickMatchingMessage(
  candidates: CandidateMessage[],
  subject: string
): CandidateMessage | null {
  const matches = candidates.filter((c) => subjectMatches(c.subject, subject));
  if (!matches.length) return null;
  matches.sort((a, b) => toMillis(b.dateAdded) - toMillis(a.dateAdded));
  return matches[0];
}

// ── Body / status evaluation ──────────────────────────────────────────────────

/**
 * True when the stored body is empty OR contains a CDATA wrapper.
 *
 * Two July messages went out CDATA-wrapped, stored an empty body, and still
 * reported `opened`. No status field catches that, which is why this flag
 * exists: the recipient may have opened a message whose content GHL never
 * actually stored, so "opened" alone is not proof the content was readable.
 */
export function isBodyStoredEmpty(body: unknown): boolean {
  if (typeof body !== 'string') return true;
  if (!body.trim()) return true;
  if (body.includes('<![CDATA[')) return true;
  return false;
}

/** Unwrap the several envelope shapes GHL/this repo return for an email record. */
export function unwrapEmailRecord(payload: any): any {
  if (!payload || typeof payload !== 'object') return null;
  return (
    payload?.emailMessage?.emailMessage ??
    payload?.emailMessage ??
    payload?.data?.emailMessage ??
    (payload.id || payload.status ? payload : null)
  );
}

// ── Response builders ─────────────────────────────────────────────────────────

function baseResponse(input: OpenStatusInput): OpenStatusResponse {
  return {
    opened: 'NO',
    open_count: 0,
    recipient_name: '',
    recipient_email: input.contactEmail,
    sent_at: '',
    message_id: '',
    body_stored_empty: false,
    evidence: '',
    subject: input.subject,
    status: '',
    project: input.project,
    visibility: input.visibility,
    checked_at: new Date().toISOString(),
  };
}

/** Fail-safe response. Every abnormal exit goes through here. */
export function failClosed(input: OpenStatusInput, evidence: string): OpenStatusResponse {
  return { ...baseResponse(input), opened: 'NO', evidence };
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface ResolveDeps {
  http: HttpJson;
  log: LogFn;
  token: string;
  locationId: string;
  baseUrl: string;
}

function contactHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION_CONTACTS,
    Accept: 'application/json',
  };
}

function conversationHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION_CONVERSATIONS,
    Accept: 'application/json',
  };
}

/**
 * Resolve open status for one request.
 *
 * The request does NOT reliably carry a message ID, so the message is resolved
 * here: contact → conversations → most recent outbound email matching the
 * subject → that record's email message id → that email record's status.
 *
 * This function NEVER throws. Every path returns an OpenStatusResponse.
 */
export async function resolveOpenStatus(
  input: OpenStatusInput,
  deps: ResolveDeps
): Promise<OpenStatusResponse> {
  const { http, log, token, locationId, baseUrl } = deps;

  try {
    if (!token || !locationId) {
      return failClosed(
        input,
        'Could not verify: GHL credentials are not configured on the server (GHL_API_KEY / GHL_LOCATION_ID). No open status was read; reporting NO so this surfaces to a human.'
      );
    }
    if (!input.contactId && !input.contactEmail) {
      return failClosed(
        input,
        'Could not verify: request carried neither a contact id nor a contact email, so the recipient could not be identified.'
      );
    }

    // ── 1. Resolve the contact ────────────────────────────────────────────────
    let contactId = input.contactId;
    let recipientEmail = input.contactEmail;
    let recipientName = '';

    if (!contactId) {
      const search = await http(
        'POST',
        `${baseUrl}/contacts/search`,
        contactHeaders(token),
        { locationId, pageLimit: 20, query: recipientEmail }
      );
      if (search.statusCode !== 200) {
        return failClosed(
          input,
          `Could not verify: GHL contact search for ${recipientEmail} returned HTTP ${search.statusCode}. No open status was read.`
        );
      }
      const contacts = Array.isArray(search.body?.contacts) ? search.body.contacts : [];
      const wanted = recipientEmail.toLowerCase();
      const hit =
        contacts.find((c: any) => str(c?.email).toLowerCase() === wanted) ?? null;
      if (!hit) {
        return failClosed(
          input,
          `Could not verify: no GHL contact matches ${recipientEmail} (contact search returned ${contacts.length} record(s), none with that exact email).`
        );
      }
      contactId = str(hit.id);
      recipientName =
        [str(hit.firstName), str(hit.lastName)].filter(Boolean).join(' ') ||
        str(hit.contactName) ||
        '';
      if (!contactId) {
        return failClosed(
          input,
          `Could not verify: GHL contact matching ${recipientEmail} has no usable id.`
        );
      }
    }

    // ── 2. Conversations for that contact ─────────────────────────────────────
    const convRes = await http(
      'GET',
      `${baseUrl}/conversations/search?locationId=${encodeURIComponent(
        locationId
      )}&contactId=${encodeURIComponent(contactId)}&limit=${MAX_CONVERSATIONS}`,
      conversationHeaders(token)
    );
    if (convRes.statusCode !== 200) {
      return failClosed(
        input,
        `Could not verify: GHL conversation search for contact ${contactId} returned HTTP ${convRes.statusCode}. No open status was read.`
      );
    }
    const conversations = Array.isArray(convRes.body?.conversations)
      ? convRes.body.conversations
      : [];
    if (!conversations.length) {
      return failClosed(
        input,
        `Could not verify: contact ${contactId} has no conversations in GHL, so no sent email could be located.`
      );
    }

    for (const c of conversations) {
      if (!recipientEmail) recipientEmail = str(c?.email);
      if (!recipientName) recipientName = str(c?.fullName) || str(c?.contactName);
    }

    // ── 3. Most recent outbound email matching the subject ────────────────────
    const candidates: CandidateMessage[] = [];
    for (const c of conversations) {
      const convId = str(c?.id);
      if (!convId) continue;
      const msgRes = await http(
        'GET',
        `${baseUrl}/conversations/${encodeURIComponent(
          convId
        )}/messages?limit=${MAX_MESSAGES_PER_CONVERSATION}`,
        conversationHeaders(token)
      );
      if (msgRes.statusCode !== 200) {
        log('warn', 'COMMS open-status: message fetch failed for conversation', {
          conversationId: convId,
          status: msgRes.statusCode,
        });
        continue;
      }
      candidates.push(...extractOutboundEmails(msgRes.body));
    }

    if (!candidates.length) {
      return failClosed(
        input,
        `Could not verify: contact ${contactId} has ${conversations.length} conversation(s) but no outbound email records with a GHL email message id.`
      );
    }

    const match = pickMatchingMessage(candidates, input.subject);
    if (!match) {
      return failClosed(
        input,
        `Could not verify: none of the ${candidates.length} outbound email(s) for contact ${contactId} have subject "${input.subject}". Most recent subject on file: "${
          candidates
            .slice()
            .sort((a, b) => toMillis(b.dateAdded) - toMillis(a.dateAdded))[0].subject
        }".`
      );
    }

    // ── 4. Read the email record's status ─────────────────────────────────────
    const emailRes = await http(
      'GET',
      `${baseUrl}/conversations/messages/email/${encodeURIComponent(match.emailMessageId)}`,
      conversationHeaders(token)
    );
    if (emailRes.statusCode !== 200) {
      return failClosed(
        input,
        `Could not verify: GHL email record ${match.emailMessageId} (subject "${match.subject}") returned HTTP ${emailRes.statusCode}. No open status was read.`
      );
    }

    const rec = unwrapEmailRecord(emailRes.body);
    if (!rec || typeof rec !== 'object') {
      return failClosed(
        input,
        `Could not verify: GHL returned a malformed email record for ${match.emailMessageId} (subject "${match.subject}").`
      );
    }

    const status = str(rec.status).toLowerCase();
    if (!status) {
      return failClosed(
        input,
        `Could not verify: GHL email record ${match.emailMessageId} (subject "${match.subject}") carries no status field.`
      );
    }

    const sentAt = str(rec.dateAdded) || match.dateAdded;
    const updatedAt = str(rec.dateUpdated);
    const toList = Array.isArray(rec.to) ? rec.to.map(str).filter(Boolean) : [];
    const resolvedEmail = toList[0] || recipientEmail;
    const isOpened = OPENED_STATUSES.has(status);

    // GHL's email record exposes no open counter, only the status ladder
    // (queued → sent → delivered → opened → clicked). open_count is therefore
    // derived from status, and the evidence string says so rather than implying
    // a real count was observed.
    const openCount = isOpened ? 1 : 0;

    // Prefer the email record's own body; fall back to the conversation record's
    // stored body when the email record omits the field entirely.
    const bodyForCheck =
      typeof rec.body === 'string' ? rec.body : match.body;
    const bodyEmpty = isBodyStoredEmpty(bodyForCheck);

    const evidenceParts = [
      `GHL email record ${match.emailMessageId} (subject "${match.subject}") reports status "${status}"`,
      `sent ${sentAt || 'unknown'}`,
      `last updated ${updatedAt || 'unknown'}`,
      isOpened
        ? 'status is in the opened/clicked range, so the message was opened'
        : 'status has not reached opened/clicked, so no open has been recorded',
      'open_count is derived from status (GHL exposes no open counter)',
    ];
    if (bodyEmpty) {
      evidenceParts.push(
        'WARNING: the stored body is empty or CDATA-wrapped, so the recipient may have opened a message whose content GHL never stored'
      );
    }

    log('info', 'COMMS open-status: resolved', {
      contactId,
      emailMessageId: match.emailMessageId,
      status,
      opened: isOpened ? 'YES' : 'NO',
    });

    return {
      ...baseResponse(input),
      opened: isOpened ? 'YES' : 'NO',
      open_count: openCount,
      recipient_name: recipientName,
      recipient_email: resolvedEmail,
      sent_at: sentAt,
      message_id: match.emailMessageId,
      body_stored_empty: bodyEmpty,
      evidence: evidenceParts.join('; ') + '.',
      subject: match.subject || input.subject,
      status,
    };
  } catch (err: any) {
    // Catch-all. Anything unforeseen still becomes a NO with named evidence.
    return failClosed(
      input,
      `Could not verify: open-status lookup failed with "${
        err?.message ?? 'unknown error'
      }". No open status was read; reporting NO so this surfaces to a human.`
    );
  }
}

// ── Route Registration ────────────────────────────────────────────────────────

export function registerCommsRoutes(
  app: Application,
  log: LogFn,
  httpImpl: HttpJson = httpsJson
): void {
  const SECRET = process.env.COMMS_WEBHOOK_SECRET || process.env.PAE_WEBHOOK_SECRET;

  app.post('/comms/open-status', async (req: Request, res: Response) => {
    const startTs = Date.now();

    // 1. Auth — same header and pattern as /pae/analyze.
    if (SECRET) {
      const provided = req.headers['x-pae-secret'];
      if (provided !== SECRET) {
        log('warn', 'COMMS /open-status: unauthorized');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const input = parseInput(req.body);
    log('info', 'COMMS /open-status request received', {
      contactId: input.contactId,
      contactEmail: input.contactEmail,
      project: input.project,
    });

    // 2. Respond exactly once, whatever happens.
    let answered = false;
    const answer = (payload: OpenStatusResponse) => {
      if (answered) return;
      answered = true;
      clearTimeout(watchdog);
      log('info', 'COMMS /open-status: answered', {
        opened: payload.opened,
        status: payload.status,
        elapsed: Date.now() - startTs,
      });
      res.status(200).json(payload);
    };

    // Wall-clock watchdog: the workflow gets an answer even if GHL hangs.
    const watchdog = setTimeout(() => {
      answer(
        failClosed(
          input,
          `Could not verify: open-status lookup exceeded the ${DEADLINE_MS}ms deadline. No open status was read; reporting NO so this surfaces to a human.`
        )
      );
    }, DEADLINE_MS);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    try {
      const result = await resolveOpenStatus(input, {
        http: httpImpl,
        log,
        token: process.env.GHL_API_KEY ?? '',
        locationId: process.env.GHL_LOCATION_ID ?? '',
        baseUrl: (process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com').replace(
          /\/+$/,
          ''
        ),
      });
      answer(result);
    } catch (err: any) {
      // resolveOpenStatus is contractually non-throwing; this is belt and braces.
      log('error', 'COMMS /open-status: handler threw', { error: err?.message });
      answer(
        failClosed(
          input,
          `Could not verify: handler error "${err?.message ?? 'unknown error'}". No open status was read; reporting NO so this surfaces to a human.`
        )
      );
    }
  });

  log('info', 'COMMS routes registered: POST /comms/open-status');
}
