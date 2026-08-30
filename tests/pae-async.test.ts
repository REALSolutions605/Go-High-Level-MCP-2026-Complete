/**
 * Pre-Analysis Engine — asynchronous write-back.
 *
 * Covers the four defects this rebuild exists to close:
 *   1. /pae/analyze answering synchronously after 27-38s, past GHL's timeout
 *   2. the 20-key allowlist silently discarding real deal financials
 *   3. the Section 1 five-financial-fields gate being unsatisfiable as written
 *   4. pipeline_route hardcoded to 'DEFAULT' on every success path
 * plus the failure-visibility contract: an unwritten verdict and a genuine PASS
 * must never look the same in the record.
 */

import express from 'express';
import type { Server } from 'http';
import { AddressInfo } from 'net';

import {
  registerPAERoutes,
  projectDealPayload,
  buildUserMessage,
  makeRequestId,
  FINANCIAL_GATE_FIELDS,
  CANONICAL_DEAL_FIELDS,
} from '../src/pae-handler';
import {
  derivePipelineRoute,
  isUsableGhlId,
  buildCustomFieldPayload,
  RESULT_FIELDS,
  clearFieldCache,
} from '../src/pae-writeback';
import { resolveBuildInfo } from '../src/build-info';

const noopLog = () => {};

// ─── Payload projection ───────────────────────────────────────────────────────

describe('projectDealPayload — the 20-key allowlist', () => {
  /** The twelve fields the old allowlist dropped, as they arrive on a real deal. */
  const REAL_DEAL_FIELDS = {
    annual_noi: '184000',
    cap_rate: '8.2',
    mortgage_balance: '1250000',
    property_taxes: '31400',
    insurance_estimate: '18200',
    occupancy_rate: '94',
    revenue_current: '412000',
    operating_expenses: '228000',
    monthly_rent_actual: '34333',
    seller_equity_pct: '82',
    condition: 'Light Rehab',
    financing_terms: 'Seller Carryback',
  };

  it('carries every field the old allowlist discarded', () => {
    const { dealData } = projectDealPayload({
      property_address: '1400 Crazy Horse Rd, Sioux Falls, SD 57104',
      asset_class: 'Small Multifamily',
      asking_price: '2250000',
      ...REAL_DEAL_FIELDS,
    });

    for (const [key, value] of Object.entries(REAL_DEAL_FIELDS)) {
      expect(dealData[key]).toBe(value);
    }
  });

  it('renders absent canonical fields as MISSING rather than omitting them', () => {
    const { dealData } = projectDealPayload({ property_address: '1 Main St' });
    expect(dealData.property_address).toBe('1 Main St');
    expect(dealData.annual_noi).toBe('MISSING');
    for (const field of CANONICAL_DEAL_FIELDS) {
      expect(dealData).toHaveProperty(field);
    }
  });

  it('passes through fields it has never heard of instead of dropping them', () => {
    const { dealData, extraFields } = projectDealPayload({
      opportunity_id: 'abc123',
      tenant_ledger_url: 'https://example.com/ledger.pdf',
      pad_count: '62',
    });
    expect(extraFields).toEqual(
      expect.arrayContaining(['tenant_ledger_url', 'pad_count'])
    );
    expect(dealData.pad_count).toBe('62');
  });

  it('strips control keys from the deal payload', () => {
    const { dealData, extraFields } = projectDealPayload({
      opportunity_id: 'opp_1',
      contact_id: 'con_1',
      location_id: 'loc_1',
      request_id: 'req_1',
      property_address: '1 Main St',
    });
    expect(dealData).not.toHaveProperty('opportunity_id');
    expect(dealData).not.toHaveProperty('contact_id');
    expect(extraFields).toEqual([]);
  });

  it('treats an unresolved GHL merge token as absence, not as data', () => {
    const { dealData, financialFieldsPresent } = projectDealPayload({
      property_address: '{{inboundWebhookRequest.property_address}}',
      annual_noi: '{{inboundWebhookRequest.annual_noi}}',
      asking_price: '2250000',
    });
    expect(dealData.property_address).toBe('MISSING');
    expect(dealData.annual_noi).toBe('MISSING');
    expect(financialFieldsPresent).toEqual(['asking_price']);
  });

  it('bounds pass-through so a runaway body cannot swamp the prompt', () => {
    const body: Record<string, string> = {};
    for (let i = 0; i < 200; i++) body[`extra_${i}`] = String(i);
    const { extraFields, droppedFields } = projectDealPayload(body);
    expect(extraFields.length).toBe(60);
    expect(droppedFields.length).toBe(140);
  });

  it('survives a body that is not an object', () => {
    expect(() => projectDealPayload(null)).not.toThrow();
    expect(() => projectDealPayload('nonsense')).not.toThrow();
    expect(projectDealPayload(null).financialFieldsPresent).toEqual([]);
  });
});

// ─── The five-financial-fields gate ───────────────────────────────────────────

describe('the Section 1 financial gate', () => {
  it('was unsatisfiable under the old allowlist and is satisfiable now', () => {
    // Under the old 20-key allowlist only asking_price of the ten gate fields
    // survived, so no submission could ever reach five.
    const { financialFieldsPresent } = projectDealPayload({
      asking_price: '2250000',
      estimated_value: '2900000',
      annual_noi: '184000',
      cap_rate: '8.2',
      mortgage_balance: '1250000',
      seller_equity_pct: '82',
    });
    expect(financialFieldsPresent.length).toBeGreaterThanOrEqual(5);
  });

  it('counts every one of the ten gate fields', () => {
    const body: Record<string, string> = {};
    for (const f of FINANCIAL_GATE_FIELDS) body[f] = '1';
    expect(projectDealPayload(body).financialFieldsPresent.length).toBe(
      FINANCIAL_GATE_FIELDS.length
    );
  });

  it('counts legacy aliases toward the gate they map onto', () => {
    // Old callers send arv / repair_estimate; the gate counts estimated_value
    // and rehab_estimate. Both keys survive, and the gate sees the canonical one.
    const { dealData, financialFieldsPresent } = projectDealPayload({
      arv: '2900000',
      repair_estimate: '180000',
      asking_price: '2250000',
    });
    expect(financialFieldsPresent).toEqual(
      expect.arrayContaining(['estimated_value', 'rehab_estimate', 'asking_price'])
    );
    expect(dealData.arv).toBe('2900000');
    expect(dealData.estimated_value).toBe('2900000');
  });

  it('does not let an alias overwrite a value the caller supplied directly', () => {
    const { dealData } = projectDealPayload({
      arv: '2900000',
      estimated_value: '3100000',
    });
    expect(dealData.estimated_value).toBe('3100000');
  });

  it('states the count in the prompt so the model does not re-count', () => {
    const projected = projectDealPayload({
      asking_price: '1',
      estimated_value: '1',
      annual_noi: '1',
      cap_rate: '1',
      mortgage_balance: '1',
    });
    const msg = buildUserMessage(projected);
    expect(msg).toContain('financial_fields_present (5 of 10)');
    expect(msg).toContain('financial_gate_satisfied: true');
  });

  it('reports the gate as unsatisfied on a thin submission', () => {
    const msg = buildUserMessage(projectDealPayload({ asking_price: '250000' }));
    expect(msg).toContain('financial_fields_present (1 of 10)');
    expect(msg).toContain('financial_gate_satisfied: false');
  });
});

// ─── pipeline_route ───────────────────────────────────────────────────────────

describe('derivePipelineRoute — no longer hardcoded to DEFAULT', () => {
  it.each([
    ['PROCEED', 'PROCEED'],
    ['WHOLESALE', 'WHOLESALE'],
    ['REVIEW', 'REVIEW'],
    ['PASS', 'PASS'],
    ['proceed', 'PROCEED'],
    ['  Review  ', 'REVIEW'],
  ])('maps verdict %s to route %s', (verdict, route) => {
    expect(derivePipelineRoute(verdict)).toBe(route);
  });

  it.each([undefined, null, '', 'ERROR', 'DEFAULT', 42])(
    'routes unrecognised verdict %p to UNROUTED',
    (verdict) => {
      expect(derivePipelineRoute(verdict)).toBe('UNROUTED');
    }
  );

  it('never returns the old placeholder', () => {
    for (const v of ['PROCEED', 'WHOLESALE', 'REVIEW', 'PASS', 'nonsense']) {
      expect(derivePipelineRoute(v)).not.toBe('DEFAULT');
    }
  });
});

// ─── Opportunity id validation ────────────────────────────────────────────────

describe('isUsableGhlId', () => {
  it('accepts a real GHL id', () => {
    expect(isUsableGhlId('hBkHHNxqu3owNKXjgoTe')).toBe(true);
  });

  it('rejects an unresolved merge token', () => {
    // This is the failure mode that must not be accepted silently: if the
    // opportunity does not exist yet, {{opportunity.id}} arrives verbatim.
    expect(isUsableGhlId('{{opportunity.id}}')).toBe(false);
  });

  it.each([['', 'empty'], ['   ', 'blank'], [undefined, 'absent'], [null, 'null'], [42, 'numeric']])(
    'rejects %p (%s)',
    (value) => {
      expect(isUsableGhlId(value)).toBe(false);
    }
  );
});

// ─── Write-back payload ───────────────────────────────────────────────────────

describe('buildCustomFieldPayload', () => {
  const ids = {
    [RESULT_FIELDS.status]: 'ID_STATUS',
    [RESULT_FIELDS.verdict]: 'ID_VERDICT',
    [RESULT_FIELDS.compositeScore]: 'ID_SCORE',
    [RESULT_FIELDS.pipelineRoute]: 'ID_ROUTE',
  };

  it('maps short keys onto GHL custom field IDs', () => {
    const { customFields, unresolved } = buildCustomFieldPayload(
      { status: 'COMPLETE', verdict: 'PROCEED', pipelineRoute: 'PROCEED' },
      ids
    );
    expect(unresolved).toEqual([]);
    expect(customFields).toEqual(
      expect.arrayContaining([
        { id: 'ID_STATUS', field_value: 'COMPLETE' },
        { id: 'ID_VERDICT', field_value: 'PROCEED' },
      ])
    );
  });

  it('writes NUMERICAL fields as numbers, not strings', () => {
    const { customFields } = buildCustomFieldPayload({ compositeScore: '62' }, ids);
    expect(customFields[0].field_value).toBe(62);
  });

  it('coerces an unparseable score to 0 rather than sending NaN', () => {
    const { customFields } = buildCustomFieldPayload({ compositeScore: 'n/a' }, ids);
    expect(customFields[0].field_value).toBe(0);
  });

  it('reports fields with no id in GHL instead of dropping them silently', () => {
    const { customFields, unresolved } = buildCustomFieldPayload(
      { verdict: 'PASS', reasoning: 'no match' },
      ids
    );
    expect(customFields).toHaveLength(1);
    expect(unresolved).toEqual([RESULT_FIELDS.reasoning]);
  });

  it('skips undefined values but writes an explicit empty string', () => {
    const { customFields } = buildCustomFieldPayload(
      { verdict: undefined, status: '' },
      ids
    );
    expect(customFields).toEqual([{ id: 'ID_STATUS', field_value: '' }]);
  });

  it('clamps oversized text so a runaway reasoning field cannot fail the write', () => {
    const { customFields } = buildCustomFieldPayload({ verdict: 'x'.repeat(9000) }, ids);
    expect(String(customFields[0].field_value).length).toBeLessThanOrEqual(4000);
  });
});

// ─── Request id ───────────────────────────────────────────────────────────────

describe('makeRequestId', () => {
  it('encodes the UTC timestamp so a card can be traced back to a run', () => {
    const id = makeRequestId(new Date(Date.UTC(2026, 7, 30, 16, 47, 6)));
    expect(id.startsWith('PAE-20260830-164706-')).toBe(true);
  });

  it('is unique across calls in the same second', () => {
    const now = new Date(Date.UTC(2026, 7, 30, 16, 47, 6));
    expect(makeRequestId(now)).not.toBe(makeRequestId(now));
  });
});

// ─── Build identity ───────────────────────────────────────────────────────────

describe('resolveBuildInfo', () => {
  const saved = process.env.RAILWAY_GIT_COMMIT_SHA;
  afterEach(() => {
    if (saved === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = saved;
  });

  it('prefers the platform-injected SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(40);
    const info = resolveBuildInfo();
    expect(info.commit).toBe('a'.repeat(40));
    expect(info.commitShort).toBe('aaaaaaa');
    expect(info.commitSource).toBe('RAILWAY_GIT_COMMIT_SHA');
  });

  it('ignores a value that is not a SHA', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'not-a-sha';
    expect(resolveBuildInfo().commitSource).not.toBe('RAILWAY_GIT_COMMIT_SHA');
  });

  it('always reports something rather than throwing', () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    const info = resolveBuildInfo();
    expect(typeof info.commit).toBe('string');
    expect(info.commit.length).toBeGreaterThan(0);
  });
});

// ─── The endpoint contract ────────────────────────────────────────────────────

describe('POST /pae/analyze — fire and forget', () => {
  let server: Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeAll((done) => {
    clearFieldCache();
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    process.env.GHL_API_KEY = 'test_api_key_123';
    process.env.GHL_LOCATION_ID = 'test_location_123';
    // Point the write-back at an unroutable host so the background task fails
    // fast instead of reaching anything real. It must not affect the response.
    process.env.GHL_BASE_URL = 'https://127.0.0.1:9';
    delete process.env.PAE_WEBHOOK_SECRET;

    const app = express();
    app.use(express.json());
    registerPAERoutes(app, noopLog);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    process.env = savedEnv;
    server.close(() => done());
  });

  const post = (body: unknown) =>
    fetch(`${baseUrl}/pae/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('acknowledges well inside GHL\'s webhook timeout', async () => {
    const started = Date.now();
    const res = await post({
      opportunity_id: 'hBkHHNxqu3owNKXjgoTe',
      property_address: '1400 Crazy Horse Rd',
      asking_price: '2250000',
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // The whole point: the old handler took 27-38s here.
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns status accepted with a request id and the target opportunity', async () => {
    const res = await post({
      opportunity_id: 'hBkHHNxqu3owNKXjgoTe',
      property_address: '1400 Crazy Horse Rd',
    });
    const body = await res.json();

    expect(body.status).toBe('accepted');
    expect(body.opportunity_id).toBe('hBkHHNxqu3owNKXjgoTe');
    expect(body.request_id).toMatch(/^PAE-\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(body.error).toBe(false);
  });

  it('carries no verdict — routing must read the opportunity, not the response', async () => {
    const res = await post({ opportunity_id: 'hBkHHNxqu3owNKXjgoTe' });
    const body = await res.json();

    expect(body).not.toHaveProperty('verdict');
    expect(body).not.toHaveProperty('pipeline_route');
    expect(body.result_fields).toEqual(RESULT_FIELDS);
  });

  it('reports which financial fields it received, for auditing the gate', async () => {
    const res = await post({
      opportunity_id: 'hBkHHNxqu3owNKXjgoTe',
      asking_price: '2250000',
      annual_noi: '184000',
      cap_rate: '8.2',
    });
    const body = await res.json();
    expect(body.financial_fields_present).toEqual([
      'asking_price',
      'annual_noi',
      'cap_rate',
    ]);
  });

  it('rejects a payload with no opportunity id rather than accepting orphan work', async () => {
    const res = await post({ property_address: '1400 Crazy Horse Rd' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe('rejected');
    expect(body.error_type).toBe('VALIDATION_ERROR');
  });

  it('rejects an unresolved {{opportunity.id}} merge token', async () => {
    const res = await post({ opportunity_id: '{{opportunity.id}}' });
    expect(res.status).toBe(400);
    expect((await res.json()).error_type).toBe('VALIDATION_ERROR');
  });

  it('accepts opportunityId in camelCase too', async () => {
    const res = await post({ opportunityId: 'hBkHHNxqu3owNKXjgoTe' });
    expect(res.status).toBe(200);
  });
});

describe('POST /pae/analyze — auth and configuration', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const startWith = async (
    env: Record<string, string | undefined>
  ): Promise<{ server: Server; baseUrl: string }> => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const app = express();
    app.use(express.json());
    registerPAERoutes(app, noopLog);
    return new Promise((resolve) => {
      const server = app.listen(0, () =>
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        })
      );
    });
  };

  it('rejects a request with the wrong shared secret', async () => {
    const { server, baseUrl } = await startWith({
      PAE_WEBHOOK_SECRET: 'correct-horse',
      ANTHROPIC_API_KEY: 'sk-test',
    });
    try {
      const res = await fetch(`${baseUrl}/pae/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pae-secret': 'wrong' },
        body: JSON.stringify({ opportunity_id: 'hBkHHNxqu3owNKXjgoTe' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('fails loudly when there is nowhere to write results back to', async () => {
    // Accepting work whose output would vanish is the exact silent-failure
    // class this rebuild exists to eliminate.
    const { server, baseUrl } = await startWith({
      PAE_WEBHOOK_SECRET: undefined,
      ANTHROPIC_API_KEY: 'sk-test',
      GHL_API_KEY: undefined,
      GHL_LOCATION_ID: undefined,
    });
    try {
      const res = await fetch(`${baseUrl}/pae/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_id: 'hBkHHNxqu3owNKXjgoTe' }),
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error_type).toBe('CONFIG_ERROR');
    } finally {
      server.close();
    }
  });
});
