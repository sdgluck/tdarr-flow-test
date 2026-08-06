import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadFlowPlugin } from '../loaders/loadPlugin.ts';
import type { NodeRegistry } from '../simulation/registry.ts';

/**
 * The registry's handle counts are the harness's biggest source of untruth: a
 * lint result that says "this edge can never be taken" is only as good as the
 * `outputs` number it compared against.
 *
 * This resolves that against real plugin source. Point it at a Tdarr
 * `FlowPlugins` directory - from the container
 * (`/app/server/Tdarr/Plugins/FlowPlugins`), a volume mount, or a checkout of
 * the community plugin repo - and it reads each plugin's declared
 * `details().outputs` and diffs it against what the registry assumes.
 *
 * There is deliberately no server-API route here. Tdarr does not expose plugin
 * definitions over its API in a stable way, so reading the source is both more
 * reliable and available offline.
 */

export interface HandleMismatch {
  pluginName: string;
  modelled: number;
  actual: number;
  confidence: string;
}

export interface VerifyHandlesResult {
  checked: string[];
  missing: string[];
  mismatches: HandleMismatch[];
  ok: boolean;
}

function findPluginDirs(root: string): { name: string; category: string; version: string }[] {
  const found: { name: string; category: string; version: string }[] = [];
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

/**
 * @param pluginRoot e.g. "<tdarr>/Plugins/FlowPlugins/CommunityFlowPlugins"
 */
export function verifyHandles(pluginRoot: string, registry: NodeRegistry): VerifyHandlesResult {
  const checked: string[] = [];
  const mismatches: HandleMismatch[] = [];
  const seen = new Set<string>();

  for (const location of findPluginDirs(pluginRoot)) {
    const model = registry.get(location.name);
    seen.add(location.name);
    if (!model) continue;

    let actual: number;
    try {
      const module = loadFlowPlugin(location.name, { dir: pluginRoot, ...location });
      actual = module.details().outputs?.length ?? 0;
    } catch {
      // A plugin whose details() cannot be evaluated without the real helpers
      // is skipped rather than reported as a mismatch.
      continue;
    }

    checked.push(location.name);
    if (actual !== model.outputs) {
      mismatches.push({
        pluginName: location.name,
        modelled: model.outputs,
        actual,
        confidence: model.confidence,
      });
    }
  }

  const missing = registry.names().filter((name) => !seen.has(name));

  return { checked, missing, mismatches, ok: mismatches.length === 0 };
}

export function formatVerifyResult(result: VerifyHandlesResult): string {
  const lines = [`verified ${result.checked.length} plugin(s) against source`];

  if (result.mismatches.length > 0) {
    lines.push('', 'MISMATCHES - the registry is wrong and lint results built on it are unsafe:');
    for (const mismatch of result.mismatches) {
      lines.push(
        `  ${mismatch.pluginName}: modelled ${mismatch.modelled} output(s) `
          + `(${mismatch.confidence}), source declares ${mismatch.actual}`,
      );
    }
  }

  if (result.missing.length > 0) {
    lines.push(
      '',
      `not found in the plugin source tree (local plugins, or a stale model): ${
        result.missing.join(', ')
      }`,
    );
  }

  return lines.join('\n');
}
