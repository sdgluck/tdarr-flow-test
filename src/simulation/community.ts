import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadFlowPlugin } from '../loaders/loadPlugin.ts';
import { vendorPaths } from '../vendor.ts';
import { applyPluginResult, buildPluginArgs } from './pluginArgs.ts';
import { HaltError, type NodeModel, type NodeRegistry } from './registry.ts';

/**
 * Registers the REAL stock Tdarr plugins, executed from vendored source.
 *
 * This is what makes a simulation trustworthy: routing decisions come from the
 * same code Tdarr runs, not from a guess about what it probably does. Handle
 * counts come from each plugin's own `details().outputs`, so lint findings
 * about impossible edges become facts rather than hypotheses.
 */

export interface DiscoveredPlugin {
  name: string;
  category: string;
  version: string;
}

/**
 * Plugins that must keep their hand-written model even when real source is
 * available, because the real implementation shells out to ffmpeg/mkvpropedit
 * or moves files on disk. The harness has no files and no binaries, so running
 * these for real would fail rather than inform.
 *
 * Their *routing* is still modelled faithfully; it is only the side effect that
 * is simulated. Anything depending on real ffmpeg output needs an end-to-end
 * run regardless.
 */
export const MUST_MODEL = new Set([
  'inputFile',
  'replaceOriginalFile',
  'setOriginalFile',
  'runMkvPropEdit',
  'runClassicTranscodePlugin',
  'ffmpegCommandExecute',
  'checkFileChanged',
]);

export function discoverPlugins(root: string): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  if (!existsSync(root)) return found;

  for (const category of readdirSync(root, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = join(root, category.name);

    for (const name of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const versions = readdirSync(join(categoryDir, name.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((version) => existsSync(join(categoryDir, name.name, version, 'index.js')))
        .sort();

      const version = versions.at(-1);
      if (version) found.push({ name: name.name, category: category.name, version });
    }
  }
  return found;
}

/** Wraps a real flow plugin as a simulation node model. */
export function realPluginModel(
  location: DiscoveredPlugin,
  dir: string,
  vendorRoot?: string,
): NodeModel {
  const module = loadFlowPlugin(location.name, { dir, vendorRoot, ...location });
  const details = module.details();

  return {
    outputs: details.outputs?.length ?? 1,
    // Whether a node exposes err1 is a property of the flow engine rather than
    // the plugin, so it stays conservative: only nodes known to shell out are
    // given an error handle, and those are all in MUST_MODEL anyway.
    error: false,
    confidence: 'observed',
    note: `real plugin source, ${location.category}/${location.name}/${location.version}`,
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
}

export interface RegisterCommunityOptions {
  /** Defaults to the package's own vendor directory. */
  vendorRoot?: string;
  /** Plugin names to leave modelled. Defaults to MUST_MODEL. */
  keepModelled?: Set<string>;
  /** Called for each plugin that could not be loaded. */
  onSkip?: (name: string, reason: string) => void;
}

/**
 * Registers every vendored community plugin, skipping those in `keepModelled`.
 * Returns the names actually registered.
 *
 * Call this AFTER the built-in models so real plugins override them, while the
 * MUST_MODEL entries - skipped here - keep the model they need.
 */
export function registerCommunityPlugins(
  registry: NodeRegistry,
  options: RegisterCommunityOptions = {},
): string[] {
  const { vendorRoot, keepModelled = MUST_MODEL, onSkip } = options;
  const vendor = vendorPaths(vendorRoot);
  if (!vendor.available) return [];

  const registered: string[] = [];
  for (const location of discoverPlugins(vendor.communityFlowPlugins)) {
    if (keepModelled.has(location.name)) continue;
    try {
      registry.register(location.name, realPluginModel(location, vendor.communityFlowPlugins, vendorRoot));
      registered.push(location.name);
    } catch (error) {
      onSkip?.(location.name, error instanceof Error ? error.message : String(error));
    }
  }
  return registered;
}
