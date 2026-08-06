# tdarr-flow-test

A typed test harness for [Tdarr](https://github.com/HaveAGitGat/Tdarr) flows.

Tdarr flows are graphs wired up in a browser, and a mistake in one is usually
invisible: an edge attached to an output handle the plugin does not have looks
exactly like an edge that works, and you find out when a file lands in the
library in the wrong shape. This library lets you assert on a flow the way you
would assert on code.

Three layers, in increasing cost and increasing truth:

| layer | what it proves | needs |
|---|---|---|
| **lint** | the graph is wired coherently | the flow JSON |
| **unit** | your own plugins do what you think | plugin source |
| **simulate** | a given file takes a given path through the flow | both |

None of them run ffmpeg. For that, drive real files through a real server -
the harness is for the flow defects that are decided before ffmpeg is invoked.

Stock plugins are **executed from real vendored Tdarr source**, not modelled.
Run `pnpm plugins:update` once (see below) and routing decisions come from the
same code Tdarr runs.

## Install

```sh
pnpm add -D tdarr-flow-test
```

Requires Node 22.18+. The package ships TypeScript source and is executed by
Node's native type stripping, so there is no build step and no `dist/`.

## Lint a flow

```ts
import { Flow, builtinRegistry, lint, formatFindings } from 'tdarr-flow-test';

const flow = Flow.fromFile('flows/transcode-pipeline.json');
const findings = lint(flow, { registry: builtinRegistry() });

console.log(formatFindings(findings));
```

Rules: `entry-node`, `dangling-edge`, `unreachable-node`, `nonexistent-handle`,
`unwired-handle`, `missing-error-edge`, `mixed-plugin-versions`,
`overlapping-nodes`, `unmodelled-plugin`.

Silence one with `ignore`, scoped to a node and with a reason:

```ts
lint(flow, {
  registry: builtinRegistry(),
  // Deliberate: a tagging failure must not commit a possibly-bad transcode.
  ignore: ['missing-error-edge:audProped'],
});
```

## Unit test your plugins

Classic plugins are pure functions from a file record to an ffmpeg preset,
which makes them the easiest part of a Tdarr setup to test. The loader
evaluates your real source with `methods/lib` and `FlowHelpers` stubbed, so you
are testing the plugin rather than a reimplementation of it.

```ts
import { loadClassicPlugin, probe } from 'tdarr-flow-test';

const { plugin } = loadClassicPlugin('Tdarr_Plugin_bsh1_RemuxMKV', {
  dir: 'plugins/Local',
});

const file = probe.file({
  container: 'avi',
  streams: [probe.video({ codec: 'mpeg4' }), probe.audio({ codec: 'mp3', channels: 1 })],
});

const result = plugin(file, {}, {}, {});
const [inputArgs] = result.preset.split(',');
expect(inputArgs).toContain('-fflags +genpts');
```

`loadFlowPlugin` does the same for local flow plugins.

## Simulate a file through a flow

```ts
import { Flow, probe, simulate } from 'tdarr-flow-test';

const flow = Flow.fromFile('flows/transcode-pipeline.json');

const result = simulate(
  flow,
  probe.file({
    container: 'mkv',
    streams: [
      probe.video({ codec: 'h264' }),
      probe.audio({ codec: 'dts', channels: 6 }),
      probe.audio({ codec: 'aac', channels: 2 }),
    ],
  }),
  {
    nodeName: 'Nvidia',
    classicPluginDir: 'plugins/Local',
    flowPluginDir: 'plugins/FlowPlugins/LocalFlowPlugins',
  },
);

expect(result.audio).toHaveLength(1);
expect(result.audio[0].channels).toBe(6);   // did a stereo track win?
expect(result.replaced).toBe(true);          // did it commit?
expect(result.visited).toContain('Force Remux');
```

`SimulationResult` gives you `file`, `audio` / `video` / `subtitles`,
`replaced`, `halted`, `visited`, `path` and `log`.

`halted` is the interesting one. It is set when the flow died rather than
finished, and distinguishes the ways that happens: `crash` (a node threw with
no error handle to catch it), `deadEnd` (a node left by a handle with no
outgoing edge), `fanout`, `loop`, `unmodelled`.

### How much to trust it

The harness executes real plugin code wherever it can:

- **your** classic and flow plugins - always, from your own source
- **stock** flow plugins - from vendored Tdarr source, once `plugins:update`
  has run. `tdarr-test plugins` shows which commit.

What stays modelled is the handful of nodes that shell out to ffmpeg or
mkvpropedit, or move files: `ffmpegCommandExecute`, `runMkvPropEdit`,
`runClassicTranscodePlugin`, `inputFile`, `replaceOriginalFile`,
`setOriginalFile`, `checkFileChanged` (see `MUST_MODEL`). Their *routing* is
reproduced from the real source - `ffmpegCommandExecute`'s `shouldProcess`
derivation, for instance, is copied from the plugin rather than guessed - but
their side effects are simulated. Anything that depends on ffmpeg's actual
output needs an end-to-end run.

Each model carries a `confidence` of `observed` or `assumed`, and `lint` marks
findings that rest on an `assumed` model with `assumed: true`. Treat those as
hypotheses. Real plugins are always `observed`.

Without vendored source everything falls back to hand-written models. That
still works, but it is materially weaker - and it is how this library
originally, wrongly, concluded that a flow edge was dead when the plugin
version actually in use had three outputs rather than two.

## Vendoring Tdarr plugin source

```sh
pnpm plugins:update                 # latest master
pnpm plugins:update --ref <sha>     # pin to a commit
tdarr-test plugins                  # what is vendored right now
```

This pulls `FlowPlugins/CommunityFlowPlugins`, `FlowPlugins/FlowHelpers` and
`methods/` from `HaveAGitGat/Tdarr_Plugins` into `vendor/`, mirroring the repo
layout so plugins' relative requires resolve. The resolved commit is recorded
in `vendor/VERSION.json`.

Note that Tdarr ships **compiled** plugins from `FlowPlugins/`, not the
TypeScript in `FlowPluginsTs/`, so that is what gets vendored. Pin `--ref` to
match your server when a plugin's behaviour matters; the plugin repo carries no
tags and moves independently of Tdarr releases.

## Command line

```sh
tdarr-test lint <flow.json...>          # pretty-printed structural lint
tdarr-test lint --server <url>          # lint every flow on a server
tdarr-test fuzz <flow.json>             # sweep many file shapes through a flow
tdarr-test flows --server <url>         # list flows
tdarr-test pull "My Flow" --server <url> --out flows/my-flow.json
tdarr-test plugins                      # vendored source status
```

`lint` groups findings by node and exits 1 on any error.
`--warnings-as-errors` tightens that for CI.

`fuzz` builds a matrix of containers x video codecs x audio layouts x subtitle
layouts, runs each through the flow, and groups the results:

```
  400 variants (sampled from 8568; --full for all)
  374 clean 94%   23 anomalous 6%   3 halted 1%

HALTED - the flow died on these
  ✖ 3 x No streams mapped for new file
      mkv | no-video | none | subs:fre

ANOMALIES - completed, but not as intended
  ⚠ 23 x silent
      input had audio, output has none
```

It flags `silent`, `not-target-container`, `multiple-audio`, `not-replaced`,
`lost-subtitles` and `video-not-target-codec`. Anomalies are judged against
`--target-container`, `--target-video` and the language the flow is meant to
keep, so deliberately stripping foreign tracks is not reported. It is a
discovery tool: anything it surfaces should become a named test.

The full matrix takes several minutes, so runs are sampled by even stride
across it (never head-truncated) and the report always says how many were
skipped.

## Pull flows from a server

Flows live in SQLite on the server, not on disk, so keeping a copy in version
control is otherwise a manual export.

```ts
import { TdarrClient, saveFlow } from 'tdarr-flow-test';

const client = new TdarrClient({ url: 'http://192.168.1.42:8266' });

for (const flow of await client.listFlows()) {
  console.log(`${flow.id}  ${flow.name}  (${flow.nodeCount} nodes)`);
}

const flow = await client.findFlow('Transcode Pipeline');  // by name or id
saveFlow(flow, 'flows/transcode-pipeline.json');
```

`listLibraries()` shows which library runs which flow. Anything not wrapped is
reachable through `client.raw(path, body)` and `client.crud({ collection, mode })`.

Tdarr's API is not versioned separately from the app and endpoint shapes have
moved between releases; this is verified against **2.86.01**. Collection names
are parameters, so a rename is a one-line fix at the call site.

## Extending the registry

Register a model for a plugin the library does not know, or override one:

```ts
import { builtinRegistry, simulate } from 'tdarr-flow-test';

const registry = builtinRegistry({ classicPluginDir: 'plugins/Local' });

registry.register('checkHdr', {
  outputs: 2,
  error: false,
  confidence: 'assumed',
  note: 'true when the video stream carries HDR metadata',
  run: (ctx) => (ctx.file.streams.some((s) => s.color_transfer === 'smpte2084') ? '1' : '2'),
});

simulate(flow, file, { registry });
```

Local flow plugins found under `flowPluginDir` are auto-registered and executed
for real, so they never need a model.

## Development

```sh
pnpm check      # typecheck + lint + test
```
