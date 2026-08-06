import { loadFlowPlugin } from '../loaders/loadPlugin.ts';
import { discoverPlugins, type DiscoveredPlugin } from './community.ts';
import { applyPluginResult, buildPluginArgs } from './pluginArgs.ts';
import { HaltError, type NodeModel, type NodeRegistry } from './registry.ts';

export type { DiscoveredPlugin };

/**
 * Walks a `LocalFlowPlugins` tree (`<category>/<name>/<version>/index.js`).
 * Shares its discovery with the community tree, since the layout is identical.
 */
export function discoverLocalFlowPlugins(dir: string): DiscoveredPlugin[] {
  return discoverPlugins(dir);
}

/**
 * Registers your own flow plugins, executed from real source. Nothing about
 * these is modelled - they run exactly as Tdarr runs them, against the real
 * `FlowHelpers` and `methods/lib` when those have been vendored.
 */
export function registerLocalFlowPlugins(
  registry: NodeRegistry,
  dir: string,
  vendorRoot?: string,
): NodeRegistry {
  for (const location of discoverLocalFlowPlugins(dir)) {
    const module = loadFlowPlugin(location.name, { dir, vendorRoot, ...location });
    const details = typeof module.details === 'function' ? module.details() : undefined;

    const model: NodeModel = {
      outputs: details?.outputs?.length ?? 1,
      error: false,
      confidence: 'observed',
      note: `local plugin source, ${location.category}/${location.name}/${location.version}`,
      run: (ctx, node) => {
        const args = buildPluginArgs(ctx, { ...node.inputsDB });
        let result;
        try {
          result = module.plugin(args);
        } catch (error) {
          throw new HaltError(
            'crash',
            `${location.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (result instanceof Promise) {
          throw new HaltError(
            'unmodelled',
            `${location.name} is async; the simulator is synchronous.`,
          );
        }

        applyPluginResult(ctx, args);
        return String(result.outputNumber) as `${number}`;
      },
    };

    registry.register(location.name, model);
  }
  return registry;
}
