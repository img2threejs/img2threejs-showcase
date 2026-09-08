import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]??'.img2threejs/groot-streaming/t18-ownership-test');if(existsSync(out))throw Error('New output required');mkdirSync(out,{recursive:true});
const driver=join(homedir(),'cloakbrowser-e2e/node_modules/cloakbrowser'),pkg=JSON.parse(readFileSync(join(driver,'package.json'),'utf8'));
const {launch}=await import(pathToFileURL(join(driver,pkg.exports?.['.']?.import??pkg.main)).href),browser=await launch({headless:true,args:['--fingerprint=8731']}),errors=[],moduleURLs=[];let p;
try{
 p=await browser.newPage({viewport:{width:1000,height:800}});p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/Shader Error|VALIDATE_STATUS/.test(m.text()))errors.push(m.text());});
 // Workbench deliberately has no public viewer diagnostic. Observe its REAL Viewer
 // mounts, without replacing ticking, preparation, disposal or creating a test controller.
 await p.addInitScript(()=>{
  localStorage.setItem('groot:forest-ftue:v1','done');localStorage.setItem('groot:render-scale:v1','0.7');
  window.ownershipViewers=[];
 });
 // Instrument the exact module instance used by the app, including Vite's ?t= URLs.
 // Importing a bare /src/scene.ts can patch a DIFFERENT Viewer constructor.
 await p.route('**/src/scene.ts*',async route=>{moduleURLs.push(route.request().url());const response=await route.fetch();const body=await response.text();await route.fulfill({response,body:body+'\nconst ownershipRefresh=Viewer.prototype.refreshTickers;Viewer.prototype.refreshTickers=function(...args){if(!window.ownershipViewers.includes(this))window.ownershipViewers.push(this);return ownershipRefresh.apply(this,args);};\n'});});
 await p.goto('http://127.0.0.1:5347/#/x/monster-tree',{waitUntil:'domcontentloaded',timeout:120000});
 const boot=async count=>p.waitForFunction(count=>window.ownershipViewers?.length>=count&&window.ownershipViewers.at(-1)?.scene.getObjectByName('monster-tree')?.userData.sculptRuntime?.diagnostics.vfx.forest.terrain.stream.stats.pumps>0,count,{timeout:30000});
 await boot(1);
 await p.evaluate(async()=>{
  window.T=await import('/node_modules/.vite/deps/three.js');window.records=[];
  window.armOwnership=label=>{
   const viewer=ownershipViewers.at(-1),root=viewer.scene.getObjectByName('monster-tree'),g=root.userData.sculptRuntime.diagnostics,terrain=g.vfx.forest.terrain,stream=terrain.stream,chunks=terrain.chunks,river=g.vfx.river;
   cancelAnimationFrame(viewer.rafHandle);
   const instances=new Map(),geometries=new Map(),materials=new Map(),textures=new Map();
   const watch=(map,object)=>{if(!object||map.has(object))return;map.set(object,0);object.addEventListener('dispose',()=>map.set(object,map.get(object)+1));};
   const watchMaterial=m=>{watch(materials,m);for(const value of Object.values(m))if(value?.isTexture)watch(textures,value);};
   const watchMesh=m=>{watch(geometries,m.geometry);for(const material of Array.isArray(m.material)?m.material:[m.material])watchMaterial(material);if(m.isInstancedMesh)watch(instances,m);};
   for(const key of ['trunk','grass','leaf','stoneGeometry'])watch(geometries,chunks[key]);
   for(const key of ['bark','foliage','grassMaterial','litterMaterial','stoneMaterial'])watchMaterial(chunks[key]);
   for(const sources of chunks.authored.values())for(const source of sources)watchMesh(source);
   terrain.group.traverse(o=>{if(o.isMesh)watchMesh(o);});river.group.traverse(o=>{if(o.geometry)watchMesh(o);});watchMesh(river.surface);watchMesh(river.reflection.reflector);
   // Relocation replaces the queued target; select its first ground-ready slot and
   // suspend the REAL vegetation generator at its first yield in that same slot.
   g.actor.position.set(40*g.runner.height,0,30*g.runner.height);root.userData.prepareRender();
   const slot=[...stream.slots.values()].find(s=>s.ground&&!s.vegetation&&!s.job);if(!slot)throw Error('No slot for suspended generator fixture');
   terrain.group.traverse(o=>{if(o.isMesh)watchMesh(o);});river.group.traverse(o=>{if(o.geometry)watchMesh(o);});
   const instancePrototype=[...chunks.authored.values()].flat().find(o=>o.isInstancedMesh).constructor.prototype;
   const setMatrix=instancePrototype.setMatrixAt;instancePrototype.setMatrixAt=function(...args){watch(instances,this);return setMatrix.apply(this,args);};
   let finallyCalls=0;
   try{const original=chunks.vegetation(slot.cx,slot.cz,slot.near);slot.job=(function*(){try{return yield* original;}finally{finallyCalls++;}})();if(slot.job.next().done)throw Error('Expected suspended construction');}finally{instancePrototype.setMatrixAt=setMatrix;}
   const partialInstances=[...instances.keys()].filter(m=>!m.parent?.parent&&m.parent?.name.startsWith('world-vegetation-cell:'));
   const record={label,viewer,root,g,stream,chunks,river,instances,geometries,materials,textures,partialInstances,finallyCalls:()=>finallyCalls,prepare:root.userData.prepareRender,tick:root.userData.tick,dispose:root.userData.dispose,hadHUD:!!g.game,queued:stream.stats.queue>0,slotsBefore:stream.slots.size};records.push(record);
   return {label,hadHUD:record.hadHUD,queued:record.queued,slots:record.slotsBefore,partialInstances:partialInstances.length};
  };
  window.inspectOwnership=index=>{
   const r=records[index],before={pumps:r.stream.stats.pumps,time:r.g.runner.time,generated:r.stream.stats.generatedVegetation};
   r.prepare();r.tick(.1);r.dispose();r.dispose();r.stream.pump(r.g.actor.position);
   const counts=map=>({objects:map.size,bad:[...map].filter(([,n])=>n!==1).map(([o,n])=>({name:o.name,type:o.type,count:n}))});
   return {label:r.label,hadHUD:r.hadHUD,queued:r.queued,slotsBefore:r.slotsBefore,stopped:r.stream.stats.pumps===before.pumps&&r.g.runner.time===before.time&&r.stream.stats.generatedVegetation===before.generated,slots:r.stream.slots.size,queue:r.stream.stats.queue,finallyCalls:r.finallyCalls(),partialInstances:r.partialInstances.length,partialReleased:r.partialInstances.every(m=>r.instances.get(m)===1),templates:r.chunks.authored.size,detached:!r.river.group.parent,instances:counts(r.instances),geometries:counts(r.geometries),materials:counts(r.materials),textures:counts(r.textures)};
  };
 });
 const setups=[await p.evaluate(()=>armOwnership('workbench queued -> game route'))];
 await p.evaluate(()=>{location.hash='#/demo/monster-tree';});await boot(2);
 const rows=[await p.evaluate(()=>inspectOwnership(0))];
 setups.push(await p.evaluate(()=>armOwnership('game disposed directly -> workbench route')));
 // Exercise the existing game cleanup BEFORE model teardown: shared source owners
 // must tolerate this order, and the subsequent generic sweep must not repeat them.
 await p.evaluate(()=>records[1].g.game.dispose());
 await p.evaluate(()=>{location.hash='#/x/monster-tree';});await boot(3);
 rows.push(await p.evaluate(()=>inspectOwnership(1)));
 const remount=await p.evaluate(()=>{const current=ownershipViewers.at(-1).scene.getObjectByName('monster-tree').userData.sculptRuntime.diagnostics;return !current.game&&current.vfx.forest.terrain.stream!==records[0].stream&&current.vfx.forest.terrain.stream.stats.pumps>0&&current.vfx.forest.terrain.stream.slots.size>0;});
 setups.push(await p.evaluate(()=>armOwnership('remounted workbench model dispose -> generic sweep')));
 await p.evaluate(()=>{const r=records[2];r.dispose();r.dispose();r.viewer.dispose();});
 rows.push(await p.evaluate(()=>inspectOwnership(2)));
 const checks=rows.map(row=>({name:row.label,pass:row.queued&&row.stopped&&row.slots===0&&row.queue===0&&row.finallyCalls===1&&row.partialInstances>0&&row.partialReleased&&row.templates===0&&row.detached&&['instances','geometries','materials','textures'].every(key=>row[key].objects>0&&row[key].bad.length===0),detail:row}));
 checks.push({name:'Fresh real workbench remount resumes its own bounded stream without game HUD',pass:remount&&setups[0].hadHUD===false&&setups[1].hadHUD===true&&setups[2].hadHUD===false});
 const cold=await p.evaluate(async()=>{
  const {Viewer}=await import('/src/scene.ts'),mod=await import('/src/demos/monster-tree/createMonsterTreeModel.ts?ownership-cold');
  const host=document.createElement('div');host.style.cssText='width:320px;height:240px';document.body.appendChild(host);
  const viewer=new Viewer(host),model=mod.createMonsterTreeModel(),emptyBefore=model.children.length===0&&!model.userData.sculptRuntime;
  viewer.scene.add(model);viewer.refreshTickers();viewer.dispose();model.userData.dispose();await mod.prewarmMonsterTree();await new Promise(requestAnimationFrame);model.userData.dispose();
  const stayedEmpty=model.children.length===0&&!model.userData.sculptRuntime&&!model.userData.prepareRender;host.remove();return {emptyBefore,stayedEmpty};
 });
 checks.push({name:'Empty preview disposed before source prewarm completion never populates or starts jobs',pass:cold.emptyBefore&&cold.stayedEmpty,detail:cold});
 const report={pass:checks.every(c=>c.pass)&&!errors.length,checks,setups,moduleURLs,errors};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}catch(error){const boot=await p?.evaluate(()=>({url:location.href,title:document.title,canvases:document.querySelectorAll('canvas').length,viewers:window.ownershipViewers?.map(v=>({roots:v.scene.children.map(o=>o.name),pumps:v.scene.getObjectByName('monster-tree')?.userData.sculptRuntime?.diagnostics.vfx.forest.terrain.stream.stats.pumps}))})).catch(()=>null);writeFileSync(join(out,'failure.json'),JSON.stringify({failure:String(error),errors,moduleURLs,boot},null,2));throw error;}finally{await browser.close();}
