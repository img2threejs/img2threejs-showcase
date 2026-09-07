import * as THREE from 'three';
import { forestGround } from './grootTerrain';
import { inRiverH } from './grootRiverPath';
import type { GrootSkin, GrootOutfit } from './grootSkin';

/** Modest world landmark, not three animated mannequins. No remote/global outfit switch. */
export class GrootWardrobe {
 readonly group=new THREE.Group();
 readonly position=new THREE.Vector3();
 readonly panel=document.createElement('div');
 readonly prompt=document.createElement('button');
 open=false;inRange=false;
 private returnFocus:HTMLElement|null=null;
 private allowed=true;
 private readonly buttons=new Map<GrootOutfit,HTMLButtonElement>();
 private readonly clearInput:()=>void;
 constructor(private readonly skin:GrootSkin,private readonly actor:THREE.Object3D,private readonly height:number,colliders:readonly {x:number;z:number;radius:number}[],hud:HTMLElement,clearInput:()=>void,private readonly canvas:HTMLCanvasElement){
  this.clearInput=clearInput;
  const safe=(x:number,z:number)=>!inRiverH(x/height,z/height,.5)&&colliders.every(c=>Math.hypot(x-c.x,z-c.z)>c.radius+.45*height);
  let found=false;
  for(let i=0;i<120&&!found;i++){
   const a=.4+i*2.39996,r=(2.0+Math.floor(i/24)*.22)*height,x=Math.cos(a)*r,z=Math.sin(a)*r;
   // Validate a direct walking corridor from spawn as well as the marker's own footprint.
   if(!safe(x,z))continue;
   if(!Array.from({length:12},(_,j)=>(j+1)/12).every(t=>safe(x*t,z*t)))continue;
   this.position.set(x,forestGround(x,z,height),z);found=true;
  }
  if(!found)throw new Error('No dry reachable wardrobe site near spawn');
  this.group.name='groot-world-wardrobe';this.group.position.copy(this.position);
  const stone=new THREE.MeshStandardMaterial({color:'#466364',roughness:.88});
  const crystal=new THREE.MeshStandardMaterial({color:'#9de9e3',emissive:'#327d90',emissiveIntensity:.55,roughness:.3,metalness:.12});
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.22*height,.27*height,.1*height,8),stone);base.position.y=.05*height;
  const post=new THREE.Mesh(new THREE.CylinderGeometry(.055*height,.075*height,.58*height,6),stone);post.position.y=.38*height;
  const crest=new THREE.Mesh(new THREE.OctahedronGeometry(.14*height),crystal);crest.position.y=.76*height;
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.22*height,.013*height,5,24),crystal);ring.position.y=.73*height;
  this.group.add(base,post,crest,ring);this.group.scale.setScalar(.7);this.group.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});
  const style=document.createElement('style');style.textContent=`
   .groot-wardrobe-prompt{position:absolute;left:50%;top:60%;transform:translateX(-50%);pointer-events:auto;padding:12px 18px;color:#e1ffff;background:#102d36ed;border:1px solid #9fdbdf;border-radius:5px;cursor:pointer}
   .groot-wardrobe-panel{position:absolute;inset:0;background:#06131cc9;pointer-events:auto;display:grid;place-items:center;z-index:40}
   .groot-wardrobe-panel[hidden],.groot-wardrobe-prompt[hidden]{display:none}
   .groot-wardrobe-card{box-sizing:border-box;width:min(460px,calc(100% - 28px));max-height:90%;overflow:auto;padding:24px;background:#112932;border:1px solid #7dbbbf;border-radius:8px}
   .groot-wardrobe-card h2{font:25px Georgia;margin:0 0 12px}.groot-wardrobe-choices{display:grid;gap:10px;margin:18px 0}
   .groot-wardrobe-card button{padding:14px;text-align:left;color:#e6ffff;background:#1e3b45;border:1px solid #74949e;border-radius:4px;cursor:pointer}.groot-wardrobe-card button:focus-visible{outline:2px solid #fff}.groot-wardrobe-card button:disabled{opacity:.5;cursor:not-allowed}.groot-wardrobe-card button[aria-pressed=true]{border-color:#bdfff0}
  `;hud.appendChild(style);
  this.prompt.className='groot-wardrobe-prompt';this.prompt.type='button';this.prompt.textContent='Wardrobe · E';this.prompt.hidden=true;this.prompt.onclick=()=>this.show();
  this.panel.className='groot-wardrobe-panel';this.panel.hidden=true;this.panel.setAttribute('role','dialog');this.panel.setAttribute('aria-modal','true');this.panel.setAttribute('aria-labelledby','groot-wardrobe-title');
  this.panel.innerHTML='<section class="groot-wardrobe-card"><h2 id="groot-wardrobe-title">Grove wardrobe</h2><p>One guardian, three forms. Relic progress is kept.</p><div class="groot-wardrobe-choices"></div><p class="groot-wardrobe-state" role="status" aria-live="polite"></p><button type="button" class="groot-wardrobe-close">Close · Escape</button></section>';
  for(const id of ['original','abies','ice'] as const){const b=document.createElement('button');b.type='button';b.dataset.outfit=id;b.onclick=()=>{this.skin.request(id);this.refresh();};this.buttons.set(id,b);this.panel.querySelector('.groot-wardrobe-choices')!.appendChild(b);}
  this.panel.querySelector<HTMLButtonElement>('.groot-wardrobe-close')!.onclick=()=>this.close();
  this.panel.addEventListener('keydown',e=>{
   if(e.code==='Escape'){e.preventDefault();e.stopPropagation();this.close();}
   if(e.code==='Tab'){
    const buttons=Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),i=buttons.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();buttons[(i+(e.shiftKey?-1:1)+buttons.length)%buttons.length].focus();
   }
  });hud.append(this.prompt,this.panel);this.refresh();
 }
 show():boolean{this.update(this.allowed);if(!this.allowed||!this.inRange)return false;this.returnFocus=document.activeElement as HTMLElement;this.open=true;this.panel.hidden=false;this.prompt.hidden=true;this.clearInput();this.refresh();this.buttons.get(this.skin.requested)?.focus();return true;}
 close():void{
  if(!this.open)return;this.open=false;this.panel.hidden=true;this.clearInput();
  // A pointer opener is hidden while the dialog owns input. Restore its layout BEFORE
  // focus(); focusing a display:none button silently leaves focus in the hidden dialog/BODY.
  this.prompt.hidden=!this.allowed||!this.inRange;
  const opener=this.returnFocus;
  const usable=this.allowed&&this.inRange&&opener?.isConnected&&opener!==document.body&&!opener.closest('[hidden]')&&!opener.matches(':disabled')&&opener.getClientRects().length>0&&getComputedStyle(opener).visibility!=='hidden';
  const focus=usable?opener:this.canvas;if(!focus.hasAttribute('tabindex'))focus.tabIndex=0;focus.focus({preventScroll:true});this.returnFocus=null;
 }
 update(allowed:boolean):void{this.allowed=allowed;this.group.visible=allowed;this.inRange=Math.hypot(this.actor.position.x-this.position.x,this.actor.position.z-this.position.z)<.95*this.height;if(!allowed||!this.inRange)this.close();this.prompt.hidden=!allowed||!this.inRange||this.open;if(this.open)this.refresh();}
 refresh():void{
  const s=this.skin.inspect();
  for(const [id,b] of this.buttons){const locked=id==='ice'&&!s.complete,selected=s.committed===id,requested=s.requested===id;const label=id==='original'?'Original':id==='abies'?'Bloom Groot':'Ice';b.disabled=locked;b.dataset.state=locked?'locked':requested&&s.error?'error':requested&&!s.ready[id]?'loading':selected?'selected':requested?'queued':'available';b.setAttribute('aria-pressed',String(selected));b.textContent=`${label} · ${locked?'Locked · Find 3 unique relics':requested&&s.error?'Load failed · Retry':requested&&!s.ready[id]?'Loading…':selected?'Selected':requested?'Requested':'Choose'}`;}
  this.panel.querySelector('.groot-wardrobe-state')!.textContent=s.error?'Source unavailable. Your current form and unlock are safe. Choose again to retry.':s.pair?'Transforming gradually…':s.queued?'Selection waits for the source and completed cast recovery.':s.complete?'Ice unlocked · All three relics found.':'Ice awakens after three unique relics.';
 }
 dispose():void{this.allowed=false;this.close();this.group.removeFromParent();const materials=new Set<THREE.Material>();this.group.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);}});for(const m of materials)m.dispose();this.panel.remove();this.prompt.remove();}
}
