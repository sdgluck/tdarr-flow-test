import type { Flow } from '../flow.ts';
import type { FfProbeStream, TdarrFile } from '../types/ffprobe.ts';
import {
  isAudio,
  isSubtitle,
  isVideo,
  toWorkingFile,
  type HaltReason,
  type LogEntry,
  type PathEntry,
  type SimContext,
  type WorkingFile,
} from './context.ts';
import { builtinRegistry, type BuiltinOptions } from './nodes.ts';
import { registerCommunityPlugins } from './community.ts';
import { registerLocalFlowPlugins } from './localPlugins.ts';
import { HaltError, NodeRegistry } from './registry.ts';

export interface SimulateOptions extends BuiltinOptions {
  /** Name of the Tdarr node running the job, for `checkFlowVariable`. */
  nodeName?: string;
  /** Directory holding `LocalFlowPlugins/<category>/<name>/<version>/index.js`. */
  flowPluginDir?: string;
  /** Supply to override or extend the built-in models. */
  registry?: NodeRegistry;
  /** Override the vendored Tdarr plugin source root. */
  vendorRoot?: string;
  /**
   * Set false to use hand-written models even when real plugin source is
   * vendored. Only useful for comparing the two; real source is far stronger.
   */
  useRealPlugins?: boolean;
  /** Output size of a modelled video encode, as a fraction of the original. */
  transcodeRatio?: number;
  maxSteps?: number;
}

export interface SimulationResult {
  /** The working file as the flow left it. */
  file: WorkingFile;
  original: WorkingFile;
  /** Streams on the final file, by type, for convenient assertions. */
  audio: FfProbeStream[];
  video: FfProbeStream[];
  subtitles: FfProbeStream[];
  /** True only if the flow reached `Replace Original File`. */
  replaced: boolean;
  /** Set when the flow died rather than completing. */
  halted: HaltReason | null;
  path: PathEntry[];
  log: LogEntry[];
  /** Every node the flow visited, by name, in order. */
  visited: string[];
  /** Convenience: did the flow visit a node with this name? */
  didVisit: (nodeName: string) => boolean;
  /** Log lines only, without node attribution. */
  messages: string[];
}

/**
 * Walks a flow with a synthetic file and reports where it ended up.
 *
 * This SIMULATES Tdarr, it does not run it. Local plugins - classic and flow -
 * are executed for real, but every stock node is a model (see
 * `src/simulation/nodes.ts`, and each model's `confidence`). A simulation is
 * strong evidence of a routing or ordering defect and weak evidence about
 * ffmpeg's actual output. Use end-to-end runs for the latter.
 */
export function simulate(
  flow: Flow,
  file: TdarrFile,
  options: SimulateOptions = {},
): SimulationResult {
  const { nodeName = 'Tdarr_Node', transcodeRatio = 0.6, maxSteps = 500 } = options;

  const registry = options.registry ?? buildRegistry(options);

  const working = toWorkingFile(file);
  const ctx: SimContext = {
    file: working,
    original: { ...working, streams: [...working.streams] },
    ffmpegCommand: null,
    nodeName,
    transcodeRatio,
    log: [],
    path: [],
    replaced: false,
    halted: null,
    currentNode: '',
    say: (message) => ctx.log.push({ node: ctx.currentNode, message }),
  };

  let currentId: string | null = flow.entry().id;
  let steps = 0;

  try {
    while (currentId) {
      steps += 1;
      if (steps > maxSteps) {
        throw new HaltError('unmodelled', `exceeded ${maxSteps} steps - the flow probably loops`);
      }

      const node = flow.node(currentId);
      ctx.currentNode = node.name;

      const model = registry.require(node.pluginName);
      const handle = model.run(ctx, node);

      ctx.path.push({ id: node.id, name: node.name, plugin: node.pluginName, handle });

      if (handle === null) break;

      const targets = flow.targets(node.id, handle);
      if (targets.length > 1) {
        ctx.halted = {
          kind: 'fanout',
          node: node.id,
          message: `${node.name} handle ${handle} fans out to ${targets.length} targets`,
        };
        break;
      }

      const next = targets[0];
      if (next === undefined) {
        ctx.halted = {
          kind: 'deadEnd',
          node: node.id,
          message: `${node.name} (${node.id}) left via handle ${handle}, which has no outgoing edge`,
        };
        break;
      }
      currentId = next;
    }
  } catch (error) {
    if (!(error instanceof HaltError)) throw error;
    ctx.halted = { kind: error.kind, node: ctx.currentNode, message: error.message };
  }

  const visited = ctx.path.map((entry) => entry.name);

  return {
    file: ctx.file,
    original: ctx.original,
    audio: ctx.file.streams.filter(isAudio),
    video: ctx.file.streams.filter(isVideo),
    subtitles: ctx.file.streams.filter(isSubtitle),
    replaced: ctx.replaced,
    halted: ctx.halted,
    path: ctx.path,
    log: ctx.log,
    visited,
    didVisit: (name: string) => visited.includes(name),
    messages: ctx.log.map((entry) => entry.message),
  };
}

/**
 * The default registry, in precedence order:
 *   1. hand-written models for every stock node
 *   2. REAL vendored community plugins, overriding (1) except where the real
 *      implementation shells out - see MUST_MODEL
 *   3. your own local flow plugins, executed from source
 */
export function buildRegistry(options: SimulateOptions = {}): NodeRegistry {
  const registry = builtinRegistry(options);
  if (options.useRealPlugins !== false) {
    registerCommunityPlugins(registry, { vendorRoot: options.vendorRoot });
  }
  if (options.flowPluginDir) {
    registerLocalFlowPlugins(registry, options.flowPluginDir, options.vendorRoot);
  }
  return registry;
}
