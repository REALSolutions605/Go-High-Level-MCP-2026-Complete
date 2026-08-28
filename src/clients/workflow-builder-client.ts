/**
 * GHL Workflow Builder Client
 * 
 * Uses the hidden internal GHL workflow API at backend.leadconnectorhq.com/workflow.
 * Auth via Firebase token refresh (browser-free).
 * 
 * The public GHL API only lists workflows — this client can CREATE, UPDATE, DELETE,
 * PUBLISH, and CLONE workflows with full action/trigger support.
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Types ──────────────────────────────────────────────────

export interface WorkflowAction {
  id?: string;
  order?: number;
  name: string;
  type: string;
  attributes?: Record<string, unknown>;
  /**
   * Outgoing edge(s).
   *  - Non-branching node: a SCALAR string (GHL rejects arrays here with
   *    `non-branching-next-is-array`).
   *  - Branch/router node (cat: 'conditions'/'multi-path', nodeType:
   *    'condition-node'): an ARRAY of branch node IDs.
   *  - Terminal node: omitted entirely (an empty array is still an array
   *    and is rejected).
   */
  next?: string | string[];
  parentKey?: string;
  parent?: string;
  cat?: string;
  nodeType?: string;
  sibling?: string[];
}

export interface WorkflowTrigger {
  id?: string;
  type: string;
  name?: string;
  workflowId?: string;
  data?: Record<string, unknown>;
  /**
   * GHL returns trigger documents with fields we do not model (filters, key,
   * eventType, locationId, ...). Keep them so a read → write round-trip
   * (clone, in particular) does not silently drop trigger configuration.
   */
  [key: string]: unknown;
}

export interface WorkflowListItem {
  _id: string;
  name: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowFull {
  _id: string;
  name: string;
  status: string;
  version: number;
  dataVersion?: number;
  timezone?: string;
  workflowData?: {
    templates: WorkflowAction[];
  };
  triggers?: WorkflowTrigger[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WorkflowBuilderConfig {
  apiKey: string;
  firebaseApiKey: string;
  firebaseRefreshToken: string;
  /** v2 JWT refresh token (30-day, preferred over Firebase) */
  refreshToken?: string;
  locationId: string;
  userId: string;
  companyId?: string;
  envFilePath?: string;
}

// ─── Client ─────────────────────────────────────────────────

export class WorkflowBuilderClient {
  private config: WorkflowBuilderConfig;
  private cachedIdToken: string | null = null;
  private cachedJwt: string | null = null;
  private tokenExpiry: number = 0;

  private static readonly BASE_URL = 'https://backend.leadconnectorhq.com/workflow';
  private static readonly FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
  private static readonly JWT_REFRESH_URL = 'https://services.leadconnectorhq.com/auth/refresh';
  private static readonly TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutes (tokens last 60)

  constructor(config: WorkflowBuilderConfig) {
    this.config = config;
  }

  /**
   * Create from environment variables. Reads from the workflow builder .env file
   * and falls back to process.env.
   */
  static fromEnv(): WorkflowBuilderClient {
    // Try loading from the skill's .env file
    const skillEnvPath = resolve(
      process.env.HOME || '/Users/jakeshore',
      '.clawdbot/workspace/skills/ghl-workflow-builder/.env'
    );

    const envVars: Record<string, string> = {};

    // Load skill env file
    if (existsSync(skillEnvPath)) {
      for (const line of readFileSync(skillEnvPath, 'utf8').split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const key = line.slice(0, eqIdx).trim();
          const val = line.slice(eqIdx + 1).trim();
          if (key && val) envVars[key] = val;
        }
      }
    }

    // Process.env overrides
    const get = (key: string): string => process.env[key] || envVars[key] || '';

    const config: WorkflowBuilderConfig = {
      apiKey: get('GHL_API_KEY'),
      firebaseApiKey: get('GHL_FIREBASE_API_KEY'),
      firebaseRefreshToken: get('GHL_FIREBASE_REFRESH_TOKEN'),
      refreshToken: get('GHL_REFRESH_TOKEN') || get('GHL_AUTH_REFRESH_TOKEN'),
      locationId: get('GHL_LOCATION_ID') || 'DZEpRd43MxUJKdtrev9t',
      userId: get('GHL_USER_ID') || '8Uy3ls0B517vLO2tSNva',
      companyId: get('GHL_COMPANY_ID'),
      envFilePath: skillEnvPath,
    };

    // v2 JWT refresh is preferred; fall back to Firebase
    if (!config.refreshToken && (!config.firebaseApiKey || !config.firebaseRefreshToken)) {
      throw new Error(
        'Workflow builder requires GHL_REFRESH_TOKEN (v2 JWT) or GHL_FIREBASE_API_KEY + GHL_FIREBASE_REFRESH_TOKEN. ' +
        `Checked: ${skillEnvPath} and process.env`
      );
    }

    return new WorkflowBuilderClient(config);
  }

  // ─── Auth ───────────────────────────────────────────────

  /**
   * Get authenticated headers. Uses v2 JWT if available, falls back to Firebase.
   */
  private async getHeaders(): Promise<Record<string, string>> {
    // Prefer v2 JWT refresh flow
    if (this.config.refreshToken) {
      if (!this.cachedJwt || Date.now() >= this.tokenExpiry) {
        await this.refreshJWT();
      }
      return {
        'Authorization': `Bearer ${this.cachedJwt}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
        'channel': 'APP',
        'source': 'WEB_USER',
      };
    }

    // Legacy Firebase flow
    if (!this.cachedIdToken || Date.now() >= this.tokenExpiry) {
      await this.refreshFirebaseToken();
    }
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'token-id': this.cachedIdToken!,
      'channel': 'APP',
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    };
  }

  /**
   * Refresh v2 JWT via services.leadconnectorhq.com/auth/refresh.
   * Returns a 1-hour JWT and rotates the 30-day refresh token.
   */
  private async refreshJWT(): Promise<void> {
    const res = await fetch(WorkflowBuilderClient.JWT_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.config.refreshToken }),
    });

    const data = await res.json() as {
      jwt?: string;
      refreshJwt?: string;
      traceId?: string;
    };

    if ((res.status !== 200 && res.status !== 201) || !data.jwt) {
      throw new Error(
        `JWT refresh failed (${res.status}): ${JSON.stringify(data)}`
      );
    }

    this.cachedJwt = data.jwt;
    this.tokenExpiry = Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;

    // Persist rotated refresh token
    if (data.refreshJwt && data.refreshJwt !== this.config.refreshToken) {
      this.config.refreshToken = data.refreshJwt;
      this.persistToken('GHL_REFRESH_TOKEN', data.refreshJwt);
      // Also update the cached JWT in .env for other tools
      this.persistToken('GHL_AUTH_TOKEN', data.jwt);
    }
  }

  /**
   * Refresh Firebase token and persist the rotated refresh token (legacy).
   */
  private async refreshFirebaseToken(): Promise<void> {
    const url = `${WorkflowBuilderClient.FIREBASE_TOKEN_URL}?key=${this.config.firebaseApiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.config.firebaseRefreshToken)}`,
    });

    const data = await res.json() as {
      id_token?: string;
      refresh_token?: string;
      error?: { message: string };
    };

    if (!res.ok || !data.id_token) {
      throw new Error(
        `Firebase token refresh failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`
      );
    }

    this.cachedIdToken = data.id_token;
    this.tokenExpiry = Date.now() + WorkflowBuilderClient.TOKEN_TTL_MS;

    // Persist rotated refresh token
    if (data.refresh_token && data.refresh_token !== this.config.firebaseRefreshToken) {
      this.config.firebaseRefreshToken = data.refresh_token;
      this.persistToken('GHL_FIREBASE_REFRESH_TOKEN', data.refresh_token);
    }
  }

  /**
   * Write a token back to the .env file (preserves other lines).
   */
  private persistToken(key: string, value: string): void {
    const envPath = this.config.envFilePath;
    if (!envPath || !existsSync(envPath)) return;

    try {
      const contents = readFileSync(envPath, 'utf8');
      const regex = new RegExp(`^${key}=.*`, 'm');
      let updated: string;
      if (regex.test(contents)) {
        updated = contents.replace(regex, `${key}=${value}`);
      } else {
        updated = contents.trimEnd() + `\n${key}=${value}\n`;
      }
      writeFileSync(envPath, updated);
    } catch (err) {
      // Non-fatal — token still works for this session
      process.stderr.write(`[WorkflowBuilder] Warning: Could not persist ${key}: ${err}\n`);
    }
  }

  // ─── HTTP Helper ────────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const headers = await this.getHeaders();
    const url = `${WorkflowBuilderClient.BASE_URL}${path}`;

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();

    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      data = text as unknown as T;
    }

    if (!res.ok) {
      throw new Error(
        `GHL Workflow API error ${res.status} ${method} ${path}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
      );
    }

    return { status: res.status, data };
  }

  // ─── API Methods ────────────────────────────────────────

  /**
   * Create an empty workflow.
   */
  async createWorkflow(name: string): Promise<{ id: string }> {
    const { data } = await this.request<{ id: string }>(
      'POST',
      `/${this.config.locationId}`,
      { name }
    );
    return data;
  }

  /**
   * Get a workflow with full workflowData (actions, triggers, etc.)
   *
   * A plain GET does NOT carry the trigger list — triggers live in a separate
   * storage object (see the workflow's `triggersFilePath`) and the response
   * only names the path, which is why this used to report `triggers: []` for
   * every workflow. `?includeTriggers=true` makes GHL hydrate them, at the
   * cost of wrapping the whole response in an envelope. See
   * {@link unwrapWorkflow}.
   */
  async getWorkflow(workflowId: string): Promise<WorkflowFull> {
    const { data } = await this.request<unknown>(
      'GET',
      `/${this.config.locationId}/${workflowId}?includeTriggers=true`
    );
    return WorkflowBuilderClient.unwrapWorkflow(data);
  }

  /**
   * Get a workflow exactly as GHL returns it, with no normalisation or
   * projection. Escape hatch for inspecting fields this client does not model.
   *
   * `includeTriggers` selects the enveloped form
   * (`{ workflowData, triggers, permissionMeta, dependentAssets }`).
   */
  async getWorkflowRaw(
    workflowId: string,
    includeTriggers = false
  ): Promise<Record<string, unknown>> {
    const query = includeTriggers ? '?includeTriggers=true' : '';
    const { data } = await this.request<Record<string, unknown>>(
      'GET',
      `/${this.config.locationId}/${workflowId}${query}`
    );
    return data;
  }

  /**
   * List workflows with full data.
   */
  async listWorkflows(opts?: {
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ rows: WorkflowListItem[]; total: number }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const sortBy = opts?.sortBy ?? 'name';
    const sortOrder = opts?.sortOrder ?? 'asc';

    const query = `type=workflow&limit=${limit}&offset=${offset}&sortBy=${sortBy}&sortOrder=${sortOrder}&includeCustomObjects=true&includeObjectiveBuilder=true`;

    const { data } = await this.request<{ rows: WorkflowListItem[]; total: number }>(
      'GET',
      `/${this.config.locationId}/list?${query}`
    );
    return data;
  }

  /**
   * Update a workflow — adds/replaces actions, triggers, status, etc.
   * Always GETs the current version first to avoid version conflicts.
   */
  async updateWorkflow(
    workflowId: string,
    update: {
      name?: string;
      status?: 'draft' | 'published';
      actions?: WorkflowAction[];
      triggers?: WorkflowTrigger[];
      deletedSteps?: string[];
    }
  ): Promise<WorkflowFull> {
    const unsupported = WorkflowBuilderClient.triggerCreateUnsupported(update.triggers);
    if (unsupported) throw new Error(unsupported);

    // Get current state for version
    const current = await this.getWorkflow(workflowId);

    // Build action chain with next/parentKey if raw actions provided
    const actions = update.actions
      ? this.buildActionChain(update.actions)
      : current.workflowData?.templates || [];

    // Build triggers
    const newTriggers = update.triggers
      ? update.triggers.map(t => this.buildTriggerDocument(t, workflowId))
      : undefined;

    const createdSteps = update.actions
      ? actions.map(a => a.id).filter((id): id is string => !!id)
      : [];

    const body = {
      name: update.name || current.name,
      isRestoreRequest: true,
      status: update.status || current.status || 'draft',
      version: current.version,
      dataVersion: current.dataVersion,
      timezone: current.timezone || 'account',
      stopOnResponse: false,
      allowMultiple: false,
      allowMultipleOpportunity: false,
      autoMarkAsRead: false,
      removeContactFromLastStep: true,
      workflowData: { templates: actions },
      updatedBy: this.config.userId,
      oldTriggers: [],
      newTriggers: newTriggers || [],
      triggersChanged: !!newTriggers,
      modifiedSteps: [],
      deletedSteps: update.deletedSteps || [],
      createdSteps,
      meta: {},
    };

    await this.request('PUT', `/${this.config.locationId}/${workflowId}`, body);

    // Return fresh state
    return this.getWorkflow(workflowId);
  }

  /**
   * Delete a workflow.
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    await this.request('DELETE', `/${this.config.locationId}/${workflowId}`);
  }

  /**
   * Publish a workflow (set status to published).
   */
  async publishWorkflow(workflowId: string): Promise<WorkflowFull> {
    return this.updateWorkflow(workflowId, { status: 'published' });
  }

  /**
   * Clone a workflow: GET → create new → PUT with same actions/triggers.
   */
  async cloneWorkflow(workflowId: string, newName?: string): Promise<WorkflowFull> {
    const source = await this.getWorkflow(workflowId);
    const name = newName || `${source.name} (copy)`;

    // Create empty workflow
    const { id: newId } = await this.createWorkflow(name);

    // Remap action IDs to new UUIDs
    const idMap = new Map<string, string>();
    const sourceTemplates = source.workflowData?.templates || [];
    for (const action of sourceTemplates) {
      if (action.id) {
        idMap.set(action.id, randomUUID());
      }
    }

    // Clone actions with remapped IDs
    const clonedActions: WorkflowAction[] = sourceTemplates.map(a => {
      const remapId = (id: string) => idMap.get(id) || id;

      // Remap `next` while preserving scalar-vs-array shape.
      const next = Array.isArray(a.next)
        ? a.next.map(remapId)
        : typeof a.next === 'string' && a.next
          ? remapId(a.next)
          : undefined;

      const cloned: WorkflowAction = {
        ...a,
        id: a.id ? idMap.get(a.id) || randomUUID() : randomUUID(),
        // Router branch IDs live inside attributes and must be remapped too,
        // otherwise the clone's router still points at the ORIGINAL branch nodes.
        attributes: WorkflowBuilderClient.remapAttributeIds(a.attributes, remapId),
        parentKey: a.parentKey ? remapId(a.parentKey) : undefined,
        parent: a.parent ? remapId(a.parent) : undefined,
        sibling: Array.isArray(a.sibling)
          ? a.sibling.map(remapId)
          : undefined,
      };

      if (next === undefined) {
        delete cloned.next;
      } else {
        cloned.next = next;
      }

      return cloned;
    });

    // Triggers are deliberately NOT cloned. A copy needs its own trigger
    // document, and creating one is not supported — see
    // triggerCreateUnsupported. Sending them would fail the entire clone, so
    // the actions are cloned and the caller is told the trigger was skipped.
    const skippedTriggers = (source.triggers || []).map(t => ({
      type: t.type,
      name: t.name,
    }));

    const cloned = await this.updateWorkflow(newId, { actions: clonedActions });

    return { ...cloned, skippedTriggers };
  }

  // ─── Helpers ────────────────────────────────────────────

  /**
   * Reject a write that would have to CREATE a trigger, and say why.
   *
   * The workflow PUT can only ever UPDATE a trigger document — it never
   * creates one. A save that references a trigger with no existing document
   * fails with
   *
   *   5 NOT_FOUND: No document to update:
   *   projects/highlevel-backend/databases/(default)/documents/triggers/<id>
   *
   * and takes the entire workflow write down with it. This holds even when no
   * id is supplied and the backend mints its own (verified against the live
   * API: a locally minted UUID and a backend-minted Firestore id fail
   * identically). Trigger documents are stored separately — see the
   * workflow's `triggersFilePath` — and the endpoint that creates one has not
   * been identified, so this fails fast instead of leaving a half-written
   * workflow behind.
   *
   * Returns null when every trigger already exists (has an id), which the PUT
   * handles fine.
   */
  private static triggerCreateUnsupported(
    triggers: WorkflowTrigger[] | undefined
  ): string | null {
    if (!triggers?.some(t => !t.id)) return null;
    return WorkflowBuilderClient.triggerCreateHelp();
  }

  /** The explanation callers get when they ask for a trigger to be created. */
  static triggerCreateHelp(): string {
    return (
      'Cannot create a workflow trigger through this API. GHL requires the trigger document ' +
      'to already exist: the workflow save only UPDATEs triggers, and referencing one that ' +
      'was never created fails with "5 NOT_FOUND: No document to update: ' +
      '.../documents/triggers/<id>", rejecting the whole workflow. The endpoint that creates ' +
      'a trigger document is not known. Add the trigger in the GHL UI, then reference it here ' +
      'by its id to edit it. Writes that omit `triggers` entirely leave an existing trigger ' +
      'untouched, so actions can still be updated safely on a triggered workflow.'
    );
  }

  /**
   * Build the trigger document GHL actually stores.
   *
   * Previously this sent an invented shape — `{ id, type, name, workflowId,
   * data: { type, targetActionId } }` — with a locally minted UUID. GHL stores
   * a snake_case document with no `data` field at all:
   *
   *   { id, workflow_id, location_id, type, name, active, deleted,
   *     conditions: [], actions: [{ type: 'add_to_workflow', workflow_id }],
   *     masterType: 'highlevel', belongs_to: 'workflow' }
   *
   * Only reached for triggers that already exist —
   * {@link triggerCreateUnsupported} rejects the create case — so `id` is
   * always carried through.
   */
  private buildTriggerDocument(
    trigger: WorkflowTrigger,
    workflowId: string
  ): Record<string, unknown> {
    const {
      id,
      type,
      name,
      data,
      workflowId: _camelWorkflowId,
      date_added: _dateAdded,
      date_updated: _dateUpdated,
      ...rest
    } = trigger;

    return {
      // Anything GHL round-tripped to us that this client does not model.
      ...rest,
      // Only send an id for a trigger that already exists; a minted one makes
      // the backend attempt an update against a nonexistent document.
      ...(id ? { id } : {}),
      type,
      name: name || type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      workflow_id: workflowId,
      location_id: this.config.locationId,
      belongs_to: rest.belongs_to ?? 'workflow',
      masterType: rest.masterType ?? 'highlevel',
      active: rest.active ?? true,
      deleted: rest.deleted ?? false,
      conditions: rest.conditions ?? [],
      // A trigger's own actions point back at the workflow it starts. On a
      // clone those still name the SOURCE workflow, so re-point them.
      actions: Array.isArray(rest.actions) && rest.actions.length > 0
        ? rest.actions.map(a =>
            a && typeof a === 'object' && 'workflow_id' in a
              ? { ...(a as Record<string, unknown>), workflow_id: workflowId }
              : a
          )
        : [{ type: 'add_to_workflow', workflow_id: workflowId }],
      // Trigger documents have no `data` field; pass one through only if the
      // caller explicitly supplied it.
      ...(data ? { data } : {}),
    };
  }

  /**
   * Flatten a workflow GET response into a {@link WorkflowFull}.
   *
   * With `?includeTriggers=true` GHL answers with an envelope:
   *
   *   { workflowData: <the workflow>, triggers: [...],
   *     permissionMeta: {...}, dependentAssets: {...} }
   *
   * Note the collision: the envelope key `workflowData` holds the workflow
   * document, which itself has a `workflowData` holding `templates`. Without
   * `includeTriggers` the workflow document is returned unwrapped, so both
   * forms are handled.
   */
  private static unwrapWorkflow(raw: unknown): WorkflowFull {
    const envelope = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const inner = envelope.workflowData as Record<string, unknown> | undefined;

    // The envelope's `workflowData` is the workflow itself (it carries _id);
    // the unwrapped form's `workflowData` only carries `templates`.
    const isEnvelope = !!inner && typeof inner === 'object' && '_id' in inner;

    const workflow = (isEnvelope ? inner : envelope) as WorkflowFull;
    const triggers = isEnvelope ? envelope.triggers : workflow.triggers;

    return {
      ...workflow,
      triggers: Array.isArray(triggers)
        ? triggers
            .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
            .map(t => WorkflowBuilderClient.normaliseTrigger(t))
        : [],
    };
  }

  /**
   * Give a GHL trigger document the `id`/`type`/`name` this client's interface
   * promises, without discarding the snake_case fields GHL actually stores
   * (`workflow_id`, `location_id`, `conditions`, `actions`, `masterType`,
   * `belongs_to`, `active`, ...). Keeping them is what lets a trigger survive
   * a read → write round-trip such as a clone.
   */
  private static normaliseTrigger(t: Record<string, unknown>): WorkflowTrigger {
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = t[k];
        if (typeof v === 'string' && v) return v;
      }
      return undefined;
    };

    return {
      ...t,
      id: pick('id', '_id'),
      type: pick('type', 'eventType', 'key') || '',
      name: pick('name', 'triggerName'),
    };
  }

  /**
   * Remap node-ID references that live inside an action's `attributes`.
   *
   * A router node stores its outgoing branches as
   *   attributes.branches[] = [{ id: <branch node id>, name, segments: [...] }]
   * and conditions may carry `ifElseNodeId`. Cloning previously copied
   * `attributes` verbatim, so a cloned router still referenced the SOURCE
   * workflow's branch node IDs — internally inconsistent.
   *
   * Only known ID-bearing keys are touched; everything else is passed through.
   */
  private static remapAttributeIds(
    attributes: Record<string, unknown> | undefined,
    remapId: (id: string) => string
  ): Record<string, unknown> | undefined {
    if (!attributes) return attributes;

    const ID_KEYS = new Set(['id', 'ifElseNodeId', 'targetActionId', 'nodeId']);

    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (ID_KEYS.has(k) && typeof v === 'string' && v) {
            out[k] = remapId(v);
          } else {
            out[k] = walk(v);
          }
        }
        return out;
      }
      return value;
    };

    return walk(attributes) as Record<string, unknown>;
  }

  /**
   * True when a node is a branch/router — the only kind of node for which
   * GHL accepts an ARRAY in `next`. Everything else must use a scalar string.
   */
  private static isRouterNode(a: Partial<WorkflowAction>): boolean {
    if (a.nodeType === 'condition-node') return true;
    if (a.cat === 'multi-path') return true;
    // A node fanning out to 2+ targets is a router by construction.
    return Array.isArray(a.next) && a.next.length > 1;
  }

  /**
   * Normalise a `next` value to what the GHL workflow validator expects.
   *
   *   router  -> string[]   (branch node IDs)
   *   normal  -> string     (scalar — arrays are rejected)
   *   terminal-> undefined  (key omitted; [] is still an array and is rejected)
   */
  private static normaliseNext(
    value: string | string[] | undefined,
    isRouter: boolean
  ): string | string[] | undefined {
    const ids = (Array.isArray(value) ? value : value ? [value] : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    );

    if (ids.length === 0) return undefined; // terminal — omit `next` entirely
    if (isRouter) return ids; // branch/router — array is required
    return ids[0]; // non-branching — MUST be a scalar string
  }

  /**
   * Chain raw actions with next/parentKey linkages.
   * If actions already have next/parentKey set, preserves them (for branching).
   */
  private buildActionChain(rawActions: WorkflowAction[]): WorkflowAction[] {
    // First pass: assign IDs and basic structure
    const withIds = rawActions.map((a, i) => ({
      ...a,
      id: a.id || randomUUID(),
      order: a.order ?? i,
      attributes: a.attributes || {},
    }));

    // Second pass: wire up next/parentKey for actions that don't have explicit linkage
    return withIds.map((a, i, arr) => {
      const original = rawActions[i];
      const hasExplicitNext = original.next !== undefined;
      const hasExplicitParent = original.parentKey !== undefined;

      const isRouter = WorkflowBuilderClient.isRouterNode(original);

      // Explicit linkage wins; otherwise auto-chain to the following action.
      // The last action in the array is terminal and gets no `next` at all.
      const rawNext: string | string[] | undefined = hasExplicitNext
        ? original.next
        : i < arr.length - 1
          ? arr[i + 1].id!
          : undefined;

      const next = WorkflowBuilderClient.normaliseNext(rawNext, isRouter);

      const node: WorkflowAction = {
        ...(a as WorkflowAction),
        parentKey: hasExplicitParent
          ? a.parentKey
          : (i > 0 ? arr[i - 1].id : undefined),
      };

      // Omit the key entirely for terminals rather than emitting [] or null.
      if (next === undefined) {
        delete node.next;
      } else {
        node.next = next;
      }

      return node;
    });
  }

  /**
   * Get location ID being used.
   */
  getLocationId(): string {
    return this.config.locationId;
  }

  /**
   * Get user ID being used.
   */
  getUserId(): string {
    return this.config.userId;
  }
}
