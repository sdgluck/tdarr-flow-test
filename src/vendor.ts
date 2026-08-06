import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations of the vendored Tdarr plugin source. Populated by
 * `pnpm plugins:update`; see scripts/update-plugins.ts.
 *
 * When present, the harness executes the real stock plugins and resolves their
 * helpers to the real `FlowHelpers` and `methods/lib`. When absent it falls
 * back to hand-written models, which is materially weaker - the fallback
 * exists so the package still works if vendoring has not been run, not because
 * it is an equivalent option.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface VendorInfo {
  repo: string;
  ref: string;
  sha: string;
  committedAt: string;
  vendoredPaths: string[];
}

export interface VendorPaths {
  root: string;
  communityFlowPlugins: string;
  flowHelpers: string;
  methods: string;
  available: boolean;
}

export function vendorPaths(root: string = join(packageRoot, 'vendor')): VendorPaths {
  const communityFlowPlugins = join(root, 'FlowPlugins', 'CommunityFlowPlugins');
  return {
    root,
    communityFlowPlugins,
    flowHelpers: join(root, 'FlowPlugins', 'FlowHelpers'),
    methods: join(root, 'methods'),
    available: existsSync(communityFlowPlugins),
  };
}

export function vendorInfo(root?: string): VendorInfo | null {
  const paths = vendorPaths(root);
  const file = join(paths.root, 'VERSION.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as VendorInfo;
}

export function describeVendor(root?: string): string {
  const info = vendorInfo(root);
  if (!info) {
    return 'no vendored plugin source - run `pnpm plugins:update` to execute real plugins '
      + 'instead of models';
  }
  return `${info.repo}@${info.sha.slice(0, 10)} (${info.committedAt})`;
}
