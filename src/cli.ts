#!/usr/bin/env node
/**
 * tdarr-test - command line entry point.
 *
 *   tdarr-test lint <flow.json...>     lint one or more flow files
 *   tdarr-test lint --server <url>     lint every flow on a Tdarr server
 *   tdarr-test flows --server <url>    list flows on a server
 *   tdarr-test fuzz <flow.json>        sweep many file shapes through a flow
 *   tdarr-test pull <name|id> -o <f>   save a flow to disk
 *   tdarr-test plugins                 show vendored plugin source status
 */

import { basename } from 'node:path';

import { Flow } from './flow.ts';
import { lint, type LintFinding } from './lint.ts';
import { buildRegistry } from './simulation/simulate.ts';
import { saveFlow, TdarrClient } from './server/client.ts';
import { describeVendor, vendorInfo, vendorPaths } from './vendor.ts';
import { ANOMALY_EXPLANATION, fuzz, groupBy, type Anomaly } from './fuzz.ts';
import { discoverPlugins } from './simulation/community.ts';

// --- pretty printing --------------------------------------------------------

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, text: string): string =>
  (useColour ? `[${code}m${text}[0m` : text);

const c = {
  bold: (t: string) => paint('1', t),
  dim: (t: string) => paint('2', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  blue: (t: string) => paint('34', t),
  cyan: (t: string) => paint('36', t),
};

const SYMBOL = { error: '✖', warning: '⚠', ok: '✔' };

function printFindings(label: string, findings: LintFinding[]): void {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  console.log(c.bold(c.blue(label)));

  if (findings.length === 0) {
    console.log(`  ${c.green(SYMBOL.ok)} no findings\n`);
    return;
  }

  // Group by node so a badly-wired node reads as one problem, not several.
  const groups = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const key = finding.nodeName ?? '(flow)';
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  for (const [node, items] of groups) {
    console.log(`  ${c.bold(node)}`);
    for (const finding of items) {
      const isError = finding.severity === 'error';
      const mark = isError ? c.red(SYMBOL.error) : c.yellow(SYMBOL.warning);
      const tag = c.dim(finding.rule) + (finding.assumed ? c.yellow(' (assumed model)') : '');
      console.log(`    ${mark} ${tag}`);
      console.log(`      ${wrap(finding.message, 6)}`);
    }
  }

  const parts = [
    errors.length > 0 ? c.red(`${errors.length} error${errors.length === 1 ? '' : 's'}`) : '',
    warnings.length > 0 ? c.yellow(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`) : '',
  ].filter(Boolean);
  console.log(`\n  ${parts.join(c.dim(', '))}\n`);
}

function wrap(text: string, indent: number, width = 96): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width - indent) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}

// --- argument handling ------------------------------------------------------

const argv = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Positional arguments, with `--opt value` pairs removed. */
function positionals(after: string): string[] {
  const start = argv.indexOf(after) + 1;
  const out: string[] = [];
  for (let i = start; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === undefined) continue;
    if (value.startsWith('--')) {
      i += 1; // skip its value
      continue;
    }
    out.push(value);
  }
  return out;
}

function usage(): void {
  console.log(`${c.bold('tdarr-test')} - test harness for Tdarr flows

${c.bold('Usage')}
  tdarr-test lint <flow.json...>        lint flow files
  tdarr-test lint --server <url>        lint every flow on a server
  tdarr-test flows --server <url>       list flows on a server
  tdarr-test fuzz <flow.json>           sweep many file shapes through a flow
  tdarr-test pull <name|id> --server <url> --out <file>
  tdarr-test plugins                    vendored plugin source status

${c.bold('Options')}
  --classic-plugins <dir>   classic Tdarr_Plugin_*.js directory
  --flow-plugins <dir>      LocalFlowPlugins directory
  --ignore <a,b>            lint rules to skip, e.g. missing-error-edge:nodeId
  --warnings-as-errors      exit non-zero on warnings too
  --api-key <key>           Tdarr API key, if the server requires one

${c.bold('fuzz options')}
  --limit <n>               variants to run (default 600, evenly sampled)
  --full                    run the entire matrix
  --node-name <name>        Tdarr node name to simulate as (default Nvidia)
  --target-container <ext>  container every file should end in (default mkv)
  --target-video <codec>    codec every file should end in (default hevc)

${c.dim('Exits 1 if any error-severity finding is reported.')}`);
}

// --- commands ---------------------------------------------------------------

function registryFor() {
  return buildRegistry({
    classicPluginDir: option('classic-plugins'),
    flowPluginDir: option('flow-plugins'),
  });
}

async function flowsToLint(): Promise<{ label: string; flow: Flow }[]> {
  const server = option('server');
  if (server) {
    const client = new TdarrClient({ url: server, apiKey: option('api-key') });
    const summaries = await client.listFlows();
    const loaded = [];
    for (const summary of summaries) {
      loaded.push({ label: summary.name, flow: await client.getFlowById(summary.id) });
    }
    return loaded;
  }

  const files = positionals('lint');
  if (files.length === 0) {
    throw new Error('no flow files given. Pass paths, or --server <url>.');
  }
  return files.map((file) => ({ label: basename(file), flow: Flow.fromFile(file) }));
}

async function cmdLint(): Promise<number> {
  const registry = registryFor();
  const ignore = (option('ignore') ?? '').split(',').map((r) => r.trim()).filter(Boolean);

  console.log(c.dim(`plugin source: ${describeVendor()}\n`));

  let errors = 0;
  let warnings = 0;

  for (const { label, flow } of await flowsToLint()) {
    const findings = lint(flow, { registry, ignore });
    printFindings(
      `${label}  ${c.dim(`${flow.nodes.length} nodes, ${flow.edges.length} edges`)}`,
      findings,
    );
    errors += findings.filter((f) => f.severity === 'error').length;
    warnings += findings.filter((f) => f.severity === 'warning').length;
  }

  if (errors === 0 && warnings === 0) return 0;
  return errors > 0 || flag('warnings-as-errors') ? 1 : 0;
}

async function cmdFlows(): Promise<number> {
  const server = option('server');
  if (!server) throw new Error('--server <url> is required');

  const client = new TdarrClient({ url: server, apiKey: option('api-key') });
  const flows = await client.listFlows();

  console.log(c.bold(`${flows.length} flow(s) on ${server}\n`));
  const width = Math.max(...flows.map((f) => f.name.length), 4);
  for (const flow of flows) {
    console.log(
      `  ${c.cyan(flow.id.padEnd(12))} ${flow.name.padEnd(width)}  `
        + c.dim(`${flow.nodeCount} nodes, ${flow.edgeCount} edges`),
    );
  }
  return 0;
}

async function cmdPull(): Promise<number> {
  const server = option('server');
  const out = option('out');
  const [target] = positionals('pull');

  if (!server || !target) throw new Error('usage: tdarr-test pull <name|id> --server <url> --out <file>');

  const client = new TdarrClient({ url: server, apiKey: option('api-key') });
  const flow = await client.findFlow(target);
  const destination = out ?? `${flow.name.replace(/\s+/g, '-').toLowerCase()}.json`;

  saveFlow(flow, destination);
  console.log(`${c.green(SYMBOL.ok)} saved ${c.bold(flow.name)} to ${destination}`);
  return 0;
}

function cmdFuzz(): number {
  const [file] = positionals('fuzz');
  if (!file) throw new Error('usage: tdarr-test fuzz <flow.json> [--limit n] [--full]');

  const flow = Flow.fromFile(file);
  const limit = flag('full') ? undefined : Number(option('limit') ?? 600);

  console.log(c.dim(`plugin source: ${describeVendor()}`));
  console.log(c.bold(c.blue(`\nfuzzing ${flow.name}`)));

  const report = fuzz(flow, {
    limit,
    classicPluginDir: option('classic-plugins'),
    flowPluginDir: option('flow-plugins'),
    nodeName: option('node-name') ?? 'Nvidia',
    targetContainer: option('target-container') ?? 'mkv',
    targetVideoCodec: option('target-video') ?? 'hevc',
  });

  const pct = (n: number) => `${((n / report.total) * 100).toFixed(0)}%`;
  console.log(
    `  ${report.total} variants`
      + (report.total < report.generated
        ? c.dim(` (sampled from ${report.generated}; --full for all)`)
        : ''),
  );
  console.log(
    `  ${c.green(`${report.clean.length} clean`)} ${c.dim(pct(report.clean.length))}   `
      + `${c.yellow(`${report.anomalous.length} anomalous`)} ${c.dim(pct(report.anomalous.length))}   `
      + `${c.red(`${report.halted.length} halted`)} ${c.dim(pct(report.halted.length))}\n`,
  );

  const sample = (items: { variant: { label: string } }[], n = 3) =>
    items.slice(0, n).map((i) => `      ${c.dim(i.variant.label)}`).join('\n')
      + (items.length > n ? `\n      ${c.dim(`...and ${items.length - n} more`)}` : '');

  if (report.halted.length > 0) {
    console.log(c.bold(c.red('HALTED — the flow died on these')));
    for (const [message, items] of groupBy(report.halted, (o) => o.result.halted?.message ?? '?')) {
      console.log(`  ${c.red(SYMBOL.error)} ${c.bold(String(items.length))} × ${wrap(message, 4)}`);
      console.log(sample(items));
    }
    console.log('');
  }

  if (report.anomalous.length > 0) {
    console.log(c.bold(c.yellow('ANOMALIES — completed, but not as intended')));
    for (const [key, items] of groupBy(report.anomalous, (o) => o.anomalies.join(', '))) {
      const explained = key
        .split(', ')
        .map((a) => ANOMALY_EXPLANATION[a as Anomaly] ?? a)
        .join('; ');
      console.log(`  ${c.yellow(SYMBOL.warning)} ${c.bold(String(items.length))} × ${c.bold(key)}`);
      console.log(`      ${c.dim(explained)}`);
      console.log(sample(items));
      console.log(`      ${c.cyan('->')} ${items[0]?.shape ?? ''}`);
    }
    console.log('');
  }

  console.log(c.bold('OUTPUT SHAPES'));
  for (const [shape, items] of groupBy(report.outcomes, (o) => o.shape)) {
    console.log(`  ${String(items.length).padStart(4)} × ${shape}`);
  }

  return report.halted.length > 0 ? 1 : 0;
}

function cmdPlugins(): number {
  const info = vendorInfo();
  if (!info) {
    console.log(c.yellow(`${SYMBOL.warning} no vendored plugin source`));
    console.log(c.dim('  run `pnpm plugins:update` to execute real plugins instead of models'));
    return 1;
  }

  const paths = vendorPaths();
  const found = discoverPlugins(paths.communityFlowPlugins);
  console.log(`${c.green(SYMBOL.ok)} ${c.bold(info.repo)}`);
  console.log(`  commit    ${info.sha}`);
  console.log(`  committed ${info.committedAt}`);
  console.log(`  plugins   ${found.length} community flow plugins`);
  return 0;
}

// --- entry ------------------------------------------------------------------

const command = argv[0];

try {
  let code: number;
  switch (command) {
    case 'lint':
      code = await cmdLint();
      break;
    case 'flows':
      code = await cmdFlows();
      break;
    case 'pull':
      code = await cmdPull();
      break;
    case 'fuzz':
      code = cmdFuzz();
      break;
    case 'plugins':
      code = cmdPlugins();
      break;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      usage();
      code = 0;
      break;
    default:
      console.error(c.red(`unknown command: ${command}\n`));
      usage();
      code = 1;
  }
  process.exit(code);
} catch (error) {
  console.error(c.red(`${SYMBOL.error} ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
}
