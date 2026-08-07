export { Flow } from './flow.ts';

export { lint, assertNoLintErrors, formatFindings } from './lint.ts';
export type { LintFinding, LintOptions, LintSeverity } from './lint.ts';

export { simulate, buildRegistry } from './simulation/simulate.ts';
export type { SimulateOptions, SimulationResult } from './simulation/simulate.ts';

export { NodeRegistry, HaltError } from './simulation/registry.ts';
export type { NodeModel, Confidence } from './simulation/registry.ts';

export { builtinRegistry } from './simulation/nodes.ts';
export type { BuiltinOptions } from './simulation/nodes.ts';

export {
  discoverLocalFlowPlugins,
  registerLocalFlowPlugins,
} from './simulation/localPlugins.ts';

export type {
  HaltReason,
  LogEntry,
  PathEntry,
  SimContext,
  WorkingFile,
} from './simulation/context.ts';

export {
  loadClassicPlugin,
  loadFlowPlugin,
  splitSourceId,
} from './loaders/loadPlugin.ts';

export { TdarrClient, TdarrError, saveFlow } from './server/client.ts';
export type {
  FlowSummary,
  LibrarySummary,
  TdarrClientOptions,
} from './server/client.ts';

export { verifyHandles, formatVerifyResult } from './server/verifyHandles.ts';
export type { VerifyHandlesResult, HandleMismatch } from './server/verifyHandles.ts';

export {
  fuzz,
  generateVariants,
  allVariants,
  groupBy,
  ANOMALY_EXPLANATION,
} from './fuzz.ts';
export type { Anomaly, FuzzOptions, FuzzOutcome, FuzzReport, Variant } from './fuzz.ts';

export { vendorInfo, vendorPaths, describeVendor } from './vendor.ts';
export type { VendorInfo, VendorPaths } from './vendor.ts';

export * as probe from './probe.ts';

export type * from './types/index.ts';
