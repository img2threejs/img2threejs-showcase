import * as THREE from 'three';
import type { Viewer } from '../../scene';
import { GROOT_GAIT, type GrootMotion } from './grootAnimation';
import type { GrootEffects } from './grootEffects';
import { GrootTutorial } from './grootTutorial';
import { forestGround, GROOT_WORLD_RADIUS_H } from './grootTerrain';
import { GrootDayNight } from './grootDayNight';
import { GrootSound } from './grootSound';
import { GrootCamera } from './grootCamera';
import { isV2 } from './grootImportedMotion';
import { GrootWardrobe } from './grootWardrobe';
import { GrootRenderQuality } from './grootRenderQuality';

export const GROOT_KEYS=[
  ['1','root-spear','Thorn Spear'],['2','vine-sweep','Faultline'],['3','root-stomp','Earthshatter'],
  ['4','root-charge','Rootfall'],['5','verdant-embrace','Root Embrace'],['6','sanctuary','Sanctuary'],
  ['7','regrowth','Bark Armour'],['8','seed-sanctum','Life Seeds'],['9','spore-bloom','Little Groot'],['0','spirit-call','Lantern Spirits'],
] as const;
export const GROOT_EXTRA_KEYS=[
  ['1','forest-roar','Elderwood Roar'],['2','eclipse-kick','Eclipse Reaper'],['3','splinter-kick','Splinter Gale'],
  ['4','comet-drop','Comet Descent'],['5','spore-tempest','Spore Tempest'],['6','twin-cyclone','Twin Cyclones'],
  ['7','petal-collapse','Nightfall Petals'],['8','husk-rebirth','Husk Rebirth'],['9','last-stand','Last Stand'],
] as const;
const ALL_SKILLS=[...GROOT_KEYS,...GROOT_EXTRA_KEYS];
const locomotion=(id:string):boolean=>id==='grove-idle'||id==='forest-walk'||id==='forest-run';
const FORM_CAST_WAIT='Transforming · Please wait for your form to settle before casting.';
const editable=(target:EventTarget|null):boolean=>target instanceof HTMLElement&&(target.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(target.tagName));

/** Local single-player controller. Owns input/camera/HUD, never replaces the viewer's RAF. */
export class GrootGame {
  enabled=true;
  paused=false;
  stealthed=false;
  shadersReady=false;
  private disposed=false;
  private warmupFrame=0;
  private scaleValue=.7;
  private readonly quality:GrootRenderQuality;
  private qualityLabel:HTMLElement|null=null;
  get renderScale():number{return this.scaleValue;}
  set renderScale(value:number){if(this.disposed||![1,.85,.7].includes(value))return;this.scaleValue=value;this.quality?.setScale(value);}
  private readonly originalPixelRatio:number;
  readonly velocity=new THREE.Vector3();
  readonly cooldowns=new Float32Array(ALL_SKILLS.length);
  private bank=0;
  private readonly held=new Set<string>();
  private readonly forward=new THREE.Vector3();
  private readonly right=new THREE.Vector3();
  private readonly desired=new THREE.Vector3();
  private readonly oldPosition=new THREE.Vector3();
  private readonly up=new THREE.Vector3(0,1,0);
  private readonly hud=document.createElement('div');
  private readonly status:HTMLElement;
  private readonly toggle:HTMLButtonElement;
  readonly tutorial:GrootTutorial;
  readonly wardrobe:GrootWardrobe;
  readonly dayNight:GrootDayNight;
  readonly sound:GrootSound;
  readonly perspective:GrootCamera;
  private readonly viewButton=document.createElement('button');
  private readonly buttons:HTMLButtonElement[]=[];
  private readonly timers:HTMLElement[]=[];
  private uiTime=0;
  private disposeInput:()=>void;
  private castLoop=false;
  private readonly worldLabel=document.createElement('div');
  private readonly relicLabel=document.createElement('div');
  private readonly worldLights:THREE.Object3D|undefined;
  private readonly lightOrigin=new THREE.Vector3();
  private readonly studioGround:{mesh:THREE.Mesh;visible:boolean}[]=[];
  constructor(readonly actor:THREE.Group,readonly motion:GrootMotion,readonly effects:GrootEffects,readonly viewer:Viewer){
    // The viewer's flat y=0 shadow catcher depth-writes above the carved stream, masking it
    // with a huge triangle despite its transparent colour. This world has its own terrain receiver.
    for(const object of viewer.scene.children){
      if(object instanceof THREE.Mesh&&object.material instanceof THREE.ShadowMaterial){
        this.studioGround.push({mesh:object,visible:object.visible});object.visible=false;
      }
    }
    this.perspective=new GrootCamera(viewer,actor,motion.height,()=>this.enabled&&!this.paused&&!this.wardrobe?.open);
    this.hud.className='groot-hud';
    this.hud.innerHTML=`<style>
      body.groot-playing #demo-panel,body.groot-playing #demo-hint{display:none!important}
      .groot-hud{position:absolute;inset:0;pointer-events:none;z-index:20;color:#e4e6dd;font:12px system-ui}
      .groot-heading{position:absolute;left:30px;top:28px;text-shadow:0 2px 15px #000}.groot-heading strong{display:block;letter-spacing:.28em;font:30px Georgia,serif}.groot-heading small{display:block;margin-top:9px;color:#98acb1;letter-spacing:.18em}
      .groot-mode{position:absolute;right:26px;top:26px;pointer-events:auto;color:#d6e1e2;border:1px solid #7d949c55;background:#081319bb;padding:11px 17px;border-radius:4px;cursor:pointer}
      .groot-guide{position:absolute;right:26px;top:75px;pointer-events:auto;color:#b8cacd;border:0;background:#081319aa;padding:8px 12px;border-radius:4px;cursor:pointer}.groot-hud[data-playing=false] .groot-guide{display:none}
      .groot-spellbook{position:absolute;right:26px;top:114px;pointer-events:auto;color:#d1d79e;border:1px solid #87966666;background:#081319cc;padding:8px 12px;border-radius:4px;cursor:pointer}.groot-hud[data-playing=false] .groot-spellbook{display:none}.groot-skill[hidden]{display:none}
      .groot-controls{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);width:min(1040px,94vw);text-align:center}
      .groot-help{color:#a6b7bc;font-size:11px;letter-spacing:.06em;margin-bottom:13px;text-shadow:0 1px 8px #000}
      .groot-skills{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;pointer-events:auto}
      .groot-skill{position:relative;min-width:0;padding:12px 4px 10px;border:1px solid #69848766;border-radius:5px;background:linear-gradient(0deg,#10282ce8,#071015ee);color:#d8e4df;cursor:pointer;overflow:hidden}
      .groot-skill:before{content:'';position:absolute;inset:0;background:#95dfe020;transform:scaleY(var(--ready,0));transform-origin:bottom;pointer-events:none}
      .groot-skill:hover,.groot-skill:focus-visible{border-color:#d5c494;outline:1px solid #d5c494}.groot-skill[data-active=true]{border-color:#f1d7a0;box-shadow:0 0 25px #d8ac6233}
      .groot-skill kbd{display:block;font:18px Georgia,serif;color:#e5c98f;margin-bottom:6px}.groot-skill span{font-size:10px}.groot-skill em{display:block;height:12px;font:10px system-ui;color:#94bec6;margin-top:5px}
      .groot-status{min-height:17px;margin:10px 0 0;color:#cfbb8f}.groot-hud[data-playing=false] .groot-controls{display:none}
      .groot-relics{position:absolute;left:30px;top:94px;padding:8px 11px;border-left:2px solid #78c9b1;background:#071216aa;color:#b9d8cf;letter-spacing:.08em;text-shadow:0 1px 7px #000;box-sizing:border-box;max-width:calc(100% - 280px)}.groot-relics strong{color:#e1fff4;font-weight:600}
      .groot-hud[data-stealthed=true] .groot-status{color:#c9efa4;text-shadow:0 0 14px #6ca85999}.groot-hud[data-stealthed=true] .groot-heading small:after{content:' · CONCEALED';color:#c9efa4}
      .groot-hud[data-playing=false] > :not(style):not(.groot-tools){display:none!important}
      .groot-hud[data-playing=false] .groot-tools > :not(.groot-mode){display:none!important}
      .groot-tools{position:absolute;right:26px;top:26px;display:flex;flex-direction:column;align-items:stretch;gap:8px;width:200px;max-height:calc(100% - 220px);overflow-y:auto;pointer-events:auto;scrollbar-width:thin}
      .groot-tools > .groot-mode,.groot-tools > .groot-guide,.groot-tools > .groot-view,.groot-tools > .groot-spellbook,.groot-tools > .groot-world-settings{position:static!important;box-sizing:border-box;width:100%!important;flex-shrink:0}
      .groot-view,.groot-skin-toggle{pointer-events:auto;padding:8px 12px;color:#d8eee5;background:#081b20dd;border:1px solid #78c9b166;border-radius:4px;cursor:pointer}
      .groot-hud .groot-tutorial{top:150px;max-height:calc(100% - 350px);overflow-y:auto}
      @media(max-width:650px){.groot-tools{right:12px;top:140px;width:174px;gap:6px;max-height:calc(100% - 450px)}.groot-hud[data-playing=false] .groot-tools{top:18px}.groot-relics{box-sizing:border-box;max-width:calc(100% - 30px);line-height:1.6}.groot-heading small{letter-spacing:.1em}}
      @media(max-width:650px){.groot-hud .groot-tutorial{top:140px;width:calc(100% - 216px);max-width:300px;max-height:calc(100% - 450px)}}
      @media(max-width:650px){.groot-hud:has(.groot-tutorial:not([hidden])) .groot-world-settings{display:none}}
      @media(max-width:650px){.groot-heading{left:15px;top:20px}.groot-heading strong{font-size:23px}.groot-heading small{font-size:8px}.groot-mode{right:12px;top:18px;padding:8px}.groot-relics{left:15px;top:82px;font-size:9px}.groot-skills{grid-template-columns:repeat(5,1fr)}.groot-controls{bottom:12px}.groot-skill{padding:5px}.groot-help{font-size:10px}.groot-skill kbd{font-size:15px;margin:2px}}
    </style><div class="groot-heading"><strong>GROOT</strong><small>FOREST GUARDIAN · MOONLIT REALM</small></div><button class="groot-mode" type="button">Review poses</button><button class="groot-guide" type="button">Field guide · H</button><div class="groot-controls"><div class="groot-help">W A S D / ↑ ↓ ← → · Move &nbsp; SHIFT · Run &nbsp; 1–0 · Cast &nbsp; P · Pause &nbsp; Drag · Orbit</div><div class="groot-skills"></div><p class="groot-status" role="status" aria-live="polite">Press 0 to summon lantern spirits.</p></div>`;
    const responsive=document.createElement('style');responsive.textContent='@media(max-width:650px){.groot-world-label{font-size:9px!important;letter-spacing:.02em!important}.groot-world-settings{right:12px!important}}';this.hud.appendChild(responsive);
    this.originalPixelRatio=viewer.renderer.getPixelRatio();
    this.quality=new GrootRenderQuality(viewer.scene,effects.skin,effects.river.reflection);
    this.status=this.hud.querySelector('.groot-status')!;this.toggle=this.hud.querySelector('.groot-mode')!;
    this.hud.querySelector('.groot-help')!.textContent='W A S D / ↑ ↓ ← → · Move   SHIFT · Run   SPACE · Jump   1–0 · Cast   P · Pause   Drag · Look   V · View';
    this.worldLabel.className='groot-world-label';this.worldLabel.style.cssText='margin-bottom:10px;color:#9dafab;font:11px system-ui;letter-spacing:.08em;text-shadow:0 1px 5px #000';
    this.worldLabel.textContent='MOONROOT WILDS · R to return to the grove';this.hud.querySelector('.groot-controls')!.prepend(this.worldLabel);
    this.relicLabel.className='groot-relics';this.relicLabel.setAttribute('aria-live','polite');this.hud.appendChild(this.relicLabel);
    this.viewButton.type='button';this.viewButton.className='groot-view';this.viewButton.textContent='Third person · V';this.viewButton.setAttribute('aria-label','Switch first or third person');this.viewButton.setAttribute('aria-pressed','false');
    this.viewButton.addEventListener('click',()=>this.switchView());this.hud.appendChild(this.viewButton);
    this.worldLights=viewer.scene.getObjectByName('monster-tree-lights');if(this.worldLights)this.lightOrigin.copy(this.worldLights.position);
    this.dayNight=new GrootDayNight(viewer.scene,effects);
    this.sound=new GrootSound(viewer.camera,motion.height);effects.sound=this.sound;
    effects.relics.setActive(true);effects.relics.onCollect=(relic,count,complete)=>{
      this.sound.relic(this.actor.position,complete);this.status.textContent=complete?'Ice awakened · Transformation waits for cast recovery. Visit the grove wardrobe to change forms.':`${relic.label} found · ${count} / 3 relics awakened.`;this.updateRelicLabel();
    };this.updateRelicLabel();
    const settings=document.createElement('details');settings.className='groot-world-settings';
    settings.style.cssText='position:absolute;right:26px;top:158px;width:174px;padding:11px 13px;background:#081319df;border:1px solid #7d949c55;border-radius:5px;pointer-events:auto';
    settings.innerHTML='<summary style="cursor:pointer">World lighting</summary><label for="groot-time" style="display:block;margin-top:14px">Day / night <output id="groot-time-label">22:00 · Night</output></label><input id="groot-time" aria-label="Time of day" type="range" min="0" max="24" step="0.25" value="22" style="width:100%;margin-top:10px;accent-color:#a4c6a7"><div style="display:flex;justify-content:space-between;color:#a6b7bc;font-size:10px"><span>Midnight</span><span>Noon</span><span>Midnight</span></div>';
    const time=settings.querySelector('input')!,label=settings.querySelector('output')!;
    settings.querySelector('summary')!.textContent='World & sound';
    const audio=document.createElement('div');audio.style.cssText='margin-top:14px;padding-top:12px;border-top:1px solid #7d949c44';
    audio.innerHTML='<button type="button" class="groot-sound-toggle" aria-label="Mute sound effects" aria-pressed="false" style="width:100%;background:#172d2d;color:#d8e4df;border:1px solid #69848766;border-radius:4px;padding:7px;cursor:pointer">Enable sound · M</button><label for="groot-sfx-volume" style="display:block;margin-top:10px">SFX volume <output></output></label><input id="groot-sfx-volume" aria-label="Sound effects volume" type="range" min="0" max="100" step="1" style="width:100%;accent-color:#a4c6a7"><small class="groot-sound-status" aria-live="polite" style="display:block;color:#a6b7bc;margin-top:4px"></small>';
    const audioToggle=audio.querySelector('button')!,volume=audio.querySelector('input')!,level=audio.querySelector('output')!,audioStatus=audio.querySelector('small')!;
    this.sound.onChange=()=>{
      audioToggle.textContent=this.sound.muted?'Unmute sound · M':this.sound.status==='locked'?'Enable sound · M':'Mute sound · M';audioToggle.setAttribute('aria-pressed',String(this.sound.muted));
      audioToggle.setAttribute('aria-label',this.sound.muted?'Unmute sound effects':'Mute sound effects');
      volume.value=String(Math.round(this.sound.volume*100));level.value=`${volume.value}%`;
      audioStatus.textContent=this.sound.status==='unavailable'?'Audio unavailable; gameplay is unaffected.':this.sound.status==='loading'?'Preparing woodland sounds…':this.sound.status==='locked'?'Sound starts after your first interaction.':'Footsteps and skills · pauses when unfocused';
      audioToggle.disabled=volume.disabled=this.sound.status==='unavailable';
    };
    audioToggle.addEventListener('click',()=>{if(this.sound.status==='locked'||this.sound.status==='loading')this.sound.setMuted(false);else this.sound.setMuted(!this.sound.muted);void this.sound.unlock();});
    volume.addEventListener('input',()=>this.sound.setVolume(Number(volume.value)/100));this.sound.onChange();settings.appendChild(audio);
    const quality=document.createElement('label');quality.htmlFor='groot-render-scale';quality.style.cssText='display:block;margin-top:12px;padding-top:10px;border-top:1px solid #7d949c44';
    quality.innerHTML='Render resolution<select id="groot-render-scale" aria-label="Render resolution" style="display:block;width:100%;margin-top:7px;background:#172d2d;color:#d8e4df;border:1px solid #69848766;padding:6px"><option value="1">Full · 100%</option><option value="0.85">Balanced · 85%</option><option value="0.7">Performance · 70%</option></select><small style="display:block;margin-top:5px;color:#a6b7bc;font-size:10px">Only 70% lowers source mesh, shadows and reflection quality. All lighting and VFX stay enabled.</small><small class="groot-quality-status" aria-live="polite" style="display:block;margin-top:5px;color:#a6b7bc;font-size:10px"></small>';
    settings.appendChild(quality);this.qualityLabel=quality.querySelector('.groot-quality-status');const scale=quality.querySelector('select')!;
    try{const saved=Number(localStorage.getItem('groot:render-scale:v1'));if([1,.85,.7].includes(saved))this.renderScale=saved;}catch{/* Preferences are optional. */}
    // Apply the resolved preference even when storage is absent/blocked: the quality
    // controller starts at full fidelity, independently of the dropdown's default.
    this.quality.setScale(this.renderScale);
    scale.value=String(this.renderScale);viewer.renderer.setPixelRatio(this.originalPixelRatio*this.renderScale);
    scale.addEventListener('change',()=>{this.renderScale=Number(scale.value);viewer.renderer.setPixelRatio(this.originalPixelRatio*this.renderScale);try{localStorage.setItem('groot:render-scale:v1',scale.value);}catch{/* Rendering remains available without storage. */}});
    time.addEventListener('input',()=>{const hour=Number(time.value);this.dayNight.setHour(hour);const hh=Math.floor(hour)%24,mm=Math.round((hour%1)*60);label.textContent=`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')} · ${hour>=6&&hour<18?'Day':'Night'}`;});this.hud.appendChild(settings);
    this.tutorial=new GrootTutorial(this.hud,this.hud.querySelector('.groot-guide')!);
    const book=document.createElement('button');book.type='button';book.className='groot-spellbook';book.textContent='Spellbook 1 / 2 · B';book.addEventListener('click',()=>this.setBank(1-this.bank));this.hud.appendChild(book);
    this.wardrobe=new GrootWardrobe(effects.skin,actor,motion.height,[...effects.forest.colliders,...effects.forest.terrain.colliders.slice(0,effects.forest.terrain.colliderCount)],this.hud,()=>{this.held.clear();this.velocity.set(0,0,0);this.motion.setLocomotion(0,false);this.perspective.cancelLook();},viewer.renderer.domElement);effects.group.add(this.wardrobe.group);
    const skinButton=document.createElement('button');skinButton.type='button';skinButton.className='groot-skin-toggle';skinButton.textContent='Wardrobe near spawn · E';skinButton.setAttribute('aria-label','Find the grove wardrobe');
    effects.skin.onChange=()=>{this.wardrobe.refresh();this.updateRelicLabel();if(!effects.skin.transitioning&&this.status.textContent===FORM_CAST_WAIT)this.status.textContent='Form ready · You can cast again.';};
    skinButton.addEventListener('click',()=>{if(!this.wardrobe.show())this.status.textContent=`Wardrobe · Return near spawn and approach the ringed crystal marker (${Math.ceil(this.actor.position.distanceTo(this.wardrobe.position))} m).`;});
    const tools=document.createElement('div');tools.className='groot-tools';tools.append(this.toggle,this.hud.querySelector('.groot-guide')!,this.viewButton,skinButton,book,settings);this.hud.appendChild(tools);
    this.hud.querySelector('.groot-guide')!.addEventListener('click',()=>this.setBank(0));
    const bar=this.hud.querySelector('.groot-skills')!;
    ALL_SKILLS.forEach(([key,id,label],i)=>{const b=document.createElement('button');b.type='button';b.className='groot-skill';b.dataset.skill=id;b.style.order=String(key==='0'?9:Number(key)-1);b.hidden=i>=10;b.setAttribute('aria-label',`${key}: ${label}`);b.innerHTML=`<kbd>${key}</kbd><span>${label}</span><em></em>`;b.addEventListener('click',()=>this.cast(i));bar.appendChild(b);this.buttons.push(b);this.timers.push(b.querySelector('em')!);});
    viewer.renderer.domElement.parentElement!.appendChild(this.hud);document.body.classList.add('groot-playing');this.hud.dataset.playing='true';viewer.setTurntable(false);
    const clear=()=>{this.held.clear();this.velocity.set(0,0,0);this.motion.setLocomotion(0,false);};
    const down=(event:KeyboardEvent)=>{
      if(!this.enabled||event.ctrlKey||event.metaKey||event.altKey)return;
      if(this.wardrobe.open&&event.code!=='KeyP'){if(event.code==='Escape'){event.preventDefault();this.wardrobe.close();}return;}
      if(editable(event.target))return;
      const move=/^(Key[WASD]|Arrow(Up|Down|Left|Right)|Shift(Left|Right))$/.test(event.code),digit=/^(Digit|Numpad)[0-9]$/.test(event.code);
      if(!move&&!digit&&event.code!=='Escape'&&event.code!=='Space'&&event.code!=='KeyR'&&event.code!=='KeyP'&&event.code!=='KeyH'&&event.code!=='KeyB'&&event.code!=='KeyM'&&event.code!=='KeyV'&&event.code!=='KeyE')return;event.preventDefault();
      if(event.code==='KeyE'&&!event.repeat){if(!this.paused)this.wardrobe.show();return;}
      if(event.code==='KeyV'&&!event.repeat){this.switchView();return;}
      if(event.code==='KeyM'&&!event.repeat){this.sound.setMuted(!this.sound.muted);return;}
      if(event.code==='KeyB'&&!event.repeat){this.setBank(1-this.bank);return;}
      if(event.code==='KeyH'&&!event.repeat){this.setBank(0);this.tutorial.start();return;}
      if(event.code==='KeyP'&&!event.repeat){this.paused=!this.paused;this.wardrobe.update(!this.paused);this.perspective.cancelLook();this.sound.setActive(!this.paused);clear();this.status.textContent=this.paused?'Paused · Press P to resume.':'Journey resumed.';return;}
      if(this.paused)return;if(move)this.held.add(event.code);
      if(event.code==='Escape'&&!event.repeat&&this.motion.cancelV2()){clear();this.status.textContent='Ritual cancelled · Returning to the grove stance.';return;}
      if(event.code==='KeyR'&&!event.repeat){
        clear();this.perspective.cancelLook();this.sound.silence();this.actor.position.set(0,0,0);this.motion.play('grove-idle',true);this.status.textContent='Returned to the moonlit grove.';
        this.effects.companion.recall(this.actor.position,this.actor.rotation.y);
        this.perspective.update();return;
      }
      if(event.code==='Space'&&!event.repeat&&locomotion(this.motion.current.id)){
        this.motion.play('forest-jump');this.sound.jump(this.actor.position);this.castLoop=false;this.status.textContent='Running Jump · Keep moving to steer.';this.tutorial.jump();return;
      }
      if(digit&&!event.repeat){const key=event.code.slice(-1);this.cast(key==='0'?9:this.bank?10+GROOT_EXTRA_KEYS.findIndex(k=>k[0]===key):GROOT_KEYS.findIndex(k=>k[0]===key));}
    };
    const up=(e:KeyboardEvent)=>{this.held.delete(e.code);};
    const visibility=()=>{if(document.hidden)clear();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',clear);document.addEventListener('visibilitychange',visibility);
    this.toggle.addEventListener('click',()=>{this.wardrobe.update(false);if(this.perspective.firstPerson)this.switchView();this.enabled=!this.enabled;this.perspective.setGameplay(this.enabled);this.sound.setActive(this.enabled);this.effects.relics.setActive(this.enabled);this.effects.river.group.visible=this.enabled;this.effects.livingForms.armourPreview=!this.enabled;this.paused=false;clear();this.setStealthed(false);this.motion.play('grove-idle');document.body.classList.toggle('groot-playing',this.enabled);this.hud.dataset.playing=String(this.enabled);this.toggle.textContent=this.enabled?'Review poses':'Enter forest';});
    this.disposeInput=()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',visibility);clear();};
    // After the framing pass / first world tick, compile hidden skill materials too. Stable
    // summon lights mean these programs stay valid when 2/4/9 are used for the first time.
    this.warmupFrame=requestAnimationFrame(()=>{
      if(this.disposed)return;
      // r169's compileAsync polls material properties after a timeout, even if navigation
      // disposes those materials meanwhile. Submit compilation synchronously at startup;
      // there is no detached poll that can touch a disposed scene.
      try{viewer.renderer.compile(viewer.scene,viewer.camera);this.shadersReady=true;}catch{/* Rendering retains its normal fallback path. */}
    });
  }
  private setStealthed(value:boolean):void{
    this.actor.visible=!value&&!this.perspective.firstPerson;
    if(this.stealthed===value)return;
    this.stealthed=value;this.hud.dataset.stealthed=String(value);
    this.status.textContent=value?'Life Seed cover · Concealed until you leave the tall grass.':'Cover left · Groot is visible again.';
  }
  private setBank(bank:number):void{
    this.bank=bank;for(let i=0;i<this.buttons.length;i++)this.buttons[i].hidden=i!==9&&(bank===0?i>=10:i<10);
    this.hud.querySelector('.groot-spellbook')!.textContent=`Spellbook ${bank+1} / 2 · B`;
  }
  private switchView():void{
    if(!this.enabled)return;
    this.perspective.setFirstPerson(!this.perspective.firstPerson);
    this.viewButton.textContent=this.perspective.firstPerson?'First person · V':'Third person · V';
    this.viewButton.setAttribute('aria-pressed',String(this.perspective.firstPerson));
    this.actor.visible=!this.stealthed&&!this.perspective.firstPerson;
    this.status.textContent=this.perspective.firstPerson?'First person · Drag to look, WASD to move, V to see your skin.':'Third person · Drag to orbit freely; move to turn Groot. V for first person.';
  }
  cast(index:number):boolean{
    if(index<0||index>=ALL_SKILLS.length||!this.enabled||this.paused||this.wardrobe.open||this.motion.recovering)return false;
    // Reverse initiation order matters too: do not start a cast whose committed body /
    // socket provider would change before recovery. No aim, equipment or cooldown writes.
    if(this.effects.skin.transitioning){this.status.textContent=FORM_CAST_WAIT;return false;}
    if(this.perspective.firstPerson){this.perspective.forward(this.forward);this.actor.rotation.y=Math.atan2(-this.forward.z,this.forward.x);}
    this.actor.updateMatrixWorld(true);
    if(index===6){
      const forms=this.effects.livingForms;
      // Equipment can be removed during any action; an interrupted transition reverses in place.
      if(forms.armourEnabled||forms.armourProgress>0||this.motion.current.id==='regrowth'){
        forms.setArmour(!forms.armourEnabled);this.sound.armour(forms.armourEnabled,this.actor.position);this.cooldowns[index]=0;
        this.status.textContent=forms.armourEnabled?'Bark Armour · Equipping. Press 7 to remove.':'Bark Armour · Removing. Press 7 to equip.';return true;
      }
    }
    if(index===8&&this.effects.companion.enabled){
      this.effects.companion.dismiss();this.sound.dismiss(this.actor.position);this.cooldowns[index]=0;this.status.textContent='Little Groot dismissed · Press 9 to call him back.';return true;
    }
    if(index===8&&this.motion.current.id==='spore-bloom'){
      // Cancelling and re-enabling the switch during its windup never restarts the body clip.
      if(this.motion.time<this.motion.measures.find(m=>m.id==='spore-bloom')!.events[0].time){this.effects.companion.request();return true;}
    }
    if(this.cooldowns[index]>.001)return false;
    if(!locomotion(this.motion.current.id)){this.status.textContent='Casting · Keep moving to reposition.';return false;}
    const [,id,label]=ALL_SKILLS[index];this.motion.play(id);this.castLoop=this.motion.current.loop;
    if(index===8)this.effects.companion.request();
    if(index===6){this.effects.livingForms.setArmour(true);this.sound.armour(true,this.actor.position);}
    this.tutorial.cast(id,this.velocity.length()>this.motion.height*.012&&this.held.size>0);
    this.cooldowns[index]=index===8||index===6?0:this.motion.current.duration+.5;this.status.textContent=`${label}${isV2(id)?' · Full-body ritual. Esc to cancel.':index===8?' · Press 9 again to dismiss.':index===6?' · Equipping. Press 7 to remove.':id==='spirit-call'?' · Lantern spirits will light the path for 18 seconds.':''}`;return true;
  }
  update(dt:number):void{
    if(this.qualityLabel){const text=this.effects.skin.qualityStatus;if(this.qualityLabel.textContent!==text)this.qualityLabel.textContent=text;}
    this.dayNight.update(dt);
    this.wardrobe.update(this.enabled&&!this.paused);
    if(!this.enabled){this.motion.update(dt);this.effects.skin.update(dt);return;}if(this.paused)return;
    this.perspective.setGameplay(true);
    for(let i=0;i<this.cooldowns.length;i++)this.cooldowns[i]=Math.max(0,this.cooldowns[i]-dt);
    const x=Number(this.held.has('KeyD')||this.held.has('ArrowRight'))-Number(this.held.has('KeyA')||this.held.has('ArrowLeft'));
    const z=Number(this.held.has('KeyW')||this.held.has('ArrowUp'))-Number(this.held.has('KeyS')||this.held.has('ArrowDown'));
    if(this.wardrobe.open){this.held.clear();this.velocity.set(0,0,0);}
    const run=this.held.has('ShiftLeft')||this.held.has('ShiftRight'),casting=!locomotion(this.motion.current.id)||this.motion.recovering,h=this.motion.height;
    this.perspective.forward(this.forward);this.right.crossVectors(this.forward,this.up);
    this.desired.copy(this.forward).multiplyScalar(z).addScaledVector(this.right,x).normalize();
    const jumping=this.motion.current.id==='forest-jump';
    let speed=(run?GROOT_GAIT.run.speed:GROOT_GAIT.walk.speed)*h*(casting&&!jumping?.72:1);
    const fullBody=this.motion.recovering||isV2(this.motion.current.id)||this.motion.current.id==='forest-dance'||this.motion.current.id==='root-charge';
    if(fullBody){speed=0;this.velocity.set(0,0,0);}
    if(this.motion.current.id==='root-stomp'){
      const stop=this.motion.measures.find(m=>m.id==='root-stomp')!.events[0].time;
      if(this.motion.time>stop-.38&&this.motion.time<stop+.28)speed=0;
    }
    this.desired.multiplyScalar(speed);this.velocity.lerp(this.desired,1-Math.exp(-dt*8));if(this.velocity.length()<h*.002)this.velocity.set(0,0,0);
    this.oldPosition.copy(this.actor.position);this.actor.position.addScaledVector(this.velocity,dt);
    const radius=h*GROOT_WORLD_RADIUS_H,planar=Math.hypot(this.actor.position.x,this.actor.position.z);
    if(planar>radius){this.actor.position.x*=radius/planar;this.actor.position.z*=radius/planar;}
    for(const collider of this.effects.forest.colliders){
      const dx=this.actor.position.x-collider.x,dz=this.actor.position.z-collider.z,distance=Math.hypot(dx,dz),limit=collider.radius+h*.12;
      if(distance<limit){const safe=distance||1;this.actor.position.x=collider.x+(distance?dx/safe:1)*limit;this.actor.position.z=collider.z+dz/safe*limit;}
    }
    const world=this.effects.forest.terrain;
    for(let i=0;i<world.colliderCount;i++){
      const collider=world.colliders[i],dx=this.actor.position.x-collider.x,dz=this.actor.position.z-collider.z,distance=Math.hypot(dx,dz),limit=collider.radius+h*.12;
      if(distance<limit){this.actor.position.x=collider.x+(distance?dx/distance:1)*limit;this.actor.position.z=collider.z+(distance?dz/distance:0)*limit;}
    }
    this.actor.position.y=forestGround(this.actor.position.x,this.actor.position.z,h);
    if(this.worldLights)this.worldLights.position.copy(this.lightOrigin).add(this.actor.position);
    const actualSpeed=Math.hypot(this.actor.position.x-this.oldPosition.x,this.actor.position.z-this.oldPosition.z)/Math.max(dt,1e-5),moving=actualSpeed>h*.012;
    // Look owns aim only in first person. Third-person orbit never turns an idle
    // actor (or its skill); movement turns the body independently toward travel.
    if(this.perspective.firstPerson)this.actor.rotation.y=Math.atan2(-this.forward.z,this.forward.x);
    else if(moving&&(x!==0||z!==0)&&!fullBody)this.actor.rotation.y=Math.atan2(-this.velocity.z,this.velocity.x);
    if(!casting){const id=moving?(run?'forest-run':'forest-walk'):'grove-idle';if(this.motion.current.id!==id)this.motion.play(id);}
    this.motion.setLocomotion(moving&&!fullBody&&!jumping?1:0,run,actualSpeed/h);
    this.actor.updateMatrixWorld(true);
    const oldTime=this.motion.time;this.motion.update(dt);
    this.effects.relics.update(dt,this.actor.position,true);
    this.effects.river.update(dt,this.actor.position,!jumping&&this.motion.current.id!=='root-charge');
    this.setStealthed(this.effects.seedCover.contains(this.actor.position));
    if(moving&&(x!==0||z!==0))this.tutorial.travel(actualSpeed*dt/h,run);
    this.tutorial.light(this.effects.forest.atmosphere.remaining);
    if(casting&&this.castLoop&&this.motion.time<oldTime){this.castLoop=false;this.motion.play('grove-idle');}
    this.perspective.update();
    this.uiTime+=dt;
    if(this.uiTime>.10){
      this.uiTime=0;
      const forms=this.effects.livingForms;
      if(this.status.textContent?.startsWith('Bark Armour')){
        if(forms.armourEnabled&&forms.armourProgress===1)this.status.textContent='Bark Armour equipped · Press 7 to remove.';
        else if(!forms.armourEnabled&&forms.armourProgress===0)this.status.textContent='Bark Armour removed · Press 7 to equip.';
      }
      this.updateRelicLabel();
      for(let i=0;i<ALL_SKILLS.length;i++){
        const cd=this.cooldowns[i],baby=i===8&&this.effects.companion.enabled,armour=i===6&&this.effects.livingForms.armourEnabled;
        this.buttons[i].dataset.active=String(baby||armour||this.motion.current.id===ALL_SKILLS[i][1]);
        this.buttons[i].style.setProperty('--ready',String(cd>0?.7:0));
        if(i===8)this.buttons[i].setAttribute('aria-pressed',String(baby));
        if(i===6)this.buttons[i].setAttribute('aria-pressed',String(armour));
        this.timers[i].textContent=i===6?(armour?(this.effects.livingForms.armourProgress<1?'EQUIPPING':'ON · Remove'):this.effects.livingForms.armourProgress>0?'REMOVING':'OFF · Equip'):i===8?(baby?(this.effects.companion.pending?'FORMING':'ON · Toggle off'):'OFF · Toggle on')
          :cd>0?`${cd.toFixed(1)}s`:ALL_SKILLS[i][0]==='0'&&this.effects.forest.atmosphere.remaining>0?`${Math.ceil(this.effects.forest.atmosphere.remaining)}s lit`:'';
      }
    }
  }
  private updateRelicLabel():void{
    const relics=this.effects.relics,count=relics.collectedCount;this.relicLabel.dataset.mask=String(relics.skin.mask);
    this.hud.dataset.elder=String(relics.skin.complete);
    if(relics.skin.complete){this.relicLabel.innerHTML='<strong>ICE AWAKENED</strong> · 3 / 3 · WARDROBE NEAR SPAWN';return;}
    const distance=relics.nearestDistance(this.actor.position),pips='●'.repeat(count)+'○'.repeat(3-count);
    this.relicLabel.innerHTML=`<strong>${count?'ELDER MOONROOT '+count+'/3':'WILDS RELICS'}</strong> · ${pips} · nearest echo ${Number.isFinite(distance)?Math.max(1,Math.round(distance)):'—'} m`;
  }
  dispose():void{this.quality.dispose();this.disposed=true;this.wardrobe.dispose();cancelAnimationFrame(this.warmupFrame);this.perspective.dispose();this.effects.river.dispose();this.effects.skin.dispose();this.effects.themes.dispose();for(const ground of this.studioGround)ground.mesh.visible=ground.visible;this.viewer.renderer.setPixelRatio(this.originalPixelRatio);this.setStealthed(false);this.effects.relics.onCollect=undefined;this.effects.relics.setActive(false);this.disposeInput();this.sound.dispose();this.dayNight.dispose();if(this.effects.sound===this.sound)this.effects.sound=undefined;if(this.worldLights)this.worldLights.position.copy(this.lightOrigin);this.tutorial.dispose();this.hud.remove();document.body.classList.remove('groot-playing');}
}
