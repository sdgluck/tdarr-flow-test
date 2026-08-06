import { readFileSync } from 'node:fs';

import type { FlowEdge, FlowJson, FlowNode } from './types/flow.ts';

/** Indexed, queryable view over a Tdarr flow document. */
export class Flow {
  readonly raw: FlowJson;
  readonly id: string;
  readonly name: string;
  readonly nodes: FlowNode[];
  readonly edges: FlowEdge[];
  readonly byId: Map<string, FlowNode>;

  #out = new Map<string, string[]>();
  #in = new Map<string, FlowEdge[]>();

  constructor(raw: FlowJson) {
    if (!raw || !Array.isArray(raw.flowPlugins)) {
      throw new Error('not a Tdarr flow: missing flowPlugins[]');
    }
    this.raw = raw;
    this.id = raw._id;
    this.name = raw.name;
    this.nodes = raw.flowPlugins;
    this.edges = raw.flowEdges ?? [];
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));

    for (const edge of this.edges) {
      const key = `${edge.source}::${String(edge.sourceHandle)}`;
      const outs = this.#out.get(key);
      if (outs) outs.push(edge.target);
      else this.#out.set(key, [edge.target]);

      const ins = this.#in.get(edge.target);
      if (ins) ins.push(edge);
      else this.#in.set(edge.target, [edge]);
    }
  }

  static fromFile(path: string): Flow {
    return new Flow(JSON.parse(readFileSync(path, 'utf8')) as FlowJson);
  }

  static fromObject(obj: FlowJson): Flow {
    return new Flow(obj);
  }

  node(id: string): FlowNode {
    const node = this.byId.get(id);
    if (!node) throw new Error(`no such node: ${id}`);
    return node;
  }

  /** Node ids reached from `id` by leaving via `handle`. */
  targets(id: string, handle: string | number): string[] {
    return this.#out.get(`${id}::${String(handle)}`) ?? [];
  }

  /** The single target of a handle, or null. Throws if the handle fans out. */
  target(id: string, handle: string | number): string | null {
    const found = this.targets(id, handle);
    if (found.length > 1) {
      throw new Error(`${id} handle ${handle} fans out to ${found.length} targets`);
    }
    return found[0] ?? null;
  }

  /** Distinct output handles `id` actually has edges on. */
  usedHandles(id: string): string[] {
    return [
      ...new Set(
        this.edges.filter((e) => e.source === id).map((e) => String(e.sourceHandle)),
      ),
    ];
  }

  incoming(id: string): FlowEdge[] {
    return this.#in.get(id) ?? [];
  }

  byPlugin(pluginName: string): FlowNode[] {
    return this.nodes.filter((n) => n.pluginName === pluginName);
  }

  pluginNames(): string[] {
    return [...new Set(this.nodes.map((n) => n.pluginName))];
  }

  /** Nodes with no inbound edges. A well-formed flow has exactly one. */
  entries(): FlowNode[] {
    return this.nodes.filter((n) => this.incoming(n.id).length === 0);
  }

  entry(): FlowNode {
    const roots = this.entries();
    const first = roots[0];
    if (roots.length !== 1 || !first) {
      throw new Error(
        `expected exactly 1 entry node, found ${roots.length}: ${roots.map((r) => r.id).join(', ')}`,
      );
    }
    return first;
  }

  /** Nodes with no outbound edges. */
  terminals(): FlowNode[] {
    return this.nodes.filter((n) => this.usedHandles(n.id).length === 0);
  }

  reachable({ from, includeErrors = true }: { from?: string; includeErrors?: boolean } = {}):
    Set<string> {
    const seen = new Set<string>();
    const stack = [from ?? this.entry().id];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      for (const edge of this.edges) {
        if (edge.source !== id) continue;
        if (!includeErrors && String(edge.sourceHandle).startsWith('err')) continue;
        stack.push(edge.target);
      }
    }
    return seen;
  }
}
