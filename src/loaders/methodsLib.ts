import type { ClassicPluginDetails } from '../types/classic.ts';
import type { FlowPluginDetails } from '../types/flowPlugin.ts';

type AnyDetails =
  | Pick<ClassicPluginDetails, 'Inputs'>
  | Pick<FlowPluginDetails, 'inputs'>;

/**
 * Stand-in for Tdarr's `methods/lib`, which is not distributed with plugin
 * source. Only `loadDefaultValues` is used by plugins in practice.
 *
 * Classic plugins declare `Inputs` (capitalised), flow plugins declare
 * `inputs`; both are supported so the same stub serves either.
 *
 * Empty strings are filled too, not just `undefined`. That is what the real
 * `methods/lib` does, and it matters: setting a plugin input to "" does NOT
 * mean "no value", it silently reverts to the plugin's default. Getting this
 * wrong made an empty `language` look like "match any language" here while the
 * server was reading it as "eng".
 */
export function makeMethodsLib() {
  return {
    loadDefaultValues<T extends Record<string, unknown>>(
      inputs: T,
      details: (() => AnyDetails) | AnyDetails,
    ): T {
      const resolved = typeof details === 'function' ? details() : details;
      const declared = 'Inputs' in resolved ? resolved.Inputs : resolved.inputs;
      const out: Record<string, unknown> = { ...inputs };
      for (const def of declared ?? []) {
        const current = out[def.name];
        const trimmed = typeof current === 'string' ? current.trim() : current;
        out[def.name] = trimmed === undefined || trimmed === '' ? def.defaultValue : trimmed;
      }
      return out as T;
    },
  };
}

export type MethodsLib = ReturnType<typeof makeMethodsLib>;
