import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClassicPluginModule } from '../types/classic.ts';
import type { FlowPluginModule } from '../types/flowPlugin.ts';
import { vendorPaths } from '../vendor.ts';
import { FLOW_HELPER_MODULES } from './flowHelpers.ts';
import { makeMethodsLib } from './methodsLib.ts';

const nodeRequire = createRequire(import.meta.url);

/**
 * Tdarr plugins are CommonJS and resolve `methods/lib` and `FlowHelpers`
 * relative to their position inside the server image, neither of which exists
 * next to plugin source in a config repo. Rather than vendoring those, the
 * source is evaluated with a `require` that serves stubs.
 *
 * The alternative - reimplementing each plugin's logic in the harness - would
 * test the reimplementation instead of the plugin, so this runs the real file.
 */

type CommonJsModule = { exports: Record<string, unknown> };

function evaluateCommonJs(file: string, resolve: (request: string) => unknown): CommonJsModule {
  const source = readFileSync(file, 'utf8');
  const mod: CommonJsModule = { exports: {} };
  const factory = new Function(
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
    source,
  ) as (
    module: CommonJsModule,
    exports: Record<string, unknown>,
    require: (request: string) => unknown,
    filename: string,
    dirname: string,
  ) => void;

  factory(mod, mod.exports, resolve, file, dirname(file));
  return mod;
}

/**
 * Resolves a plugin's `require` calls.
 *
 * Prefers the vendored real source (`pnpm plugins:update`), so plugins run
 * against the same `FlowHelpers` and `methods/lib` that Tdarr itself loads.
 * Falls back to the hand-written stubs only when nothing has been vendored.
 */
function requireForPlugin(pluginPath: string, vendorRoot?: string) {
  const vendor = vendorPaths(vendorRoot);

  return (request: string): unknown => {
    if (request.endsWith('methods/lib')) {
      const real = join(vendor.methods, 'lib.js');
      if (vendor.available && existsSync(real)) return nodeRequire(real);
      return makeMethodsLib;
    }

    // e.g. "../../../../FlowHelpers/1.0.0/interfaces/flowUtils"
    const helper = request.match(/FlowHelpers\/(.+)$/);
    if (helper?.[1] && vendor.available) {
      const real = join(vendor.flowHelpers, `${helper[1]}.js`);
      if (existsSync(real)) return nodeRequire(real);
    }

    for (const [suffix, stub] of Object.entries(FLOW_HELPER_MODULES)) {
      if (request.endsWith(suffix)) return stub;
    }

    // Plugins occasionally pull in a real npm package; let Node resolve it.
    try {
      return nodeRequire(request);
    } catch {
      throw new Error(
        `${pluginPath} required a module that could not be resolved: "${request}".\n`
          + 'Run `pnpm plugins:update` to vendor the real Tdarr helpers, or add a stub '
          + 'to src/loaders/flowHelpers.ts.',
      );
    }
  };
}

export interface ClassicPluginLocation {
  /** Directory holding `Tdarr_Plugin_*.js`, e.g. "<repo>/plugins/Local". */
  dir: string;
  /** Override the vendored Tdarr source root. Defaults to the package's own. */
  vendorRoot?: string;
}

/** Loads a classic plugin by id, e.g. "Tdarr_Plugin_bsh1_RemuxMKV". */
export function loadClassicPlugin(
  id: string,
  { dir, vendorRoot }: ClassicPluginLocation,
): ClassicPluginModule {
  const file = join(dir, `${id}.js`);
  const mod = evaluateCommonJs(file, requireForPlugin(file, vendorRoot));

  if (typeof mod.exports.plugin !== 'function') {
    throw new Error(`${file} does not export a plugin function`);
  }
  if (typeof mod.exports.details !== 'function') {
    throw new Error(`${file} does not export a details function`);
  }
  return mod.exports as unknown as ClassicPluginModule;
}

export interface FlowPluginLocation {
  /** Directory holding `<category>/<name>/<version>/index.js`. */
  dir: string;
  category: string;
  version?: string;
  /** Override the vendored Tdarr source root. Defaults to the package's own. */
  vendorRoot?: string;
}

/** Loads a local flow plugin from the `LocalFlowPlugins` directory layout. */
export function loadFlowPlugin(
  name: string,
  { dir, category, version = '1.0.0', vendorRoot }: FlowPluginLocation,
): FlowPluginModule {
  const file = join(dir, category, name, version, 'index.js');
  const mod = evaluateCommonJs(file, requireForPlugin(file, vendorRoot));

  if (typeof mod.exports.plugin !== 'function') {
    throw new Error(`${file} does not export a plugin function`);
  }
  return mod.exports as unknown as FlowPluginModule;
}

/** `pluginSourceId` looks like "Local:Tdarr_Plugin_bsh1_CleanAudio". */
export function splitSourceId(sourceId: string): { repo: string; id: string } {
  const at = sourceId.indexOf(':');
  if (at === -1) return { repo: 'Community', id: sourceId };
  return { repo: sourceId.slice(0, at), id: sourceId.slice(at + 1) };
}
