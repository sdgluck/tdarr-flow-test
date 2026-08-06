import { writeFileSync } from 'node:fs';

import type { FlowJson } from '../types/flow.ts';
import { Flow } from '../flow.ts';

/**
 * Minimal client for the Tdarr server API.
 *
 * Tdarr's API is not versioned independently of the app and endpoint shapes
 * have moved between releases, so every call goes through `raw()` and the
 * collection names are configurable. If a convenience method 404s on your
 * server, call `raw()` directly rather than fighting the wrapper - and please
 * open an issue with what your version expects.
 *
 * Verified against Tdarr 2.86.01.
 */

export interface TdarrClientOptions {
  /** Base URL, e.g. "http://192.168.1.42:8266". */
  url: string;
  /** Sent as `x-api-key`. Only needed if the server has auth enabled. */
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface CrudRequest {
  collection: string;
  mode: 'getAll' | 'getById' | 'insert' | 'update' | 'delete';
  docID?: string;
  obj?: unknown;
}

export interface FlowSummary {
  id: string;
  name: string;
  description?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface LibrarySummary {
  id: string;
  name: string;
  folder?: string;
  /** Flow id this library runs, when it is in flow mode. */
  flowId?: string;
}

export class TdarrError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TdarrError';
    this.status = status;
  }
}

export class TdarrClient {
  readonly url: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: TdarrClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** POSTs to an API path and returns the parsed body. */
  async raw<T = unknown>(path: string, body?: unknown): Promise<T> {
    const target = `${this.url}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#apiKey) headers['x-api-key'] = this.#apiKey;

    let response: Response;
    try {
      response = await this.#fetch(target, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new TdarrError(
        `could not reach ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new TdarrError(`${target} returned ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  /** True if the server answers at all. */
  async ping(): Promise<boolean> {
    try {
      await this.raw('/api/v2/status');
      return true;
    } catch {
      return false;
    }
  }

  async crud<T = unknown>(request: CrudRequest): Promise<T> {
    return this.raw<T>('/api/v2/cruddb', { data: request });
  }

  /** Every flow on the server, as a summary suitable for listing. */
  async listFlows(collection = 'FlowsJSONDB'): Promise<FlowSummary[]> {
    const rows = await this.crud<FlowJson[]>({ collection, mode: 'getAll' });
    return rows.map((row) => ({
      id: row._id,
      name: row.name,
      description: row.description,
      nodeCount: row.flowPlugins?.length ?? 0,
      edgeCount: row.flowEdges?.length ?? 0,
    }));
  }

  async getFlowById(id: string, collection = 'FlowsJSONDB'): Promise<Flow> {
    const rows = await this.crud<FlowJson[]>({ collection, mode: 'getAll' });
    const match = rows.find((row) => row._id === id);
    if (!match) throw new TdarrError(`no flow with id "${id}"`);
    return new Flow(match);
  }

  /** Case-insensitive name lookup. Throws if the name is ambiguous. */
  async getFlowByName(name: string, collection = 'FlowsJSONDB'): Promise<Flow> {
    const rows = await this.crud<FlowJson[]>({ collection, mode: 'getAll' });
    const wanted = name.trim().toLowerCase();
    const matches = rows.filter((row) => row.name?.trim().toLowerCase() === wanted);

    if (matches.length === 0) {
      const available = rows.map((row) => row.name).join(', ');
      throw new TdarrError(`no flow named "${name}". Available: ${available || '(none)'}`);
    }
    if (matches.length > 1) {
      throw new TdarrError(
        `"${name}" is ambiguous - ${matches.length} flows share it. `
          + `Use getFlowById with one of: ${matches.map((m) => m._id).join(', ')}`,
      );
    }
    return new Flow(matches[0] as FlowJson);
  }

  /** Looks up by id first, then by name. */
  async findFlow(nameOrId: string, collection = 'FlowsJSONDB'): Promise<Flow> {
    try {
      return await this.getFlowById(nameOrId, collection);
    } catch {
      return this.getFlowByName(nameOrId, collection);
    }
  }

  async listLibraries(collection = 'LibrarySettingsJSONDB'): Promise<LibrarySummary[]> {
    const rows = await this.crud<Record<string, unknown>[]>({ collection, mode: 'getAll' });
    return rows.map((row) => ({
      id: String(row._id ?? ''),
      name: String(row.name ?? ''),
      folder: row.folder === undefined ? undefined : String(row.folder),
      flowId: typeof row.flowId === 'string' ? row.flowId : undefined,
    }));
  }
}

/** Writes a flow to disk in the DB shape, which imports cleanly into the UI. */
export function saveFlow(flow: Flow, path: string): void {
  writeFileSync(path, `${JSON.stringify(flow.raw, null, 2)}\n`, 'utf8');
}
