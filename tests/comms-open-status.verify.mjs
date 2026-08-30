// Verification harness for POST /comms/open-status.
//
// Runs the real resolver against a stubbed transport that replays payloads
// captured live from GHL on 2026-08-30 for message A9ekRATo68X9Hco0aOIA
// (contact 9fpdr77Sap8LA2dEoxFz, superiorservices.midwest@gmail.com).
//
//   node tests/comms-open-status.verify.mjs
//
// Requires a build first:  npx tsc
// (This file is a standalone script, not a jest suite — tests/ is excluded from
// tsconfig and this deliberately exercises the compiled output.)

import assert from 'node:assert';
import { resolveOpenStatus, parseInput } from '../dist/comms-open-status.js';

const LOCATION = 'T0EYPXXzbxqjVy81nxnW';
const CONTACT = '9fpdr77Sap8LA2dEoxFz';
const CONV = 'YBqoNF0inzBBngNAqKuf';
const EMAIL_ID = 'A9ekRATo68X9Hco0aOIA';
const SUBJECT = '[TEST — COMMS-W1 BUILD] Ignore — open-tracking probe';

const log = () => {};
const deps = (http) => ({
  http,
  log,
  token: 'stub-token',
  locationId: LOCATION,
  baseUrl: 'https://services.leadconnectorhq.com',
});

// ── Recorded payloads ─────────────────────────────────────────────────────────

const CONVERSATIONS_OK = {
  statusCode: 200,
  body: {
    conversations: [
      {
        id: CONV,
        locationId: LOCATION,
        contactId: CONTACT,
        fullName: "Steven's Tester 1",
        contactName: "Steven's Tester 1",
        email: 'superiorservices.midwest@gmail.com',
        lastMessageType: 'TYPE_EMAIL',
        lastMessageDirection: 'outbound',
      },
    ],
    total: 1,
  },
};

const MESSAGES_OK = {
  statusCode: 200,
  body: {
    messages: {
      lastMessageId: 'whsEIMo95AFbaPoNxrXv',
      nextPage: false,
      messages: [
        {
          id: 'whsEIMo95AFbaPoNxrXv',
          direction: 'outbound',
          type: 3,
          locationId: LOCATION,
          body: 'This is an automated TEST message sent during the build of the COMMS-W1 verified-send workflow.',
          contactId: CONTACT,
          contentType: 'text/html',
          conversationId: CONV,
          dateAdded: '2026-08-30T12:18:03.174Z',
          dateUpdated: '2026-08-30T12:18:03.441Z',
          meta: {
            email: { messageIds: [EMAIL_ID], direction: 'outbound', subject: SUBJECT },
          },
          source: 'app',
          messageType: 'TYPE_EMAIL',
        },
      ],
    },
  },
};

const EMAIL_OK = {
  statusCode: 200,
  body: {
    emailMessage: {
      id: EMAIL_ID,
      direction: 'outbound',
      status: 'opened',
      locationId: LOCATION,
      body: '<div style="font-family: Roboto, Arial; font-size: 14px;"><p>This is an automated TEST message…</p></div>',
      contactId: CONTACT,
      conversationId: CONV,
      dateAdded: '2026-08-30T12:18:03.175Z',
      dateUpdated: '2026-08-30T12:21:09.153Z',
      from: 'REAL Solutions <Office@email.real-solutions-llc.com>',
      to: ['superiorservices.midwest@gmail.com'],
      threadId: 'whsEIMo95AFbaPoNxrXv',
      subject: SUBJECT,
      source: 'app',
      provider: 'mailgun',
    },
  },
};

function router(overrides = {}) {
  return async (method, url) => {
    if (url.includes('/contacts/search')) return overrides.contacts ?? { statusCode: 200, body: { contacts: [{ id: CONTACT, email: 'superiorservices.midwest@gmail.com', firstName: "Steven's", lastName: 'Tester 1' }] } };
    if (url.includes('/conversations/search')) return overrides.conversations ?? CONVERSATIONS_OK;
    if (url.includes('/messages/email/')) return overrides.email ?? EMAIL_OK;
    if (url.includes('/messages')) return overrides.messages ?? MESSAGES_OK;
    throw new Error(`unstubbed URL: ${method} ${url}`);
  };
}

const unreachable = async () => {
  throw new Error('getaddrinfo EAI_AGAIN services.leadconnectorhq.com');
};

// ── Cases ─────────────────────────────────────────────────────────────────────

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('happy path by contact id → YES', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT, project: 'COMMS-W1', visibility: 'internal' }),
    deps(router())
  );
  assert.strictEqual(r.opened, 'YES');
  assert.strictEqual(typeof r.opened, 'string');
  assert.strictEqual(r.message_id, EMAIL_ID);
  assert.strictEqual(r.open_count, 1);
  assert.strictEqual(r.body_stored_empty, false);
  assert.strictEqual(r.recipient_email, 'superiorservices.midwest@gmail.com');
  assert.strictEqual(r.recipient_name, "Steven's Tester 1");
  assert.strictEqual(r.sent_at, '2026-08-30T12:18:03.175Z');
  assert.match(r.evidence, /status "opened"/);
  assert.match(r.evidence, /2026-08-30T12:21:09\.153Z/);
  for (const k of ['opened', 'open_count', 'recipient_name', 'recipient_email', 'sent_at', 'message_id', 'body_stored_empty', 'evidence']) {
    assert.ok(k in r, `missing fixed field ${k}`);
  }
});

test('happy path by email only (contact lookup) → YES', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_email: 'superiorservices.midwest@gmail.com', subject: SUBJECT }),
    deps(router())
  );
  assert.strictEqual(r.opened, 'YES');
  assert.strictEqual(r.message_id, EMAIL_ID);
});

test('subject with plain hyphens instead of em dashes still matches', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: '[TEST - COMMS-W1 BUILD] Ignore - open-tracking probe' }),
    deps(router())
  );
  assert.strictEqual(r.opened, 'YES');
});

test('status delivered → NO', async () => {
  const email = { statusCode: 200, body: { emailMessage: { ...EMAIL_OK.body.emailMessage, status: 'delivered' } } };
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT, subject: SUBJECT }), deps(router({ email })));
  assert.strictEqual(r.opened, 'NO');
  assert.strictEqual(r.open_count, 0);
  assert.match(r.evidence, /status "delivered"/);
  assert.match(r.evidence, /no open has been recorded/);
});

test('status clicked → YES', async () => {
  const email = { statusCode: 200, body: { emailMessage: { ...EMAIL_OK.body.emailMessage, status: 'clicked' } } };
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT, subject: SUBJECT }), deps(router({ email })));
  assert.strictEqual(r.opened, 'YES');
});

test('CDATA-wrapped body flags body_stored_empty while still reporting opened', async () => {
  const email = { statusCode: 200, body: { emailMessage: { ...EMAIL_OK.body.emailMessage, body: '<![CDATA[ ]]>' } } };
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT, subject: SUBJECT }), deps(router({ email })));
  assert.strictEqual(r.opened, 'YES');
  assert.strictEqual(r.body_stored_empty, true);
  assert.match(r.evidence, /CDATA-wrapped/);
});

test('empty stored body flags body_stored_empty', async () => {
  const email = { statusCode: 200, body: { emailMessage: { ...EMAIL_OK.body.emailMessage, body: '   ' } } };
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT, subject: SUBJECT }), deps(router({ email })));
  assert.strictEqual(r.body_stored_empty, true);
});

test('GHL unreachable → NO with named failure', async () => {
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT, subject: SUBJECT }), deps(unreachable));
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /EAI_AGAIN/);
  assert.match(r.evidence, /surfaces to a human/);
});

test('GHL 500 on email record → NO', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT }),
    deps(router({ email: { statusCode: 500, body: 'boom' } }))
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /HTTP 500/);
});

test('contact not found → NO', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_email: 'nobody@example.com', subject: SUBJECT }),
    deps(router({ contacts: { statusCode: 200, body: { contacts: [] } } }))
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /no GHL contact matches nobody@example\.com/);
});

test('contact exists but no matching subject → NO', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: 'Some completely different subject' }),
    deps(router())
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /none of the 1 outbound email/);
  assert.match(r.evidence, /Most recent subject on file/);
});

test('contact with no conversations → NO', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT }),
    deps(router({ conversations: { statusCode: 200, body: { conversations: [] } } }))
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /no conversations in GHL/);
});

test('malformed email record → NO', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT }),
    deps(router({ email: { statusCode: 200, body: { unexpected: true } } }))
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /malformed email record/);
});

test('email record with no status field → NO', async () => {
  const rec = { ...EMAIL_OK.body.emailMessage };
  delete rec.status;
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT }),
    deps(router({ email: { statusCode: 200, body: { emailMessage: rec } } }))
  );
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /no status field/);
});

test('empty request body → NO', async () => {
  const r = await resolveOpenStatus(parseInput({}), deps(router()));
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /neither a contact id nor a contact email/);
});

test('missing GHL credentials → NO', async () => {
  const r = await resolveOpenStatus(parseInput({ contact_id: CONTACT }), {
    http: router(),
    log,
    token: '',
    locationId: '',
    baseUrl: 'https://services.leadconnectorhq.com',
  });
  assert.strictEqual(r.opened, 'NO');
  assert.match(r.evidence, /credentials are not configured/);
});

test('double-wrapped email envelope also unwraps', async () => {
  const r = await resolveOpenStatus(
    parseInput({ contact_id: CONTACT, subject: SUBJECT }),
    deps(router({ email: { statusCode: 200, body: { emailMessage: { emailMessage: EMAIL_OK.body.emailMessage } } } }))
  );
  assert.strictEqual(r.opened, 'YES');
});

// ── Runner ────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
