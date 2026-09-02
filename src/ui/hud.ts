import { BALANCE } from '../game/config';
import type { Game } from '../game/game';
import type { ToolSurface } from '../webmcp/tools';

type ToolCategory = 'read' | 'operative' | 'agent' | 'meta';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  get_situation: 'read',
  assess_tile: 'read',
  plan_route: 'read',
  list_abilities: 'read',
  get_run_status: 'read',
  move_operative: 'operative',
  hack_terminal: 'operative',
  grab_intel: 'operative',
  operate_door: 'operative',
  extract: 'operative',
  end_turn: 'operative',
  ping_scan: 'agent',
  cycle_door: 'agent',
  loop_camera: 'agent',
  trigger_distraction: 'agent',
  cut_power: 'agent',
  reroute_patrol: 'agent',
  begin_infiltration: 'meta',
  choose_implant: 'meta',
  start_new_run: 'meta',
};

export interface HudCallbacks {
  onHack(): void;
  onGrab(): void;
  onExtract(): void;
  onEndTurn(): void;
  onToggleSprint(): void;
  onBegin(): void;
  onChooseImplant(id: string): void;
  onNewRun(): void;
}

export class Hud {
  private statsEl = document.getElementById('stats') as HTMLElement;
  private bridgeEl = document.getElementById('bridge-status') as HTMLElement;
  private logEl = document.getElementById('log') as HTMLElement;
  private toolsEl = document.getElementById('tools') as HTMLElement;
  private toolCountEl = document.getElementById('tool-count') as HTMLElement;
  private toolHintEl = document.getElementById('tool-hint') as HTMLElement;
  private actionbarEl = document.getElementById('actionbar') as HTMLElement;
  private overlayEl = document.getElementById('overlay') as HTMLElement;

  sprintMode = false;
  private lastLogLength = -1;
  private lastOverlayKey = '';

  constructor(
    private game: Game,
    private tools: ToolSurface,
    private callbacks: HudCallbacks,
  ) {
    this.renderBridge();
  }

  private renderBridge(): void {
    const mode = this.tools.bridge.mode;
    const label =
      mode === 'native'
        ? 'WebMCP native'
        : mode === 'polyfill'
          ? 'WebMCP polyfill'
          : 'WebMCP unavailable';
    this.bridgeEl.innerHTML = `<span class="dot ${mode}"></span><span class="label">${label}</span>`;
    this.bridgeEl.title =
      mode === 'native'
        ? 'document.modelContext is provided by this browser — connected agents can drive the game directly.'
        : mode === 'polyfill'
          ? 'This browser has no native WebMCP, so the spec polyfill is installed. Tools are registered identically.'
          : 'No WebMCP context could be installed. The game is still fully playable by hand.';
  }

  render(): void {
    this.renderStats();
    this.renderLog();
    this.renderTools();
    this.renderActions();
    this.renderOverlay();
  }

  private renderStats(): void {
    const s = this.game.state;
    const alarmPct = Math.round((s.alarm / BALANCE.alarm.max) * 100);
    const critical = s.alarm >= 60;

    this.statsEl.innerHTML = `
      ${this.stat('Floor', `${s.floor.index + 1}/${BALANCE.run.floors}`)}
      ${this.stat('Turn', String(s.turn))}
      ${this.stat('Action pts', `${s.ap}/${s.maxAp}`)}
      ${this.stat('Bandwidth', `${s.bandwidth}/${s.maxBandwidth}`)}
      ${this.stat('Cores left', String(this.game.dataCoresRemaining()))}
      ${this.stat('Intel', String(s.intelThisRun))}
      <div class="stat alarm ${critical ? 'critical' : ''}">
        <div class="stat-label">Alarm</div>
        <div class="stat-value">${s.alarm}%</div>
        <div class="meter"><span style="width:${alarmPct}%"></span></div>
      </div>
      ${s.powerOutTurns > 0 ? this.stat('Blackout', `${s.powerOutTurns}t`) : ''}
    `;
  }

  private stat(label: string, value: string): string {
    return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  }

  private renderLog(): void {
    const log = this.game.state.log;
    if (log.length === this.lastLogLength) return;
    this.lastLogLength = log.length;
    this.logEl.innerHTML = log
      .slice(-60)
      .map(
        (entry) =>
          `<div class="log-entry ${entry.actor}"><span class="turn">T${entry.turn}</span>${escapeHtml(
            entry.text,
          )}</div>`,
      )
      .join('');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private renderTools(): void {
    const names = this.tools.registered;
    this.toolCountEl.textContent = names.length ? `${names.length}` : '';
    this.toolHintEl.textContent = this.tools.available
      ? 'Registered on document.modelContext. A connected agent can call these directly — the same functions the buttons below use.'
      : 'No WebMCP context in this browser. Play by hand, or open in a WebMCP-enabled browser to let an agent join.';
    this.toolsEl.innerHTML = names
      .map((name) => {
        const category = TOOL_CATEGORIES[name] ?? 'read';
        return `<li class="${category}"><span>${name}</span><span class="tag">${category}</span></li>`;
      })
      .join('');
  }

  private renderActions(): void {
    const s = this.game.state;
    const playing = s.phase === 'playing';
    const onLoot = s.floor.loot.some((l) => !l.taken && l.x === s.player.x && l.y === s.player.y);
    const adjacentTerminal = s.floor.terminals.some(
      (t) =>
        !t.hacked &&
        Math.max(Math.abs(t.x - s.player.x), Math.abs(t.y - s.player.y)) <= 1,
    );
    const onExtraction =
      s.player.x === s.floor.extraction.x && s.player.y === s.floor.extraction.y;

    this.actionbarEl.innerHTML = `
      <button id="btn-hack" ${!playing || !adjacentTerminal ? 'disabled' : ''}>Hack [E]</button>
      <button id="btn-grab" ${!playing || !onLoot ? 'disabled' : ''}>Lift intel [F]</button>
      <button id="btn-sprint" class="${this.sprintMode ? 'toggled' : ''}" ${!playing ? 'disabled' : ''}>Sprint [Shift]</button>
      <button id="btn-extract" class="primary" ${!playing || !onExtraction || !this.game.objectiveComplete() ? 'disabled' : ''}>Extract [X]</button>
      <span class="spacer"></span>
      <span class="keyhint">WASD / arrows move · click a tile to path · hover to preview risk</span>
      <button id="btn-end" ${!playing ? 'disabled' : ''}>End turn [Space]</button>
    `;

    this.bind('btn-hack', this.callbacks.onHack);
    this.bind('btn-grab', this.callbacks.onGrab);
    this.bind('btn-sprint', this.callbacks.onToggleSprint);
    this.bind('btn-extract', this.callbacks.onExtract);
    this.bind('btn-end', this.callbacks.onEndTurn);
  }

  private bind(id: string, handler: () => void): void {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  private renderOverlay(): void {
    const s = this.game.state;
    const key = `${s.phase}:${s.floor.index}:${s.implantChoices.map((i) => i.id).join(',')}`;
    if (key === this.lastOverlayKey) return;
    this.lastOverlayKey = key;

    if (s.phase === 'playing') {
      this.overlayEl.hidden = true;
      this.overlayEl.innerHTML = '';
      return;
    }

    this.overlayEl.hidden = false;
    if (s.phase === 'briefing') this.renderBriefing();
    else if (s.phase === 'choosing_implant') this.renderImplants();
    else this.renderRunEnd();
  }

  private renderBriefing(): void {
    const s = this.game.state;
    const mode = this.tools.bridge.mode;
    this.overlayEl.innerHTML = `
      <div class="card">
        <h2>NULLRUN</h2>
        <p class="sub">Floor ${s.floor.index + 1} of ${BALANCE.run.floors} · seed ${s.seed}</p>
        <p>
          You are the <strong>operative</strong> on the ground. Your handler is an
          <strong>AI agent</strong> connected over WebMCP — it does not press your buttons, it works
          the building: sweeping the network, looping cameras, blowing speakers, sealing doors
          and spoofing patrol routes while you move.
        </p>
        <ul>
          <li>Siphon every <code>data core</code>, then reach the extraction pad.</li>
          <li>You spend <code>action points</code>; the agent spends <code>bandwidth</code>. Both refill each turn.</li>
          <li>Getting seen raises the alarm. At 100% the facility locks down and the run ends.</li>
          <li>A hunting guard that reaches you ends the run outright.</li>
        </ul>
        <p class="sub" style="margin-top:18px">
          ${
            mode === 'unavailable'
              ? 'No WebMCP context detected — playable solo.'
              : `${this.tools.registered.length} tools registered on document.modelContext (${mode}).`
          }
        </p>
        <div class="card-actions">
          <button id="btn-begin" class="primary">Begin infiltration</button>
        </div>
      </div>
    `;
    this.bind('btn-begin', this.callbacks.onBegin);
  }

  private renderImplants(): void {
    const s = this.game.state;
    this.overlayEl.innerHTML = `
      <div class="card">
        <h2>Floor clear</h2>
        <p class="sub">Install one implant before descending</p>
        <div class="choices">
          ${s.implantChoices
            .map(
              (implant) =>
                `<button class="choice" data-implant="${implant.id}"><strong>${implant.name}</strong>${escapeHtml(
                  implant.description,
                )}</button>`,
            )
            .join('')}
        </div>
        <p class="sub">An agent can pick instead by calling <code>choose_implant</code>.</p>
      </div>
    `;
    for (const button of this.overlayEl.querySelectorAll<HTMLElement>('[data-implant]')) {
      button.addEventListener('click', () => {
        const id = button.dataset.implant;
        if (id) this.callbacks.onChooseImplant(id);
      });
    }
  }

  private renderRunEnd(): void {
    const s = this.game.state;
    const won = s.phase === 'run_complete';
    this.overlayEl.innerHTML = `
      <div class="card">
        <h2 style="color:${won ? 'var(--green)' : 'var(--red)'}">${won ? 'Extraction confirmed' : 'Run burned'}</h2>
        <p class="sub">${escapeHtml(s.endReason)}</p>
        <div class="stat-grid">
          <div><span>Floors cleared</span><strong>${won ? BALANCE.run.floors : s.floor.index}</strong></div>
          <div><span>Intel this run</span><strong>${s.intelThisRun}</strong></div>
          <div><span>Banked intel</span><strong>${s.bankedIntel}</strong></div>
          <div><span>Implants</span><strong>${s.implants.length}</strong></div>
        </div>
        <div class="card-actions">
          <button id="btn-newrun" class="primary">New run</button>
        </div>
      </div>
    `;
    this.bind('btn-newrun', this.callbacks.onNewRun);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
