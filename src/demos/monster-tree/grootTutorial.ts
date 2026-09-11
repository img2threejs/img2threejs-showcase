export const GROOT_TUTORIAL_KEY = 'groot:forest-ftue:v1';

const STEPS = [
  ['Find your footing', 'Hold W A S D or the arrow keys to move through the clearing.', 'walk', 'Walk a short distance'],
  ['Gather momentum', 'Keep moving and hold Shift to break into a powerful run.', 'run', 'Run a short distance'],
  ['Strike in motion', 'Keep moving, then press 1 to cast Thorn Spear. Your legs keep their stride.', 'cast', 'Move and cast with 1'],
  ['Wake the lanterns', 'Release the movement keys, then press 0. Let the gesture finish: spirits will light your path for 18 seconds.', 'light', 'Summon with 0'],
  ['Leave the ground', 'Press Space to jump. Hold a direction to travel, or add Shift for a running leap. Land before jumping again.', 'jump', 'Jump with Space'],
] as const;

/** DOM-only, event-driven first-use guide. No timers can complete a learning step. */
export class GrootTutorial {
  readonly element = document.createElement('section');
  private readonly title: HTMLElement;
  private readonly copy: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly task: HTMLElement;
  private readonly replay: HTMLButtonElement;
  private step = 0;
  private distance = 0;
  private active = false;
  private awaitingLight = false;
  private readonly onReplay = (): void => this.start();

  constructor(parent: HTMLElement, replay: HTMLButtonElement) {
    this.replay = replay;
    this.element.className = 'groot-tutorial';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Forest controls tutorial');
    this.element.innerHTML = `<style>
      .groot-tutorial{position:absolute;top:112px;left:30px;width:min(300px,calc(100vw - 30px));padding:18px;box-sizing:border-box;border:1px solid #97afad44;border-radius:8px;background:linear-gradient(135deg,#0b1c24f2,#081116e8);box-shadow:0 16px 60px #0006;pointer-events:auto;backdrop-filter:blur(12px)}
      .groot-tutorial[hidden],.groot-hud[data-playing=false] .groot-tutorial{display:none}
      .groot-tutorial header{display:flex;justify-content:space-between;align-items:center;color:#a6c1c6;font-size:10px;letter-spacing:.12em}.groot-tutorial button{background:none;border:0;color:#c9d6d6;cursor:pointer;padding:5px;text-decoration:underline;text-underline-offset:3px}.groot-tutorial h2{font:23px Georgia,serif;color:#eedcb5;margin:15px 0 8px}.groot-tutorial p{font-size:12px;line-height:1.6;margin:0;color:#c0cfcd}.groot-tutorial footer{margin-top:12px;font-size:11px;color:#e6c990}
      .groot-lesson-art{height:76px;margin:14px 0;position:relative;overflow:hidden;border-radius:4px;background:radial-gradient(ellipse at center,#31515a33,transparent)}
      .groot-lesson-keys{position:absolute;left:8px;top:26px;display:flex;gap:4px}.groot-lesson-keys kbd{padding:7px 9px;border:1px solid #8daba86b;border-radius:4px;background:#162b32;color:#d5e8e0;box-shadow:0 3px #0008;font:12px system-ui}.groot-lesson-keys kbd:first-child{animation:groot-key 2s infinite}
      .groot-lesson-run,.groot-lesson-cast,.groot-lesson-light{display:none}.groot-tutorial[data-lesson=run] .groot-lesson-run,.groot-tutorial[data-lesson=cast] .groot-lesson-cast,.groot-tutorial[data-lesson=light] .groot-lesson-light{display:block}.groot-tutorial:not([data-lesson=walk]) .groot-lesson-walk{display:none}
      .groot-lesson-track{position:absolute;right:12px;top:18px;width:80px;height:40px;border-bottom:1px solid #9cbeb73b}.groot-lesson-foot{position:absolute;top:14px;width:7px;height:17px;border-radius:60% 60% 40% 40%;background:#c8bc95;animation:groot-foot 2s infinite}.groot-lesson-foot:nth-child(2){top:0;animation-delay:-1s}.groot-tutorial[data-lesson=run] .groot-lesson-foot{animation-duration:1s}.groot-tutorial[data-lesson=run] .groot-lesson-foot:nth-child(2){animation-delay:-.5s}
      .groot-tutorial[data-lesson=cast] .groot-lesson-track:after{content:'';position:absolute;top:8px;width:35px;height:4px;background:linear-gradient(90deg,#715536,#d8bd82);clip-path:polygon(0 30%,75% 0,100% 50%,75% 100%,0 70%);animation:groot-spear 2s infinite}
      .groot-tutorial[data-lesson=light] .groot-lesson-track{border:0}.groot-tutorial[data-lesson=light] .groot-lesson-foot{width:6px;height:6px;background:#fff0bd;border-radius:50%;box-shadow:0 0 8px 3px #f4c66d88,0 0 28px 14px #d5b57833;animation:groot-lantern 3s ease-in-out infinite}.groot-tutorial[data-lesson=light] .groot-lesson-foot:nth-child(2){animation-delay:-1.5s;left:35px}
      @keyframes groot-key{0%,70%,100%{transform:translateY(0);border-color:#8daba86b}20%,55%{transform:translateY(2px);border-color:#e6c990;background:#3c4538}}
      @keyframes groot-foot{0%{transform:translateX(0);opacity:0}20%,70%{opacity:.9}100%{transform:translateX(65px);opacity:0}}
      @keyframes groot-spear{0%,25%{transform:translateX(-10px) scaleX(.2);opacity:0}45%,65%{transform:translateX(45px) scaleX(1);opacity:1}100%{transform:translateX(45px);opacity:0}}
      @keyframes groot-lantern{0%,100%{transform:translate(8px,12px);opacity:.6}50%{transform:translate(24px,-5px);opacity:1}}
      .groot-lesson-jump{display:none}.groot-tutorial[data-lesson=jump] .groot-lesson-jump{display:block}.groot-tutorial[data-lesson=jump] .groot-lesson-foot{animation:groot-hop 2s ease-in-out infinite}.groot-tutorial[data-lesson=jump] .groot-lesson-foot:nth-child(2){left:10px;animation-delay:0s}
      @keyframes groot-hop{0%,100%{transform:translate(0,0)}50%{transform:translate(32px,-18px)}}
      @media(prefers-reduced-motion:reduce){.groot-tutorial *,.groot-tutorial *:after{animation:none!important}.groot-lesson-foot{opacity:.9}.groot-lesson-foot:nth-child(2){left:35px}}
      @media(max-width:650px){.groot-tutorial{top:104px;left:15px;width:265px;padding:13px}.groot-tutorial h2{font-size:20px;margin-top:10px}.groot-lesson-art{height:58px;margin:7px 0}.groot-lesson-keys{top:17px}.groot-lesson-track{top:8px}}
    </style><header><span class="groot-lesson-progress"></span><button type="button" class="groot-lesson-skip">Skip tutorial</button></header><div aria-live="polite"><h2></h2><p></p></div><div class="groot-lesson-art" aria-hidden="true"><div class="groot-lesson-keys"><div class="groot-lesson-walk"><kbd>W</kbd> <kbd>A S D</kbd></div><div class="groot-lesson-run"><kbd>Shift</kbd> <kbd>W</kbd></div><div class="groot-lesson-cast"><kbd>W</kbd> <kbd>1</kbd></div><div class="groot-lesson-light"><kbd>0</kbd></div></div><div class="groot-lesson-track"><i class="groot-lesson-foot"></i><i class="groot-lesson-foot"></i></div></div><footer></footer>`;
    this.title = this.element.querySelector('h2')!;
    this.element.querySelector('.groot-lesson-keys')!.insertAdjacentHTML('beforeend','<div class="groot-lesson-jump"><kbd>Space</kbd></div>');
    this.copy = this.element.querySelector('p')!;
    this.progress = this.element.querySelector('.groot-lesson-progress')!;
    this.task = this.element.querySelector('footer')!;
    this.element.querySelector('button')!.addEventListener('click', () => this.finish());
    replay.addEventListener('click', this.onReplay);
    parent.appendChild(this.element);
    let seen = false;
    try { seen = localStorage.getItem(GROOT_TUTORIAL_KEY) === 'done'; } catch { /* Private/storage-disabled browsing still works. */ }
    if (!seen) this.start();
  }

  start(): void {
    this.step = 0; this.distance = 0; this.awaitingLight = false; this.active = true;
    this.element.hidden = false; this.showStep();
  }
  private showStep(): void {
    const [title, copy, lesson, task] = STEPS[this.step];
    this.element.dataset.lesson = lesson;
    this.title.textContent = title; this.copy.textContent = copy;
    this.progress.textContent = `FIELD GUIDE · ${this.step + 1} / ${STEPS.length}`;
    this.task.textContent = task;
  }
  travel(distanceH: number, running: boolean): void {
    if (!this.active || this.step > 1 || (this.step === 1 && !running)) return;
    this.distance += distanceH;
    if (this.distance >= .18) this.advance();
  }
  cast(id: string, moving: boolean): void {
    if (!this.active) return;
    if (this.step === 2 && id === 'root-spear' && moving) this.advance();
    if (this.step === 3 && id === 'spirit-call') this.awaitingLight = true;
  }
  light(remaining: number): void {
    if (this.active && this.step === 3 && this.awaitingLight && remaining > 0) this.advance();
  }
  jump():void {if(this.active&&this.step===4)this.advance();}
  private advance(): void {
    this.distance = 0;
    if (++this.step === STEPS.length) this.finish(); else this.showStep();
  }
  private finish(): void {
    this.active = false; this.element.hidden = true;
    try { localStorage.setItem(GROOT_TUTORIAL_KEY, 'done'); } catch { /* Persistence is optional, input is not. */ }
  }
  dispose(): void { this.replay.removeEventListener('click', this.onReplay); this.element.remove(); }
}
