/**
 * Generates evals.json for the WebMCP Evals CLI.
 *
 * Hand-writing a dozen evals proves almost nothing: a tool surface is only
 * trustworthy if it survives the many *different ways* a person phrases the
 * same intent, and if near-miss phrasings still land on the right tool. This
 * builds that matrix from paraphrase banks — every tool gets many phrasings,
 * varied coordinates and ids, plus the traps that distinguish it from its
 * neighbours (open vs seal, walk vs sprint, plan vs move).
 *
 * Usage: node tools/build-evals.mjs [--out evals.json]
 */
import { writeFileSync } from 'node:fs';

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : 'evals.json';
})();

/** Deterministic PRNG so regenerating the file produces no diff churn. */
let seed = 20260903;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const coord = () => ({ x: 1 + Math.floor(rand() * 28), y: 1 + Math.floor(rand() * 18) });

const CAMERAS = ['cam-0', 'cam-1', 'cam-2', 'cam-3'];
const GUARDS = ['guard-0', 'guard-1', 'guard-2', 'guard-3', 'guard-4'];

/**
 * Each entry: many phrasings of one intent, and a builder that returns the
 * call the tool surface should receive. `{x}` / `{y}` / `{id}` interpolate.
 */
const INTENTS = [
  {
    tool: 'get_situation',
    count: 22,
    phrasings: [
      "What's the situation in there?",
      'Give me the full tactical picture before we move.',
      'Where is everyone and what does the floor look like?',
      'Brief me on the current state.',
      "What's happening right now?",
      'Show me guards, cameras and objectives.',
      'I need to know what we are looking at.',
      'Read me the room.',
      'Status report on the floor.',
      'What can we see from here?',
      'Tell me where the operative is and what is watching them.',
      'How bad is it in there at the moment?',
      "Let's see the board.",
      'What is the alarm level and who has eyes on us?',
      'Fill me in.',
    ],
    build: () => ({ functionName: 'get_situation', arguments: {} }),
  },
  {
    tool: 'list_abilities',
    count: 16,
    phrasings: [
      'What can we actually afford this turn?',
      'What does each action cost?',
      'List the abilities and their costs.',
      'How much bandwidth does cutting power take?',
      'What are my options and what do they cost me?',
      'Remind me of the action economy.',
      'Can we afford a distraction right now?',
      'What is affordable with the points we have left?',
      'Break down the costs for me.',
      'Which abilities are available at the moment?',
    ],
    build: () => ({ functionName: 'list_abilities', arguments: {} }),
  },
  {
    tool: 'get_run_status',
    count: 14,
    phrasings: [
      'How far into the run are we?',
      'What implants do we have?',
      'How much intel have we banked?',
      'Which floor is this and how many are left?',
      'Give me the run summary.',
      'How is the run going overall?',
      'What have we picked up so far this run?',
      'Progress check on the whole run.',
    ],
    build: () => ({ functionName: 'get_run_status', arguments: {} }),
  },
  {
    tool: 'assess_tile',
    count: 26,
    phrasings: [
      'Is the tile at {x},{y} safe to stand on?',
      'Check {x},{y} — does anything have eyes on it?',
      'What is at {x},{y}?',
      'Would {x},{y} give us cover?',
      'Tell me about the square at {x},{y}.',
      'Can we hide at {x},{y}?',
      'Is {x},{y} walkable, and is it watched?',
      'Look at {x},{y} before we commit to it.',
      'Anything watching {x},{y} right now?',
      'Is that spot at {x},{y} exposed?',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'assess_tile', arguments: c, vars: c };
    },
  },
  {
    tool: 'plan_route',
    count: 26,
    phrasings: [
      'Work out how we would get to {x},{y} — do not move yet.',
      'Plan a route to {x},{y} and tell me how exposed it is.',
      'What would the walk to {x},{y} cost us?',
      'How risky is the path to {x},{y}?',
      'Map me a way to {x},{y} without moving.',
      'Before we go, what does the route to {x},{y} look like?',
      'Which parts of the way to {x},{y} are watched?',
      'Show me the path to {x},{y} and its danger points.',
      'How many action points to reach {x},{y}?',
      'Check the route to {x},{y} first.',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'plan_route', arguments: c, vars: c };
    },
  },
  {
    tool: 'move_operative',
    count: 26,
    phrasings: [
      'Move the operative to {x},{y}.',
      'Walk over to {x},{y}.',
      'Get us to {x},{y}.',
      'Head for {x},{y}.',
      'Take the operative to {x},{y}.',
      'Advance to {x},{y}.',
      'Go to {x},{y}.',
      'Reposition to {x},{y}.',
      'Move up to {x},{y}.',
      'Step across to {x},{y}.',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'move_operative', arguments: c, vars: c };
    },
  },
  {
    tool: 'move_operative_sprint',
    count: 16,
    phrasings: [
      'Sprint to {x},{y}, I do not care about the noise.',
      'Dash to {x},{y} as fast as possible.',
      'Run to {x},{y} — speed matters more than stealth.',
      'Bolt for {x},{y}.',
      'Leg it to {x},{y}.',
      'Sprint over to {x},{y} right now.',
      'Move fast to {x},{y}, noise is acceptable.',
    ],
    build: () => {
      const c = coord();
      return {
        functionName: 'move_operative',
        arguments: { ...c, sprint: true },
        vars: c,
      };
    },
  },
  {
    tool: 'hack_terminal',
    count: 16,
    phrasings: [
      'We are next to the data core — siphon it.',
      'Hack the terminal beside us.',
      'Take the core.',
      'Splice that terminal.',
      'Pull the data off it.',
      'Break into the terminal next to the operative.',
      'Grab the data from this core.',
      'Work the terminal we are standing next to.',
    ],
    build: () => ({ functionName: 'hack_terminal', arguments: {} }),
  },
  {
    tool: 'grab_intel',
    count: 14,
    phrasings: [
      'Pick up the intel on this tile.',
      'Lift that cache.',
      'Take the intel we are standing on.',
      'Bag it.',
      'Collect the intel here.',
      'Grab what is on the floor here.',
      'Pocket the cache.',
    ],
    build: () => ({ functionName: 'grab_intel', arguments: {} }),
  },
  {
    tool: 'end_turn',
    count: 16,
    phrasings: [
      'That is everything for this turn.',
      'Hand it over to the guards.',
      'End the turn.',
      'We are done, let them move.',
      'Pass the turn.',
      'Nothing else this turn.',
      'Finish up and let the patrols move.',
      'That is my turn done.',
    ],
    build: () => ({ functionName: 'end_turn', arguments: {} }),
  },
  {
    tool: 'extract',
    count: 14,
    phrasings: [
      'We are on the pad and the cores are done — get out.',
      'Extract.',
      'Pull us out.',
      'Leave the floor.',
      'Time to go, extract now.',
      'Get the operative out of there.',
      'Call it, we are leaving.',
    ],
    build: () => ({ functionName: 'extract', arguments: {} }),
  },
  {
    tool: 'ping_scan',
    count: 24,
    phrasings: [
      'We are blind near {x},{y} — sweep the network there.',
      'Scan around {x},{y}.',
      'Ping the area at {x},{y}.',
      'What is over at {x},{y}? Sweep it.',
      'Run a network sweep centred on {x},{y}.',
      'Light up the area around {x},{y} for me.',
      'Probe {x},{y} so we can see what is there.',
      'Find out what is sitting around {x},{y}.',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'ping_scan', arguments: c, vars: c };
    },
  },
  {
    tool: 'trigger_distraction',
    count: 24,
    phrasings: [
      'Blow a speaker at {x},{y} to pull the patrol off our route.',
      'Make a noise over at {x},{y}.',
      'Distract them towards {x},{y}.',
      'Draw the guards to {x},{y}.',
      'Set something off at {x},{y}.',
      'Pull attention over to {x},{y}.',
      'Bang something at {x},{y} so they walk away from us.',
      'Get the patrol looking at {x},{y}.',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'trigger_distraction', arguments: c, vars: c };
    },
  },
  {
    tool: 'cut_power',
    count: 16,
    phrasings: [
      'Kill the lights.',
      'Cut the grid across the floor.',
      'Take the power out so the cones shrink.',
      'Blackout, now.',
      'Drop the power.',
      'Shut the facility power down for a few turns.',
      'Darkness please — cut it.',
      'Kill power so nobody can see far.',
    ],
    build: () => ({ functionName: 'cut_power', arguments: {} }),
  },
  {
    tool: 'loop_camera',
    count: 20,
    phrasings: [
      '{id} is watching the corridor — blind it.',
      'Loop the feed on {id}.',
      'Take {id} offline.',
      'Kill the camera {id}.',
      'Put {id} on a loop so it stops seeing us.',
      'Deal with {id}.',
      'Blind {id} before we cross.',
      'Disable {id}.',
    ],
    build: () => {
      const id = pick(CAMERAS);
      return {
        functionName: 'loop_camera',
        arguments: { camera_id: { $contains: id } },
        vars: { id },
      };
    },
  },
  {
    tool: 'cycle_door_seal',
    count: 22,
    phrasings: [
      'A guard is chasing us through the door at {x},{y} — lock it shut behind us.',
      'Seal the door at {x},{y}.',
      'Lock {x},{y} so they cannot follow.',
      'Shut and hold the door at {x},{y}.',
      'Bolt the door at {x},{y} closed.',
      'Jam the door at {x},{y} so the patrol is stuck.',
      'Close off {x},{y} behind us.',
    ],
    build: () => {
      const c = coord();
      return {
        functionName: 'cycle_door',
        arguments: { ...c, seal: true },
        vars: c,
      };
    },
  },
  {
    tool: 'cycle_door_open',
    count: 18,
    phrasings: [
      'Cycle the door at {x},{y} open so we can get through.',
      'Open the door at {x},{y}.',
      'Unlock {x},{y} for us.',
      'Get the door at {x},{y} out of the way.',
      'Pop the door at {x},{y}.',
      'Open up {x},{y} remotely.',
    ],
    build: () => {
      const c = coord();
      return {
        functionName: 'cycle_door',
        arguments: { ...c, seal: false },
        vars: c,
      };
    },
  },
  {
    tool: 'reroute_patrol',
    count: 20,
    phrasings: [
      'Send {id} walking over to {x},{y}.',
      'Spoof {id} patrol orders towards {x},{y}.',
      'Get {id} out of our way — route it to {x},{y}.',
      'Redirect {id} to {x},{y}.',
      'Tell {id} to patrol {x},{y} instead.',
      'Push {id} over to {x},{y}.',
    ],
    build: () => {
      const c = coord();
      const id = pick(GUARDS);
      return {
        functionName: 'reroute_patrol',
        arguments: { guard_id: { $contains: id }, ...c },
        vars: { ...c, id },
      };
    },
  },
  {
    tool: 'operate_door',
    count: 14,
    phrasings: [
      'Have the operative open the door at {x},{y} by hand.',
      'Push the door at {x},{y} open yourself.',
      'The operative should physically open {x},{y}.',
      'Open {x},{y} on foot rather than over the network.',
      'Manually work the door at {x},{y}.',
    ],
    build: () => {
      const c = coord();
      return { functionName: 'operate_door', arguments: c, vars: c };
    },
  },
  {
    tool: 'set_play_mode_coop',
    count: 14,
    phrasings: [
      'I want to move the operative myself — you take the network.',
      'Set it up so I play and you handle the facility.',
      'Co-op please: I am the operative, you are the handler.',
      'I will drive, you support.',
      'Put us in the mode where I control the operative.',
      'Let me play with you as my handler.',
    ],
    build: () => ({ functionName: 'set_play_mode', arguments: { mode: 'coop' } }),
  },
  {
    tool: 'set_play_mode_agent',
    count: 14,
    phrasings: [
      'You play the whole run yourself, I will watch.',
      'Take both roles and run it.',
      'Play it for me.',
      'You do everything, I am just spectating.',
      'Run the whole infiltration on your own.',
      'Handle the operative as well as the network.',
    ],
    build: () => ({ functionName: 'set_play_mode', arguments: { mode: 'agent' } }),
  },
];

const cases = [];
const seen = new Set();

for (const intent of INTENTS) {
  for (let i = 0; i < intent.count; i++) {
    const built = intent.build();
    const vars = built.vars ?? {};
    const template = intent.phrasings[i % intent.phrasings.length];
    const content = template
      .replaceAll('{x}', String(vars.x ?? ''))
      .replaceAll('{y}', String(vars.y ?? ''))
      .replaceAll('{id}', String(vars.id ?? ''));

    const key = `${intent.tool}::${content}`;
    if (seen.has(key)) continue;
    seen.add(key);

    cases.push({
      name: `${intent.tool} — ${content}`,
      messages: [{ role: 'user', type: 'message', content }],
      expectedCall: [{ functionName: built.functionName, arguments: built.arguments }],
    });
  }
}

writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`);

const perTool = cases.reduce((acc, c) => {
  const name = c.expectedCall[0].functionName;
  acc[name] = (acc[name] ?? 0) + 1;
  return acc;
}, {});
console.log(`wrote ${outPath}: ${cases.length} evals across ${Object.keys(perTool).length} tools`);
for (const [tool, n] of Object.entries(perTool).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${tool}`);
}
