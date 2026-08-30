// PAE-W2 — Pre-Analysis Engine workflow definition.
//
// This file IS the source of truth for the workflow's action graph. GHL has no
// version control, so the shape lives here and is applied through the API.
//
// Restructure: the router used to branch on custom_webhook.1.response.verdict,
// which was always empty because the analysis (27-38s) outran GHL's webhook
// timeout — every deal fell to the None catch-all while the note it wrote
// rendered "Verdict:" as a blank. The opportunity is now created BEFORE the
// webhook so the analyzer has somewhere to write, the workflow waits, and the
// router branches on the stored opportunity custom field.
//
//   Create/Update Contact
//     -> internal_create_opportunity   (REVIEW stage, source "… — PENDING")
//     -> internal_update_opportunity   (paew2_status = QUEUED)
//     -> custom_webhook                (POST /pae/analyze, returns in <1s)
//     -> wait 5 minutes
//     -> if_else on opportunity.paew2_verdict
//          PROCEED / WHOLESALE / REVIEW / PASS / None
//
// Apply it:
//
//   node scripts/pae-w2-workflow.mjs > /tmp/w2.json
//   curl -s -X POST https://ghlmcp.real-solutions-llc.com/tools/call \
//        -H 'Content-Type: application/json' --data-binary @/tmp/w2.json
//
// Then read it back with ghl_get_workflow_full to confirm the save landed.
//
// Notes from getting this past GHL's validator:
//  - Every action id must be a real UUID. Hex digits only; 'w'/'x' are rejected
//    with "ID: Invalid uuid" and the whole save is refused (atomically — nothing
//    is half-written).
//  - The wait unit is plural: "minutes", not "minute".
//  - Terminal nodes pass next: '' — the workflow client turns an empty next into
//    an omitted key, which is what GHL wants. An explicit [] or null is rejected.
//  - Triggers are deliberately not sent, which leaves the existing
//    inbound_webhook trigger untouched. The API cannot create a trigger.

const PIPELINE = '82R6U3R253VjBuEA8OY0';
const STAGE = {
  PROCEED:   'da53850d-96a3-4781-b672-0898e14867a2',
  WHOLESALE: 'ea47f1e4-ed55-441f-b071-bfc32baf5798',
  REVIEW:    '1a528963-698f-403f-abfe-411542a710b9',
};

// Opportunity custom field IDs (model: opportunity, location T0EYPXXzbxqjVy81nxnW)
const CF = {
  status:            'BqtpGvygZRSdG153MUQQ', // paew2_status
  verdict:           'mr8amrnczRmsDPbP9z0E', // paew2_verdict
  composite_score:   '32vRbfHzhtYDPsyKU4os', // paew2_composite_score
  pipeline_route:    'WN3d2tSJYnXzzqc0haj2', // paew2_pipeline_route
  reasoning:         'Bis3dozgy9K2woBuGuNW', // paew2_reasoning
  key_risks:         'HAMdLbRXwF34pSa55uWT', // paew2_key_risks
  data_completeness: 'x1fLsUvOixnaTqVtkQFK', // paew2_data_completeness
  top_risk:          '3McriEh22DsIshQsuVTr', // paew2_top_risk
  analysis_ts:       'NYoSdSUG9O8gtVOnH5s0', // paew2_analysis_timestamp
  request_id:        'CdXWhmWlkilYkZjVWrUu', // paew2_request_id
  missing_fields:    'olHwfbwaATZPb6nnSaMi', // paew2_missing_fields
  error:             'EwUrys6gHRGr1x0uSLFG', // paew2_error
};

// ── Notification targeting ────────────────────────────────────────────────────
// Steven is the sole recipient for now; team members are expected later, so the
// recipient lives here rather than being spelled out at each of the four
// notification sites.
//
// The in-app channel CAN target one user, and this is a verified shape, not a
// guess: CS-W2, CS-W4, CS-W7 and D4D Property Tracker are published workflows in
// this same location that all target this exact user id this exact way.
//
//   notification: { type: 'send_notification', userType: 'user',
//                   selectedUser: '<user id>' }
//
// The EMAIL channel is a different story — see EMAIL_USER_TYPE below.
//
// To add a team member later: `selectedUser` is singular, so either duplicate
// the notification node with a second id, or switch inApp.userType to 'all'
// (everyone) or 'assign' (the assigned user).
const NOTIFY = {
  inApp: {
    userType: 'user',
    // Steven Buysman, admin on T0EYPXXzbxqjVy81nxnW. Resolved via get_users.
    // NB: his GHL account email is realsolutions605@gmail.com — there is no
    // user on this location with the address Steven@real-solutions-llc.com.
    selectedUser: 'CQjAW9lECxfufIUTdJPK',
  },
  // Email recipients. Left at 'all' deliberately.
  //
  // Every internal_notification in this location that carries an email block
  // uses a top-level userType of 'all' or 'assign' — there is NO observed
  // example of a specific-user email target, and the symmetric guess
  // (top-level userType 'user' + selectedUser) is exactly the kind of
  // configuration that can look right and reach nobody. That is the failure
  // class this whole project exists to eliminate, so it is not being invented
  // here. 'assign' was also rejected: PAE-W2 sets no assignee, so it would
  // resolve to nobody.
  //
  // To close this: set ONE notification to a specific user WITH email enabled
  // in the GHL UI, then read the action back with ghl_get_workflow_full and
  // copy the real shape here.
  emailUserType: 'all',
};

// Stable node IDs so re-running this is idempotent.
// GHL validates every action id as a real UUID — hex digits only.
const N = {
  contact:   'a2000001-1111-4111-8111-000000000001',
  createOpp: 'a2000002-1111-4111-8111-000000000002',
  markQueued:'a2000003-1111-4111-8111-000000000003',
  webhook:   'a2000004-1111-4111-8111-000000000004',
  wait:      'a2000005-1111-4111-8111-000000000005',
  router:    'a2000006-1111-4111-8111-000000000006',
};
const BRANCH = {
  PROCEED:   'b2000001-1111-4111-8111-0000000000b1',
  WHOLESALE: 'b2000002-1111-4111-8111-0000000000b2',
  REVIEW:    'b2000003-1111-4111-8111-0000000000b3',
  PASS:      'b2000004-1111-4111-8111-0000000000b4',
  NONE:      'b2000005-1111-4111-8111-0000000000b5',
};
/** Branch-body node ids, one row per branch: [step1, step2, step3]. */
const BODY = {
  PROCEED:   ['c2000001-1111-4111-8111-0000000000c1', 'c2000002-1111-4111-8111-0000000000c2', 'c2000003-1111-4111-8111-0000000000c3'],
  WHOLESALE: ['d2000001-1111-4111-8111-0000000000d1', 'd2000002-1111-4111-8111-0000000000d2', 'd2000003-1111-4111-8111-0000000000d3'],
  REVIEW:    ['e2000001-1111-4111-8111-0000000000e1', 'e2000002-1111-4111-8111-0000000000e2', 'e2000003-1111-4111-8111-0000000000e3'],
  PASS:      ['f2000001-1111-4111-8111-0000000000f1', 'f2000002-1111-4111-8111-0000000000f2'],
  NONE:      ['02000001-1111-4111-8111-000000000021', '02000002-1111-4111-8111-000000000022', '02000003-1111-4111-8111-000000000023'],
};

// The deal fields forwarded to /pae/analyze. The old body carried 20 keys and
// the handler dropped anything outside its allowlist; these are the fields real
// deals actually arrive with, including the twelve that used to be discarded.
const WEBHOOK_BODY = {
  // Routing — opportunity_id is what the analyzer writes its result back onto.
  opportunity_id: '{{opportunity.id}}',
  contact_id: '{{contact.id}}',

  // Identity and provenance
  property_address: '{{inboundWebhookRequest.property_address}}',
  asset_class: '{{inboundWebhookRequest.asset_class}}',
  property_type: '{{inboundWebhookRequest.property_type}}',
  geography: '{{inboundWebhookRequest.geography}}',
  market: '{{inboundWebhookRequest.market}}',
  state: '{{inboundWebhookRequest.state}}',
  deal_source: '{{inboundWebhookRequest.deal_source}}',
  submitter_name: '{{inboundWebhookRequest.submitter_name}}',
  submitter_email: '{{inboundWebhookRequest.submitter_email}}',
  submission_date: '{{inboundWebhookRequest.submission_date}}',

  // Physical characteristics
  unit_count: '{{inboundWebhookRequest.unit_count}}',
  bedrooms: '{{inboundWebhookRequest.bedrooms}}',
  bathrooms: '{{inboundWebhookRequest.bathrooms}}',
  sqft: '{{inboundWebhookRequest.sqft}}',
  lot_size: '{{inboundWebhookRequest.lot_size}}',
  year_built: '{{inboundWebhookRequest.year_built}}',
  condition: '{{inboundWebhookRequest.condition}}',
  occupancy_status: '{{inboundWebhookRequest.occupancy_status}}',
  occupancy_rate: '{{inboundWebhookRequest.occupancy_rate}}',
  lease_terms: '{{inboundWebhookRequest.lease_terms}}',

  // Financial — the ten the Section 1 completeness gate counts
  asking_price: '{{inboundWebhookRequest.asking_price}}',
  estimated_value: '{{inboundWebhookRequest.estimated_value}}',
  monthly_rent_actual: '{{inboundWebhookRequest.monthly_rent_actual}}',
  monthly_rent_market: '{{inboundWebhookRequest.monthly_rent_market}}',
  annual_noi: '{{inboundWebhookRequest.annual_noi}}',
  cap_rate: '{{inboundWebhookRequest.cap_rate}}',
  mortgage_balance: '{{inboundWebhookRequest.mortgage_balance}}',
  seller_equity_pct: '{{inboundWebhookRequest.seller_equity_pct}}',
  rehab_estimate: '{{inboundWebhookRequest.rehab_estimate}}',
  cash_flow_per_door: '{{inboundWebhookRequest.cash_flow_per_door}}',

  // Financial — everything else
  arv: '{{inboundWebhookRequest.arv}}',
  repair_estimate: '{{inboundWebhookRequest.repair_estimate}}',
  property_taxes: '{{inboundWebhookRequest.property_taxes}}',
  insurance_estimate: '{{inboundWebhookRequest.insurance_estimate}}',
  hoa_fees: '{{inboundWebhookRequest.hoa_fees}}',
  revenue_current: '{{inboundWebhookRequest.revenue_current}}',
  operating_expenses: '{{inboundWebhookRequest.operating_expenses}}',
  financing_terms: '{{inboundWebhookRequest.financing_terms}}',
  seller_motivation: '{{inboundWebhookRequest.seller_motivation}}',
  motivation_level: '{{inboundWebhookRequest.motivation_level}}',
  timeline: '{{inboundWebhookRequest.timeline}}',

  // Free text
  notes: '{{inboundWebhookRequest.notes}}',
  additional_notes: '{{inboundWebhookRequest.additional_notes}}',
};

const cif = (filterField, value, extra = {}) => ({
  __customInputs__: {},
  filterField,
  value,
  ...extra,
});

/** internal_update_opportunity node writing custom fields and/or a stage. */
const updateOpp = (id, name, parentKey, next, fields) => ({
  id,
  type: 'internal_update_opportunity',
  name,
  parentKey,
  next,
  workflowsActionType: 'INTERNAL',
  attributes: {
    allowBackward: true,
    type: 'internal_update_opportunity',
    pipelineId: PIPELINE,
    __customInputFields__: fields,
    __customInputs__: {},
  },
});

// ── Notification vs note: the division of labour ──────────────────────────────
// The notification tells you enough to decide whether to act. The note holds the
// whole analysis. The card holds the structured fields.
//
// Every analysis token below is an {{opportunity.paew2_*}} custom field written
// by the async analyzer. None of them come from the webhook response any more —
// that response is an acknowledgement and carries no verdict. The old
// {{custom_webhook.1.response.*}} tokens are what rendered BLANK in testing.
//
// The server writes a definite value into every field that appears in a
// notification ("None identified", "No reasoning returned by the analysis."),
// so an absent value reads as an answer rather than as empty space.

/**
 * The alert body: decision first, then enough substance to triage without
 * opening the card.
 *
 * Deliberately omits pipeline_route — it now carries real information, but in a
 * short alert it only restates the verdict. It stays in the note.
 */
const ALERT_HTML = (routeLine) =>
  `<p><strong>${routeLine}</strong></p>` +
  '<p><strong>Verdict:</strong> {{opportunity.paew2_verdict}} &nbsp;·&nbsp; ' +
  '<strong>Score:</strong> {{opportunity.paew2_composite_score}}/100</p>' +
  '<p><strong>Why:</strong> {{opportunity.paew2_reasoning}}</p>' +
  '<p><strong>Top risk:</strong> {{opportunity.paew2_top_risk}}</p>' +
  '<hr>' +
  '<p><strong>Property:</strong> {{inboundWebhookRequest.property_address}}</p>' +
  '<p><strong>Asking price:</strong> {{inboundWebhookRequest.asking_price}}</p>' +
  '<p><strong>Submitter:</strong> {{inboundWebhookRequest.submitter_name}} ' +
  '({{inboundWebhookRequest.submitter_email}})</p>';

/** The push/in-app body. Same substance, no markup, short enough to read on a phone. */
const ALERT_TEXT = (routeLine) =>
  `${routeLine}\n` +
  'Verdict: {{opportunity.paew2_verdict}} · Score: {{opportunity.paew2_composite_score}}/100\n' +
  'Why: {{opportunity.paew2_reasoning}}\n' +
  'Top risk: {{opportunity.paew2_top_risk}}\n' +
  '{{inboundWebhookRequest.property_address}} · Asking {{inboundWebhookRequest.asking_price}}\n' +
  'From: {{inboundWebhookRequest.submitter_name}}';

/** The note: the complete record, including everything the alert leaves out. */
const FULL_RECORD_HTML = (routeLine) =>
  `<p><strong>Routing decision:</strong> ${routeLine}</p>` +
  '<p><strong>Verdict:</strong> {{opportunity.paew2_verdict}}</p>' +
  '<p><strong>Composite score:</strong> {{opportunity.paew2_composite_score}}/100</p>' +
  '<p><strong>Analysis status:</strong> {{opportunity.paew2_status}}</p>' +
  '<p><strong>Pipeline route:</strong> {{opportunity.paew2_pipeline_route}}</p>' +
  '<p><strong>Reasoning:</strong> {{opportunity.paew2_reasoning}}</p>' +
  '<p><strong>Top risk:</strong> {{opportunity.paew2_top_risk}}</p>' +
  '<p><strong>All key risks:</strong> {{opportunity.paew2_key_risks}}</p>' +
  '<p><strong>Data completeness:</strong> {{opportunity.paew2_data_completeness}}%</p>' +
  '<p><strong>Missing fields:</strong> {{opportunity.paew2_missing_fields}}</p>' +
  '<p><strong>Error:</strong> {{opportunity.paew2_error}}</p>' +
  '<p><strong>Analysed at:</strong> {{opportunity.paew2_analysis_timestamp}} ' +
  '(request {{opportunity.paew2_request_id}})</p>' +
  '<hr>' +
  '<p><strong>Property:</strong> {{inboundWebhookRequest.property_address}}</p>' +
  '<p><strong>Asking price:</strong> {{inboundWebhookRequest.asking_price}}</p>' +
  '<p><strong>Asset class:</strong> {{inboundWebhookRequest.asset_class}}</p>' +
  '<p><strong>Submitter:</strong> {{inboundWebhookRequest.submitter_name}} ' +
  '({{inboundWebhookRequest.submitter_email}})</p>';

const notify = (id, name, parentKey, next, subject, routeLine, opts = {}) => ({
  id,
  type: 'internal_notification',
  name,
  parentKey,
  next,
  attributes: {
    type: 'notification',
    userType: NOTIFY.emailUserType,
    email: {
      subject,
      html: opts.html || ALERT_HTML(routeLine),
    },
    sms: { body: '' },
    whatsapp: { body: '' },
    notification: {
      type: 'send_notification',
      title: subject,
      body: opts.text || ALERT_TEXT(routeLine),
      redirectPage: 'opportunity',
      userType: NOTIFY.inApp.userType,
      selectedUser: NOTIFY.inApp.selectedUser,
    },
  },
});

const note = (id, name, parentKey, color, title, routeLine, html) => ({
  id,
  type: 'add_notes',
  name,
  parentKey,
  next: '', // terminal — the client turns an empty next into an omitted key
  attributes: {
    type: 'add_notes',
    color,
    title,
    html: html || FULL_RECORD_HTML(routeLine),
  },
});

/** One verdict condition on the stored opportunity custom field. */
const verdictBranch = (branchId, label, value, seq) => ({
  id: branchId,
  name: label,
  operator: 'and',
  showErrors: false,
  branchNameError: 'Branch name cannot be empty!',
  segments: [
    {
      __segmentId: `3200000${seq}-1111-4111-8111-00000000005${seq}`,
      operator: 'and',
      conditions: [
        {
          conditionType: 'opportunities',
          conditionSubType: CF.verdict,
          conditionOperator: '==',
          conditionValue: value,
          __conditionId: `4200000${seq}-1111-4111-8111-00000000006${seq}`,
          ifElseNodeId: '',
          __customFieldType__: 'standard',
          isWait: false,
          nestedDropdownTypes: [
            'inboundWebhookRequest', 'sheet', 'datetime_formatter', 'custom_webhook',
            'array_functions', 'ivr_gather', 'ivr_connect_call', 'custom_code',
            'ai_agent', 'task-notification',
          ],
          allowIsOperatorTypes: [
            'contact_reply', 'inboundWebhookRequest', 'custom_webhook', 'custom_code',
            'ai_agent', 'contact_detail', 'array_functions', 'appointment',
            'service_booking', 'rental_booking',
          ],
        },
      ],
    },
  ],
});

const branchNode = (id, name, parentKey, next) => ({
  id,
  type: 'if_else',
  name,
  cat: 'conditions',
  nodeType: 'branch-yes',
  parentKey,
  next,
  attributes: { if: false, conditionName: 'Condition', operator: 'and', branches: [] },
});

const actions = [
  // ── 1. Contact ─────────────────────────────────────────────────────────────
  {
    id: N.contact,
    type: 'create_update_contact',
    name: 'Create/Update Contact',
    next: N.createOpp,
    attributes: {
      type: 'create_update_contact',
      fields: [
        { field: 'email', value: '{{inboundWebhookRequest.submitter_email}}', title: 'Email', type: 'string', date: '' },
        { field: 'firstName', value: '{{inboundWebhookRequest.submitter_name}}', title: 'First Name', type: 'string', date: '' },
      ],
    },
  },

  // ── 2. Create the deal record UP FRONT ─────────────────────────────────────
  // The analyzer needs an opportunity to write onto, and the router needs one to
  // read from. Both branches used to create their own card AFTER the router, so
  // there was nothing to write to at webhook time.
  {
    id: N.createOpp,
    type: 'internal_create_opportunity',
    name: 'PAE — Create Deal Record',
    parentKey: N.contact,
    next: N.markQueued,
    workflowsActionType: 'INTERNAL',
    attributes: {
      pipelineId: PIPELINE,
      type: 'internal_create_opportunity',
      __customInputFields__: [
        cif('pipelineStageId', STAGE.REVIEW, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
        cif('name', '{{inboundWebhookRequest.property_address}}', { dataType: 'TEXT', valueFieldType: 'string' }),
        cif('source', 'Pre-Analysis Engine — PENDING', { dataType: 'TEXT', valueFieldType: 'string' }),
      ],
      __customInputs__: {},
    },
  },

  // ── 3. Stamp QUEUED before calling out ─────────────────────────────────────
  // Written by GHL, not by the server, so a card that never reached
  // /pae/analyze is distinguishable from one whose analysis died mid-run.
  // Fields that appear in an alert get a definite value here too, so a card
  // stuck at QUEUED renders sentences rather than empty lines.
  updateOpp(N.markQueued, 'PAE — Mark Analysis Queued', N.createOpp, N.webhook, [
    cif(`custom_fields.${CF.status}`, 'QUEUED', { dataType: 'TEXT', valueFieldType: 'string' }),
    cif(`custom_fields.${CF.verdict}`, '', { dataType: 'TEXT', valueFieldType: 'string' }),
    cif(`custom_fields.${CF.pipeline_route}`, '', { dataType: 'TEXT', valueFieldType: 'string' }),
    cif(`custom_fields.${CF.error}`, '(not started — queued, webhook not yet answered)', { dataType: 'TEXT', valueFieldType: 'textarea' }),
    cif(`custom_fields.${CF.reasoning}`, 'Analysis has not run yet.', { dataType: 'TEXT', valueFieldType: 'textarea' }),
    cif(`custom_fields.${CF.top_risk}`, 'Analysis has not run yet.', { dataType: 'TEXT', valueFieldType: 'string' }),
    cif(`custom_fields.${CF.missing_fields}`, 'Analysis has not run yet.', { dataType: 'TEXT', valueFieldType: 'textarea' }),
  ]),

  // ── 4. Fire and forget ─────────────────────────────────────────────────────
  {
    id: N.webhook,
    type: 'custom_webhook',
    name: 'PAE Analyze (async — acknowledgement only)',
    parentKey: N.markQueued,
    next: N.wait,
    attributes: {
      event: 'CUSTOM',
      method: 'POST',
      url: 'https://ghlmcp.real-solutions-llc.com/pae/analyze',
      body: {
        contentType: 'application/json',
        rawData: JSON.stringify(WEBHOOK_BODY, null, 2),
        keyValueData: [],
      },
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'x-pae-secret', value: 'pae-real2026' },
      ],
      parameters: [],
      authorization: { type: 'NONE', data: null },
      // The response is an acknowledgement, not a verdict. Kept only so the run
      // log shows the request id; nothing downstream branches on it.
      saveResponse: true,
      webhookResponse: {
        recordType: 'contact',
        loading: false,
        isSampleRequested: true,
        data: {
          status: 'accepted',
          request_id: 'PAE-20260830-000000-00000000',
          opportunity_id: 'xxxxxxxxxxxxxxxxxxxx',
        },
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    },
  },

  // ── 5. Wait for the analysis to land ───────────────────────────────────────
  // Measured runs: 27.5s - 38.3s. Five minutes is a wide margin over that and
  // over a retry inside the analyzer.
  {
    id: N.wait,
    type: 'wait',
    name: 'Wait 5 Minutes for Analysis',
    parentKey: N.webhook,
    next: N.router,
    attributes: {
      type: 'time',
      startAfter: { type: 'minutes', value: 5, when: 'after' },
      name: 'Wait 5 Minutes for Analysis',
      cat: '',
      timePeriodInputMode: 'standard',
      unitInputMode: 'standard',
      isHybridAction: true,
      hybridActionType: 'wait',
      convertToMultipath: false,
      transitions: [],
    },
  },

  // ── 6. Route on the STORED field, not on a response body ───────────────────
  {
    id: N.router,
    type: 'if_else',
    name: 'Verdict Router',
    cat: 'conditions',
    nodeType: 'condition-node',
    parentKey: N.wait,
    next: [BRANCH.PROCEED, BRANCH.WHOLESALE, BRANCH.REVIEW, BRANCH.PASS, BRANCH.NONE],
    attributes: {
      currentRecipeType: 'CUSTOM',
      operator: 'and',
      if: true,
      conditionName: 'Verdict Router (opportunity.paew2_verdict)',
      version: 2,
      noneBranchName: 'None',
      branches: [
        verdictBranch(BRANCH.PROCEED, 'PROCEED', 'PROCEED', 1),
        verdictBranch(BRANCH.WHOLESALE, 'WHOLESALE', 'WHOLESALE', 2),
        verdictBranch(BRANCH.REVIEW, 'REVIEW', 'REVIEW', 3),
        verdictBranch(BRANCH.PASS, 'PASS', 'PASS', 4),
      ],
    },
  },

  // ── PROCEED ────────────────────────────────────────────────────────────────
  branchNode(BRANCH.PROCEED, 'PROCEED', N.router, BODY.PROCEED[0]),
  updateOpp(
    BODY.PROCEED[0],
    'PROCEED — Move to PROCEED Stage',
    BRANCH.PROCEED,
    BODY.PROCEED[1],
    [
      cif('pipelineStageId', STAGE.PROCEED, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
      cif('source', 'Pre-Analysis Engine — PROCEED', { dataType: 'TEXT', valueFieldType: 'string' }),
    ]
  ),
  notify(
    BODY.PROCEED[1],
    'PROCEED — Notify Steven',
    BODY.PROCEED[0],
    BODY.PROCEED[2],
    'PROCEED · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'PROCEED — moved to the PROCEED stage of the Deal Flow pipeline.'
  ),
  note(
    BODY.PROCEED[2],
    'PROCEED — Add Analysis Note',
    BODY.PROCEED[1],
    '#D5F5E3',
    'PROCEED · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'PROCEED — moved to the PROCEED stage of the Deal Flow pipeline.'
  ),

  // ── WHOLESALE ──────────────────────────────────────────────────────────────
  branchNode(BRANCH.WHOLESALE, 'WHOLESALE', N.router, BODY.WHOLESALE[0]),
  updateOpp(
    BODY.WHOLESALE[0],
    'WHOLESALE — Move to WHOLESALE Stage',
    BRANCH.WHOLESALE,
    BODY.WHOLESALE[1],
    [
      cif('pipelineStageId', STAGE.WHOLESALE, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
      cif('source', 'Pre-Analysis Engine — WHOLESALE', { dataType: 'TEXT', valueFieldType: 'string' }),
    ]
  ),
  notify(
    BODY.WHOLESALE[1],
    'WHOLESALE — Notify Steven',
    BODY.WHOLESALE[0],
    BODY.WHOLESALE[2],
    'WHOLESALE · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'WHOLESALE — moved to the WHOLESALE stage of the Deal Flow pipeline.'
  ),
  note(
    BODY.WHOLESALE[2],
    'WHOLESALE — Add Analysis Note',
    BODY.WHOLESALE[1],
    '#FCF3CF',
    'WHOLESALE · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'WHOLESALE — moved to the WHOLESALE stage of the Deal Flow pipeline.'
  ),

  // ── REVIEW ─────────────────────────────────────────────────────────────────
  branchNode(BRANCH.REVIEW, 'REVIEW', N.router, BODY.REVIEW[0]),
  updateOpp(
    BODY.REVIEW[0],
    'REVIEW — Hold in REVIEW Stage',
    BRANCH.REVIEW,
    BODY.REVIEW[1],
    [
      cif('pipelineStageId', STAGE.REVIEW, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
      cif('source', 'Pre-Analysis Engine — REVIEW', { dataType: 'TEXT', valueFieldType: 'string' }),
    ]
  ),
  notify(
    BODY.REVIEW[1],
    'REVIEW — Notify Steven',
    BODY.REVIEW[0],
    BODY.REVIEW[2],
    'REVIEW · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'REVIEW — held in the REVIEW stage for human judgement.'
  ),
  note(
    BODY.REVIEW[2],
    'REVIEW — Add Analysis Note',
    BODY.REVIEW[1],
    '#D6EAF8',
    'REVIEW · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'REVIEW — held in the REVIEW stage for human judgement.'
  ),

  // ── PASS ───────────────────────────────────────────────────────────────────
  // A genuine PASS is a completed analysis and must not look like one that never
  // ran. It gets its own branch, its own source, and — per Section 7 rule 6 —
  // no notification.
  branchNode(BRANCH.PASS, 'PASS', N.router, BODY.PASS[0]),
  updateOpp(
    BODY.PASS[0],
    'PASS — Mark Passed',
    BRANCH.PASS,
    BODY.PASS[1],
    [
      cif('pipelineStageId', STAGE.REVIEW, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
      cif('source', 'Pre-Analysis Engine — PASS', { dataType: 'TEXT', valueFieldType: 'string' }),
    ]
  ),
  note(
    BODY.PASS[1],
    'PASS — Add Analysis Note',
    BODY.PASS[0],
    '#EAEDED',
    'PASS · {{opportunity.paew2_composite_score}}/100 · {{inboundWebhookRequest.property_address}}',
    'PASS — analysis completed and found no acquisition or disposition path. ' +
      'No notification sent (PASS is silent by design). This is a FINISHED ' +
      'analysis, not a missing one: paew2_status reads COMPLETE.'
  ),

  // ── None — the catch-all, and the loud failure path ────────────────────────
  {
    id: BRANCH.NONE,
    type: 'if_else',
    name: 'None',
    cat: 'conditions',
    nodeType: 'branch-no',
    parentKey: N.router,
    next: BODY.NONE[0],
    attributes: { else: true },
  },
  updateOpp(
    BODY.NONE[0],
    'UNROUTED — Flag for Manual Routing',
    BRANCH.NONE,
    BODY.NONE[1],
    [
      cif('pipelineStageId', STAGE.REVIEW, { dataType: 'SINGLE_OPTIONS', valueFieldType: 'select' }),
      cif('source', 'Pre-Analysis Engine — UNROUTED', { dataType: 'TEXT', valueFieldType: 'string' }),
    ]
  ),
  // The UNROUTED alert must never present empty fields as a result. It reports
  // the ABSENCE of a verdict as the finding, and renders status and error —
  // both of which the server keeps definite — instead of verdict/score/reasoning,
  // which are exactly the fields that have nothing in them here.
  notify(
    BODY.NONE[1],
    'UNROUTED — Notify Steven (analysis did not complete)',
    BODY.NONE[0],
    BODY.NONE[2],
    'NO VERDICT — analysis did not complete · {{inboundWebhookRequest.property_address}}',
    '',
    {
      html:
        '<p><strong>No verdict was stored for this deal. Nothing was decided. ' +
        'This is NOT a PASS.</strong></p>' +
        '<p><strong>Analysis status:</strong> {{opportunity.paew2_status}}<br>' +
        '<em>QUEUED</em> = /pae/analyze was never reached · ' +
        '<em>ANALYZING</em> = the run died mid-analysis · ' +
        '<em>FAILED</em> = it errored, see below.</p>' +
        '<p><strong>Error:</strong> {{opportunity.paew2_error}}</p>' +
        '<p><strong>Request id:</strong> {{opportunity.paew2_request_id}}</p>' +
        '<hr>' +
        '<p>Card parked in REVIEW, source "Pre-Analysis Engine — UNROUTED", ' +
        'awaiting manual routing.</p>' +
        '<p><strong>Property:</strong> {{inboundWebhookRequest.property_address}}</p>' +
        '<p><strong>Asking price:</strong> {{inboundWebhookRequest.asking_price}}</p>' +
        '<p><strong>Submitter:</strong> {{inboundWebhookRequest.submitter_name}} ' +
        '({{inboundWebhookRequest.submitter_email}})</p>',
      text:
        'NO VERDICT — nothing was decided. This is NOT a PASS.\n' +
        'Analysis status: {{opportunity.paew2_status}}\n' +
        'Error: {{opportunity.paew2_error}}\n' +
        '{{inboundWebhookRequest.property_address}} · Asking {{inboundWebhookRequest.asking_price}}\n' +
        'From: {{inboundWebhookRequest.submitter_name}}\n' +
        'Card parked in REVIEW for manual routing.',
    }
  ),
  {
    id: BODY.NONE[2],
    type: 'add_notes',
    name: 'UNROUTED — Add Analysis Note',
    parentKey: BODY.NONE[1],
    next: '',
    attributes: {
      type: 'add_notes',
      color: '#FADBD8',
      title: 'NO VERDICT — analysis did not complete · {{inboundWebhookRequest.property_address}}',
      html:
        '<p><strong>Routing decision:</strong> UNROUTED — no verdict was stored on ' +
        'this opportunity, so none of the PROCEED / WHOLESALE / REVIEW / PASS branches ' +
        'matched. <strong>This is not a PASS.</strong> Nothing was decided about this ' +
        'deal.</p>' +
        '<p><strong>Analysis status:</strong> {{opportunity.paew2_status}}<br>' +
        '<em>QUEUED</em> = PAE-W2 stamped the card but /pae/analyze was never reached.<br>' +
        '<em>ANALYZING</em> = the endpoint accepted the work and the run died before ' +
        'writing a verdict.<br>' +
        '<em>FAILED</em> = the run ended in a handled error; see Error below.<br>' +
        '<em>(blank)</em> = the workflow never reached the stamping step at all.</p>' +
        '<p><strong>Error:</strong> {{opportunity.paew2_error}}</p>' +
        '<p><strong>Request id:</strong> {{opportunity.paew2_request_id}} — search the ' +
        'Railway logs for this to find the run.</p>' +
        '<p><strong>Last written at:</strong> {{opportunity.paew2_analysis_timestamp}}</p>' +
        '<hr>' +
        '<p>Card parked in REVIEW with source "Pre-Analysis Engine — UNROUTED" for ' +
        'manual routing. Re-submitting the deal will start a fresh analysis on a new ' +
        'card.</p>' +
        '<p><strong>Property:</strong> {{inboundWebhookRequest.property_address}}</p>' +
        '<p><strong>Asking price:</strong> {{inboundWebhookRequest.asking_price}}</p>' +
        '<p><strong>Asset class:</strong> {{inboundWebhookRequest.asset_class}}</p>' +
        '<p><strong>Submitter:</strong> {{inboundWebhookRequest.submitter_name}} ' +
        '({{inboundWebhookRequest.submitter_email}})</p>',
    },
  },
];

process.stdout.write(
  JSON.stringify(
    {
      name: 'ghl_update_workflow_actions',
      arguments: {
        workflowId: 'd2a02519-bc49-4f5b-bd04-4a1b77182a71',
        name: 'PAE-W2 — Pre-Analysis Engine',
        status: 'published',
        allowMultipleOpportunity: true,
        actions,
      },
    },
    null,
    2
  )
);
