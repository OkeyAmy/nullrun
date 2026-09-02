# NULLRUN

**A turn-based stealth roguelite built to be played by a human and an AI agent at the same time, over [WebMCP](https://github.com/webmachinelearning/webmcp).**

You are the operative on the ground. Your handler is an AI agent connected through
`document.modelContext`. It does not press your buttons — it works the building. It sweeps the
network, loops camera feeds, blows speakers to pull patrols, seals blast doors in a guard's face
and spoofs patrol routes, while you move through the gaps it opens.

---

## Why this is a WebMCP app, not a website with a chatbot bolted on

Most agent integrations expose what a user could already click. NULLRUN gives the agent a
**different set of verbs from the human**, backed by its own resource.

|                | Operative (human)                     | Handler (agent)                                   |
| -------------- | ------------------------------------- | ------------------------------------------------- |
| Resource       | 3 action points / turn                | 4 bandwidth / turn                                |
| Can do         | move, sprint, hack, lift intel, extract | ping the network, loop cameras, seal doors, cut power, reroute patrols |
| Cannot do      | see through walls, touch the grid     | physically move, hack a terminal, carry anything  |

Neither side can finish a floor alone. That is the whole design: the agent is a **second player
class**, not an accessibility layer over the first.

The read tools are built the same way — they return **reasoning material, not pixels**.
`plan_route` does not just return a path; it returns each step's risk, *which named guard or
camera watches that step*, and where cover exists:

```json
{
  "length": 7, "apRequired": 7, "exposedSteps": 2,
  "mostDangerousStep": { "x": 14, "y": 9, "risk": 18, "watchedBy": ["guard-1", "cam-0"] },
  "steps": [ { "order": 1, "x": 9, "y": 9, "risk": 0, "watchedBy": [], "cover": true } ]
}
```

An agent can act on that. It cannot act on a screenshot.

## How the agent experience improves the product

- **The turn structure is the integration.** Turn-based play means a 1–3s tool round trip is a
  legitimate game action rather than lag. This was chosen *because of* WebMCP, not in spite of it.
- **Tools appear only when they are usable.** `begin_infiltration` exists during the briefing and
  disappears once the floor starts; `choose_implant` exists only while an implant choice is
  pending; `start_new_run` only after a run ends. The agent's menu is never full of dead options.
- **Costs are introspectable.** `list_abilities` reports every action's live cost and whether it is
  currently affordable, so the agent plans against the real economy instead of guessing.
- **Failures explain themselves.** `"No walkable route to 14,9. A sealed door may be in the way —
  try cycle_door."` Errors name the tool that fixes them.
- **Same engine, both players.** Every tool calls the exact method the UI button calls. There is no
  agent-only code path that can drift from what a human sees.

## Choosing who plays

The first screen asks who is at the controls, and the answer is readable and settable by an agent
(`set_play_mode`, and `get_situation` reports `playMode` plus a `yourRole` sentence so a handler
that connects mid-run knows what it is expected to do):

- **Human** — you move the operative and an AI handler works the network alongside you.
- **AI** — the agent takes both roles and runs the whole infiltration itself.

An agent never has to touch the interface. The opening screen and the briefing are human
affordances — if a handler calls any gameplay tool first, the run starts for it automatically
(`ping_scan` on a cold page begins an agent run). Read tools stay side-effect free, so
`get_situation` never starts anything. A human who has already chosen co-op keeps that choice.

### Connecting your agent

The page publishes its tools on `document.modelContext`, so any WebMCP-aware agent discovers them
itself — there is nothing to paste and no key to configure:

Per the spec's [implementation status](https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md):

- **ChatGPT Desktop** — WebMCP is supported; open the URL and tell it to play. No flags.
- **Chrome 149+ / Edge 150+** — origin trial is live (requires Early Preview Program enrolment and
  an origin-trial token for the deployed origin).
- **nekuda WebMCP Workbench** — a [Chrome extension](https://chromewebstore.google.com/detail/nekuda-webmcp-workbench/amochnnbmnkjjlblolhpddkokhnalkjp)
  that lists a page's tools and drives them with an agent (bring your own key). The quickest way to
  play co-op today without origin-trial enrolment.
- **Brave** — experimental, via Leo.
- **No agent handy**: pick *AI* and run `pnpm demo` — a scripted handler
  (`tools/agent-demo.mjs`) plays through the same public tools, never touching the DOM or the
  engine. It currently clears two floors on the default seed in ~160 tool calls.

## The tool surface

**Read (free)** — `get_situation`, `assess_tile`, `plan_route`, `list_abilities`, `get_run_status`

**Operative, costs action points** — `move_operative`, `hack_terminal`, `grab_intel`,
`operate_door`, `extract`, `end_turn`

**Handler, costs bandwidth** — `ping_scan`, `cycle_door` (open **or seal**), `loop_camera`,
`trigger_distraction`, `cut_power`, `reroute_patrol`

**Phase-scoped** — `set_play_mode`, `begin_infiltration`, `choose_implant`, `start_new_run`

## The game

Five floors of a procedurally generated facility. Siphon every data core, reach the extraction
pad, choose an implant, descend. Getting seen raises the alarm; at 100% the facility locks down.
A hunting guard that reaches you ends the run. Intel banks between runs.

Guards have vision cones, hearing, and three alert states. Cover breaks line of sight at range.
Cutting power shortens *every* cone to 40%. Sealed doors genuinely re-route pathfinding — the
guard AI and the route planner both respect them.

## Running it

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # 36 tests: engine, WebMCP surface, invariants and fuzzing
pnpm smoke      # drives the real page in Chromium, incl. document.modelContext
pnpm demo       # a handler plays the game using only the WebMCP tools
pnpm evals:build  # regenerate the 313-case eval matrix
pnpm evals        # execute all 313 against the live page + a success-path pass
pnpm build
```

Open in a WebMCP-capable browser (Chrome with WebMCP enabled, or ChatGPT's browser) and the page
registers natively. Anywhere else it installs the
[`@mcp-b/webmcp-polyfill`](https://www.npmjs.com/package/@mcp-b/webmcp-polyfill) so the tools are
still registered identically — the badge in the top right tells you which mode you are in.

**Controls:** WASD/arrows move · click to path · hover to preview route risk · `E` hack · `F` lift
intel · `Shift` sprint · `X` extract · `Space` end turn.

## Verification

`pnpm demo` is itself the strongest completeness check: if a script that only has the public tool
surface can clear floors, the surface is complete.

The suite is deliberately broad rather than a handful of happy paths:

| Sweep | Scale |
| --- | --- |
| Floor invariants across seeds | 300 seeds x 5 floors — connectivity, no entity in geometry, every core reachable |
| Fuzzed play | 200 runs x 120 random tool actions, asserting state invariants after every single one |
| Resource safety | 120 runs checking AP/bandwidth can never rise mid-turn |
| Vision consistency | every tile of 40 floors — a reported watcher must have real line of sight and range |
| Blackout monotonicity | ~24,000 tile comparisons: cutting power can only ever remove watchers |
| Determinism / variety | same seed rebuilds byte-identical floors; 120 seeds produce near-unique layouts |
| Tool-choice evals | 313 generated cases across 18 tools (`pnpm evals:build`) |
| Eval execution | all 313 executed against the live page via `executeTool`, plus a 19-check success-path pass proving every tool can actually succeed, not merely respond |

`pnpm test` covers the simulation and the agent path — that sealing a door actually stops a guard
across the whole seal window, that cutting power removes a watcher, that the alarm ends a run,
that every generated floor is completable, and that tools execute through a real `modelContext`
and refuse impossible requests. Assertions were mutation-checked: breaking the behaviour they
describe makes them fail.

`pnpm smoke` boots the real page in Chromium, plays it, drives it via
`document.modelContext.executeTool`, hit-tests every control for occlusion, and fails on any
console error.

## Architecture

```
src/game/      simulation — config (all tuning), mapgen, vision/threat, grid, engine
src/render/    atlas manifest, palette, effects, canvas renderer
src/ui/        HUD, overlays, action bar
src/webmcp/    bridge (native → polyfill) and the tool surface
tools/         build-atlas.sh (asset pipeline), smoke.mjs (browser check)
```

All balance lives in `src/game/config.ts`; the tools report from that same table, so documentation
shown to an agent cannot drift from the rules.

## Credits

Environment and character art derived from [Kenney](https://kenney.nl) "Tiny Dungeon" (CC0),
recoloured into the NULLRUN palette by `tools/build-atlas.sh`. Effects, HUD and layout are
original. Licensed MIT — see [LICENSE](LICENSE).
