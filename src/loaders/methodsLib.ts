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
 * Only `undefined` values are filled. A flow legitimately stores empty strings
 * in `inputsDB` - `codecs: ""` means "no codec ordering", not "unset" - and
 * overwriting those would diverge from the server.
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
        if (out[def.name] === undefined) out[def.name] = def.defaultValue;
      }
      return out as T;
    },
  };
}

export type MethodsLib = ReturnType<typeof makeMethodsLib>;
