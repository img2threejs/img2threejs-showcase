// Browser-independent scheduler regression and frozen full-frame instrumentation audit.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import * as T from 'three';
const out=resolve(process.argv[2]??'.img2threejs/groot-streaming/t19/counter-test');
if(existsSync(out))throw Error('New output required');mkdirSync(out,{recursive:true});
const source=readFileSync('src/demos/monster-tree/grootStreaming.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace("from 'three'",`from '${pathToFileURL(resolve('node_modules/three/build/three.module.js')).href}'`);
const {GrootStreaming}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const checks=[];const check=(name,fn)=>{fn();checks.push({name,pass:true});};
let disposed=0;const group=new T.Group();
const part=()=>{const child=new T.Group();group.add(child);return{group:child,bytes:64,dispose(){disposed++;child.removeFromParent();}};};
const s=new GrootStreaming(group,1,{ground:part,*vegetation(){yield;return part();}}),p=new T.Vector3();
const settle=()=>{for(let i=0;i<2000;i++){s.pump(p);if(s.stats.queue===0&&s.canExpose(p)&&s.radius.value===({70:8,85:12,100:18}[s.tier]))return;}throw Error('Did not settle');};
check('Cold false readiness invalidated as slots become ready',()=>{assert.equal(s.canExpose(p),false);settle();assert.equal(s.canExpose(p),true);});
check('Steady pumps allocate no envelope/queue plan and reuse exact readiness',()=>{s.canExpose(p);const before={...s.stats};for(let i=0;i<100;i++){s.pump(p,new T.Color('#abcdef'));assert(s.canExpose(p));}assert.equal(s.stats.pumps-before.pumps,100);assert.equal(s.stats.steadySkips-before.steadySkips,100);assert.equal(s.stats.planningScans,before.planningScans);assert.equal(s.stats.envelopeRebuilds,before.envelopeRebuilds);assert.equal(s.stats.readyScans,before.readyScans);assert.equal(s.stats.generatedGround,before.generatedGround);assert.equal(s.stats.generatedVegetation,before.generatedVegetation);assert.equal(s.colour.value.getHexString(),'abcdef');});
check('Subcell movement keeps exact anchor and invalidates stationary planning, not identities',()=>{const entries=[...s.slots],before={...s.stats};p.x=.001;s.pump(p);assert.equal(s.anchor.value.x,.001);assert.equal(s.stats.envelopeRebuilds,before.envelopeRebuilds);assert(s.stats.planningScans>before.planningScans);assert.deepEqual([...s.slots].map(([k,v])=>[k,v.ground,v.vegetation]),entries.map(([k,v])=>[k,v.ground,v.vegetation]));});
check('Crossing preserves overlapping buffers; retirement cancels cached exposure',()=>{settle();const before=new Map([...s.slots].map(([k,slot])=>[k,{slot,ground:slot.ground,vegetation:slot.vegetation}]));p.x=3.05;settle();for(const [k,row] of before)if(s.slots.has(k)){assert.equal(s.slots.get(k),row.slot);assert.equal(row.slot.ground,row.ground);if(row.vegetation)assert.equal(row.slot.vegetation,row.vegetation);}assert(s.slots.size<=81);p.set(90,0,-90);assert.equal(s.canExpose(p),false);settle();assert(s.canExpose(p));assert.equal(s.canExpose(new T.Vector3()),false);});
check('Rapid tier changes and negative boundaries retain caps and full requested readiness',()=>{for(const scale of [1,.85,.7,.85,1,.7]){s.setScale(scale);p.x-=3.01;s.pump(p);assert(s.slots.size<=({'.7':81,'.85':169,'1':289}[String(scale)]??(scale===.7?81:169)));settle();assert.equal(s.radius.value,scale===1?18:scale===.85?12:8);assert.equal(s.groundRadius.value,s.radius.value+3);assert(s.canExpose(p));}});
check('Same-frame high -> low -> high restores requested radius even with unchanged envelope',()=>{s.setScale(1);settle();s.setScale(.7);s.setScale(1);assert.equal(s.radius.value,8);s.pump(p);assert.equal(s.radius.value,18);assert(s.canExpose(p));});
check('Dispose invalidates cached true readiness and remains idempotent',()=>{assert(s.canExpose(p));s.dispose();const n=disposed;s.dispose();s.pump(p);assert.equal(disposed,n);assert.equal(s.slots.size,0);assert.equal(s.canExpose(p),false);});
const artifacts=process.argv.slice(3);const audits=[];
for(const path of artifacts){const report=JSON.parse(readFileSync(path,'utf8'));assert.equal(report.settings.protocol,'T19-v1');assert.equal(report.device.tickers,1);assert.deepEqual(report.errors,[]);
 for(const row of report.rows){assert.equal(row.raw.length,180);assert.deepEqual(row.raw.map(x=>x.index),Array.from({length:180},(_,i)=>i));for(const f of row.raw){assert(f.fullCPU>=0);assert(f.fullCPU+.31>=f.updateMs+f.prepareMs+f.renderMs,'full CPU must contain ALL submetrics');}if(report.device.streaming){assert.equal(row.readiness.stream.queue,0);assert.equal(row.readiness.stream.radiusH,row.scale===1?18:row.scale===.85?12:8);assert(row.raw.every(f=>f.chunks<=(row.scale===1?289:row.scale===.85?169:81)));}if(row.action){assert.equal(row.raw[0].castOK,true);assert.equal(row.raw[0].action,row.action==='B1'?'root-spear':'forest-roar');}if(row.scenario.includes('crossing'))assert.equal(row.crossingWindowCPU.n,15);}
 audits.push({path,rows:report.rows.length,pass:true});
}
writeFileSync(join(out,'report.json'),JSON.stringify({checks,audits,stats:s.inspect()},null,2));console.log(JSON.stringify({checks:checks.length,audited:audits.length,pass:true}));
