import type { FlowNode, OutputHandle } from '../types/flow.ts';
import type { SimContext } from './context.ts';

/**
 * How confident we are about a model's shape.
 *
 * - `observed` - seen firing on that handle in a captured job log, or read from
 *   a real server via `verifyHandles`.
 * - `assumed`  - inferred from the plugin's documented purpose. A lint or
 *   simulation result that turns on an `assumed` model is a hypothesis, not a
 *   proof. Promote it before trusting it.
 */
export type Confidence = 'observed' | 'assumed';

export interface NodeModel {
  /** Count of numbered output handles ("1".."n"). */
  outputs: number;
  /** Whether the node exposes an `err1` handle. */
  error: boolean;
  confidence: Confidence;
  /**
   * True for nodes that legitimately end the flow. Their outputs are exempt
   * from the `unwired-handle` rule, since having nowhere to go is the point.
   */
  terminal?: boolean;
  /** Why the model is shaped this way. Surfaced in lint output. */
  note?: string;
  /**
   * Runs the node. Return the handle to leave by, or null to terminate the
   * flow. Throw `HaltError` to model a node that dies without an error handle.
   */
  run: (ctx: SimContext, node: FlowNode) => OutputHandle | null;
}

export class HaltError extends Error {
  readonly kind: 'crash' | 'unmodelled';

  constructor(kind: 'crash' | 'unmodelled', message: string) {
    super(message);
    this.name = 'HaltError';
    this.kind = kind;
  }
}

export class NodeRegistry {
  #models = new Map<string, NodeModel>();

  register(pluginName: string, model: NodeModel): this {
    this.#models.set(pluginName, model);
    return this;
  }

  /** Registers many at once. Later calls override earlier ones. */
  registerAll(models: Record<string, NodeModel>): this {
    for (const [name, model] of Object.entries(models)) this.register(name, model);
    return this;
  }

  get(pluginName: string): NodeModel | undefined {
    return this.#models.get(pluginName);
  }

  require(pluginName: string): NodeModel {
    const model = this.#models.get(pluginName);
    if (!model) {
      throw new HaltError(
        'unmodelled',
        `no model registered for plugin "${pluginName}". Register one with `
          + 'registry.register(name, model) - see the README on extending the registry.',
      );
    }
    return model;
  }

  has(pluginName: string): boolean {
    return this.#models.has(pluginName);
  }

  names(): string[] {
    return [...this.#models.keys()];
  }

  /** An independent copy, so per-test overrides do not leak between tests. */
  clone(): NodeRegistry {
    const copy = new NodeRegistry();
    for (const [name, model] of this.#models) copy.register(name, model);
    return copy;
  }
}
