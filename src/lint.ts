import type { Flow } from './flow.ts';
import type { NodeRegistry } from './simulation/registry.ts';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  nodeId?: string;
  nodeName?: string;
  message: string;
  /** True when the finding rests on an `assumed` node model rather than an observed one. */
  assumed?: boolean;
}

export interface LintOptions {
  registry: NodeRegistry;
  /**
   * Rules to skip, optionally scoped to a node: `"missing-error-edge"` silences
   * the rule everywhere, `"missing-error-edge:audProped"` only on that node.
   * Use the scoped form and leave a comment - a blanket disable hides the next
   * instance too.
   */
  ignore?: string[];
  /** Report warnings as well as errors. Defaults to true. */
  includeWarnings?: boolean;
}

const ERROR_HANDLE = 'err1';

/**
 * Structural checks that apply to any Tdarr flow. These catch the class of bug
 * that is invisible in the editor: an edge wired to a handle the plugin does
 * not have looks identical to one that works.
 */
export function lint(flow: Flow, options: LintOptions): LintFinding[] {
  const { registry, ignore = [], includeWarnings = true } = options;
  const findings: LintFinding[] = [];

  const silenced = (rule: string, nodeId?: string): boolean =>
    ignore.includes(rule) || (nodeId !== undefined && ignore.includes(`${rule}:${nodeId}`));

  const add = (finding: LintFinding): void => {
    if (silenced(finding.rule, finding.nodeId)) return;
    if (!includeWarnings && finding.severity === 'warning') return;
    findings.push(finding);
  };

  // --- whole-graph shape ----------------------------------------------------

  const entries = flow.entries();
  if (entries.length !== 1) {
    add({
      rule: 'entry-node',
      severity: 'error',
      message: `expected exactly 1 entry node, found ${entries.length}`
        + (entries.length > 0 ? `: ${entries.map((n) => n.name).join(', ')}` : ''),
    });
  }

  for (const edge of flow.edges) {
    if (!flow.byId.has(edge.source)) {
      add({
        rule: 'dangling-edge',
        severity: 'error',
        message: `edge ${edge.id} starts at unknown node ${edge.source}`,
      });
    }
    if (!flow.byId.has(edge.target)) {
      add({
        rule: 'dangling-edge',
        severity: 'error',
        message: `edge ${edge.id} points at unknown node ${edge.target}`,
      });
    }
  }

  if (entries.length === 1) {
    const reached = flow.reachable();
    for (const node of flow.nodes) {
      if (reached.has(node.id)) continue;
      add({
        rule: 'unreachable-node',
        severity: 'error',
        nodeId: node.id,
        nodeName: node.name,
        message: `${node.name} is not reachable from the entry node`,
      });
    }
  }

  // --- per-node handle checks ----------------------------------------------

  for (const node of flow.nodes) {
    const model = registry.get(node.pluginName);
    if (!model) {
      add({
        rule: 'unmodelled-plugin',
        severity: 'warning',
        nodeId: node.id,
        nodeName: node.name,
        message: `no model registered for "${node.pluginName}", so its handles cannot be checked`,
      });
      continue;
    }

    const used = flow.usedHandles(node.id);
    const numbered = used.filter((handle) => handle !== ERROR_HANDLE);
    const assumed = model.confidence === 'assumed';

    for (const handle of numbered) {
      const index = Number(handle);
      if (!Number.isInteger(index) || index < 1 || index > model.outputs) {
        add({
          rule: 'nonexistent-handle',
          severity: 'error',
          nodeId: node.id,
          nodeName: node.name,
          assumed,
          message:
            `${node.name} has an edge on handle ${handle}, but ${node.pluginName} is modelled `
            + `with ${model.outputs} output(s). That edge can never be taken`
            + (assumed ? ' (model is ASSUMED - confirm before acting)' : '')
            + '.',
        });
      }
    }

    // A terminal node's outputs having nowhere to go is the point of it.
    for (let index = 1; index <= (model.terminal ? 0 : model.outputs); index += 1) {
      if (numbered.includes(String(index))) continue;
      add({
        rule: 'unwired-handle',
        severity: 'warning',
        nodeId: node.id,
        nodeName: node.name,
        assumed,
        message:
          `${node.name} handle ${index} has no outgoing edge; a file leaving by it dead-ends`,
      });
    }

    if (used.includes(ERROR_HANDLE) && !model.error) {
      add({
        rule: 'nonexistent-handle',
        severity: 'error',
        nodeId: node.id,
        nodeName: node.name,
        assumed,
        message: `${node.name} has an error edge, but ${node.pluginName} exposes no err1 handle`,
      });
    }

    if (model.error && !used.includes(ERROR_HANDLE)) {
      add({
        rule: 'missing-error-edge',
        severity: 'warning',
        nodeId: node.id,
        nodeName: node.name,
        message:
          `${node.name} can fail but has no error edge, so a failure fails the whole job`,
      });
    }
  }

  // --- consistency ----------------------------------------------------------

  const versionsByPlugin = new Map<string, Map<string, string[]>>();
  for (const node of flow.nodes) {
    const versions = versionsByPlugin.get(node.pluginName) ?? new Map<string, string[]>();
    versions.set(node.version, [...(versions.get(node.version) ?? []), node.name]);
    versionsByPlugin.set(node.pluginName, versions);
  }
  for (const [pluginName, versions] of versionsByPlugin) {
    if (versions.size <= 1) continue;
    const summary = [...versions.entries()]
      .map(([version, names]) => `${version} (${names.join(', ')})`)
      .join(' vs ');
    add({
      rule: 'mixed-plugin-versions',
      severity: 'warning',
      message: `${pluginName} is used at more than one version: ${summary}`,
    });
  }

  const seenPositions = new Map<string, string>();
  for (const node of flow.nodes) {
    const key = `${node.position.x},${node.position.y}`;
    const other = seenPositions.get(key);
    if (other) {
      add({
        rule: 'overlapping-nodes',
        severity: 'warning',
        nodeId: node.id,
        nodeName: node.name,
        message: `${node.name} sits exactly on top of ${other} at (${key})`,
      });
    } else {
      seenPositions.set(key, node.name);
    }
  }

  return findings;
}

export function formatFindings(findings: LintFinding[]): string {
  if (findings.length === 0) return 'no findings';
  return findings
    .map((finding) => {
      const where = finding.nodeName ? ` [${finding.nodeName}]` : '';
      const flag = finding.assumed ? ' (assumed)' : '';
      return `${finding.severity}: ${finding.rule}${where}${flag} - ${finding.message}`;
    })
    .join('\n');
}

/** Convenience for tests: throws with every finding if any are errors. */
export function assertNoLintErrors(flow: Flow, options: LintOptions): void {
  const errors = lint(flow, options).filter((finding) => finding.severity === 'error');
  if (errors.length > 0) throw new Error(`flow lint failed:\n${formatFindings(errors)}`);
}
