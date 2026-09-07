import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]??'.img2threejs/groot-streaming/t18-functional');if(existsSync(out))throw Error('New output required');mkdirSync(out,{recursive:true});
const driver=join(homedir(),'cloakbrowser-e2e/node_modules/cloakbrowser'),pkg=JSON.parse(readFileSync(join(driver,'package.json'),'utf8'));
const {launch}=await import(pathToFileURL(join(driver,pkg.exports?.['.']?.import??pkg.main)).href),browser=await launch({headless:true,args:['--fingerprint=8731']}),errors=[];
try{
 const p=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await p.addInitScript(()=>{localStorage.setItem('groot:forest-ftue:v1','done');localStorage.setItem('groot:render-scale:v1','0.7');});
 await p.goto('http://127.0.0.1:5347/#/demo/monster-tree',{waitUntil:'domcontentloaded',timeout:120000});
 await p.waitForFunction(()=>window.__IMG2THREEJS_VIEWER__?.scene.getObjectByName('monster-tree')?.userData.sculptRuntime?.diagnostics.game&&!document.querySelector('.ldr'),null,{timeout:180000});
 await p.waitForFunction(()=>document.querySelector('.groot-local-readiness')?.dataset.ready==='true',null,{timeout:180000});
 const initial=await p.evaluate(()=>{const v=window.__IMG2THREEJS_VIEWER__,g=v.scene.getObjectByName('monster-tree').userData.sculptRuntime.diagnostics;return {stream:g.vfx.forest.terrain.stream.inspect(),draws:v.renderer.info.render.calls,triangles:v.renderer.info.render.triangles};});
 await p.screenshot({path:join(out,'70-window.png')});
 const result=await p.evaluate(async()=>{
  const T=await import('/node_modules/.vite/deps/three.js'),{cellIntersects}=await import('/src/demos/monster-tree/grootStreaming.ts'),{forestHeightH}=await import('/src/demos/monster-tree/grootWorld.ts');
  const v=window.__IMG2THREEJS_VIEWER__,root=v.scene.getObjectByName('monster-tree'),g=root.userData.sculptRuntime.diagnostics,terrain=g.vfx.forest.terrain,s=terrain.stream,h=g.runner.height,checks=[];
  const check=(name,pass,detail)=>checks.push({name,pass,detail}),frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
  root.userData.tick=()=>{};v.refreshTickers();g.game.sound.setMuted(true);g.runner.play('grove-idle',true);g.actor.position.set(0,0,0);
  const settle=async()=>{await frames(1);for(let i=0;i<900;i++){if(s.stats.queue===0&&s.canExpose(g.actor.position))return i;await frames(1);}throw Error('Stream did not settle '+JSON.stringify(s.inspect()));};
  await settle();
  const submitted=[],direct=v.renderer.renderBufferDirect.bind(v.renderer),savedCamera=v.camera.position.clone(),savedQuaternion=v.camera.quaternion.clone(),pumpBefore=s.stats.pumps;
  v.renderer.renderBufferDirect=(camera,scene,geometry,material,object,group)=>{
   let forest=false,atmosphere=false,river=false,key=null;
   for(let o=object;o;o=o.parent){forest||=o===g.vfx.forest.group;atmosphere||=o===g.vfx.forest.atmosphere.group;river||=o===g.vfx.river.group;const match=/^(?:world-(?:ground|vegetation)|river|water)-cell:(-?\d+):(-?\d+)$/.exec(o.name);if(match)key=match[1]+':'+match[2];}
   const owners=object.userData.streamSpans?.map(span=>span.key)??(key?[key]:[]);
   if(object.isMesh&&((forest&&!atmosphere)||river||object.name==='moonshaft'))submitted.push({name:object.name,key,owners,owned:owners.length>0&&owners.every(key=>s.slots.has(key)),triangles:(geometry.index?.count??geometry.attributes.position.count)/3*(object.isInstancedMesh?object.count:1)});
   return direct(camera,scene,geometry,material,object,group);
  };
  try{v.camera.position.set(2.5*h,1.5*h,2.5*h);v.camera.lookAt(0,h,0);v.scene.updateMatrixWorld(true);g.vfx.river.reflection.invalidate();v.renderer.render(v.scene,v.camera);}finally{v.renderer.renderBufferDirect=direct;v.camera.position.copy(savedCamera);v.camera.quaternion.copy(savedQuaternion);}
  check('Actual main/shadow/reflection scenery submissions all have resident slot ownership, including moonshafts',submitted.length>0&&submitted.every(row=>row.owned)&&submitted.some(row=>row.name==='moonshaft')&&s.stats.pumps===pumpBefore,{calls:submitted.length,triangles:submitted.reduce((n,row)=>n+row.triangles,0),moonshaftCalls:submitted.filter(row=>row.name==='moonshaft').length,unowned:submitted.filter(row=>!row.owned)});
  check('Exact AABB circle: tangent, corner exclusion, negative coordinates and deformation padding',cellIntersects(0,0,4,1,1)&&!cellIntersects(0,0,4,4,1)&&cellIntersects(-1,-1,-4,-1,1)&&cellIntersects(0,0,6,1,.1,3));
  const snapshot=()=>new Map([...s.slots].map(([k,c])=>[k,{ground:c.ground?.sourceGeometry?.uuid,meshes:[...(c.vegetation?.sourceMeshes??[]),...(c.vegetation?.group.children.filter(m=>m.isInstancedMesh)??[])].map(m=>({name:m.name,uuid:m.uuid,version:m.instanceMatrix.version,colour:m.instanceColor?.version,matrix:Array.from(m.instanceMatrix.array),count:m.count}))}]));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),before=snapshot(),gen=s.stats.generatedVegetation,bytes=s.stats.uploadedBytes,pumps=s.stats.pumps;
  await frames(15);
  check('One pump per actual frame; no unchanged CPU buffers marked uploaded',s.stats.pumps-pumps===15&&s.stats.generatedVegetation===gen&&s.stats.uploadedBytes===bytes&&same([...before],[...snapshot()]),{delta:s.stats.pumps-pumps});
  g.actor.position.x=.2*h;await frames(2);check('Movement inside a cell never repacks overlap',same([...before],[...snapshot()]));
  g.actor.position.x=3.05*h;await settle();const after=snapshot();let stable=true,overlap=0;
  for(const [key,row] of before){const a=after.get(key);if(a){overlap++;stable&&=row.ground===a.ground&&(row.meshes??[]).every(m=>{const n=a.meshes?.find(n=>n.uuid===m.uuid);return n&&(same(m,n)||(m.name==='world-layered-canopy'&&m.count===40&&n.count===120&&n.version===m.version+1));});}}
  check('Boundary crossing retains exact overlapping buffer identities/versions',stable&&overlap>=60,{overlap});
  for(let i=0;i<8;i++){g.actor.position.x=(i%2?3.01:2.99)*h;await frames(1);}await settle();
  check('Boundary oscillation remains within cap and finite latest queue',s.slots.size===81&&s.stats.peakQueue<=81,s.inspect());
  const matrixAtOrigin=before.get('1:1')?.meshes;
  g.actor.position.set(40*h,0,40*h);await frames(1);check('Teleport reclaims stale identities before building destination',s.slots.size===81&&[...s.slots.values()].every(c=>Math.abs(c.cx-13)<=4&&Math.abs(c.cz-13)<=4)&&document.querySelector('.groot-local-readiness').dataset.ready==='false');
  await settle();g.actor.position.set(0,0,0);await settle();
  const reentry=snapshot().get('1:1')?.meshes;check('Reentry regenerates identical transforms/counts, not rerolled scenery',same(matrixAtOrigin?.map(({name,matrix,count})=>({name,matrix,count})),reentry?.map(({name,matrix,count})=>({name,matrix,count}))));
  const tierStats=[];
  for(const scale of [.85,1,.7,1,.85,.7]){
   const old=s.radius.value;g.game.paused=true;const time=g.runner.time,riverTime=g.vfx.river.clock.value;g.game.renderScale=scale;
   await frames(1);if(scale*100>old)check('Expansion retains previous valid radius until ready '+scale,s.radius.value===old||s.canExpose(g.actor.position));
   await settle();tierStats.push(s.inspect());
   check('Paused tier ready without simulation clock changes '+scale,g.runner.time===time&&g.vfx.river.clock.value===riverTime&&s.slots.size<=({'.7':81,'.85':169,'1':289}[String(scale)]??(scale===.7?81:169))&&s.radius.value===(scale===.7?8:scale===.85?12:18));
   check('Source/reflection quality remains separate '+scale,g.vfx.river.reflection.size===(scale===.7?192:384)&&g.vfx.river.reflection.maxHz===(scale===.7?8:12));
  }
  g.game.paused=false;
  g.game.renderScale=1;await settle();g.actor.position.set(40*h,0,30*h);await frames(1);
  let destinationFrames=1;for(;destinationFrames<900&&!s.canExpose(g.actor.position);destinationFrames++)await frames(1);
  check('High-tier teleport exposes approved minimum ready view before full high-tier catchup',s.radius.value===8&&s.tier===100&&s.stats.queue>0&&s.inspect().groundReady<289&&g.vfx.river.reflection.size===384,{destinationFrames,stream:s.inspect()});
  g.game.renderScale=.7;g.actor.position.set(0,0,0);await settle();
  // Ground sampling and shared-edge normal/UV agreement, independent of camera-depth fog.
  let samples=true,edges=true;const vertices=new Map();let groundTriangles=0;
  for(const c of s.slots.values())if(c.ground){const geo=c.ground.sourceGeometry,p=geo.attributes.position,n=geo.attributes.normal,uv=geo.attributes.uv;groundTriangles+=geo.index.count/3;
   for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i),key=x+':'+z,row=[p.getY(i),n.getX(i),n.getY(i),n.getZ(i),uv.getX(i),uv.getY(i)];samples&&=Math.abs(p.getY(i)-(forestHeightH(x,z)-.009))<1e-6&&Math.abs(x*2-Math.round(x*2))<1e-6&&Math.abs(z*2-Math.round(z*2))<1e-6;if(vertices.has(key))edges&&=same(vertices.get(key),row);vertices.set(key,row);}
  }
  check('Ground keeps 0.5H analytic samples and identical shared edge normals/UVs',samples&&edges,{groundTriangles});
  check('No global ground/path/grove render exception',!terrain.ground.geometry.attributes.position&&!g.vfx.river.surface.parent&&terrain.chunks.authored.size>0&&g.vfx.forest.group.children.every(o=>!o.isMesh));
  const ray=new T.Raycaster(),groundMeshes=()=>[...terrain.chunks.groundBatches.buckets.values()].map(b=>b.mesh).filter(m=>m.visible);
  let rayMisses=0,rayTests=0,edgeRoundoff=0;const missedRays=[];
  for(const [x,z] of [[0,0],[7,-8],[20,12]]){
   g.actor.position.set(x*h,forestHeightH(x,z)*h,z*h);await settle();v.scene.updateMatrixWorld(true);
   for(let yaw=0;yaw<8;yaw++)for(const first of [false,true])for(const pitch of [-1.2,-.3,.3,1.2]){
    const angle=yaw*Math.PI/4,offset=first?0:4*h,eye=new T.Vector3(g.actor.position.x+Math.cos(angle)*offset,g.actor.position.y+(first?.8:1.5)*h,g.actor.position.z+Math.sin(angle)*offset);
    for(const du of [-.4,0,.4]){const direction=new T.Vector3(-Math.cos(angle+du)*Math.cos(pitch),Math.sin(pitch),-Math.sin(angle+du)*Math.cos(pitch)).normalize();
     if(direction.y>=0)continue;ray.set(eye,direction);const hits=ray.intersectObjects(groundMeshes(),false);
     const t=(g.actor.position.y-eye.y)/direction.y,point=eye.clone().addScaledVector(direction,t);if(Math.hypot(point.x-g.actor.position.x,point.z-g.actor.position.z)<(s.groundRadius.value-2)*h){rayTests++;if(!hits.length){
       // Three's non-watertight triangle ray test can miss an exact shared edge at
       // sin/cos(pi/2) roundoff. BOTH neighbours must hit at 1e-8H, not just one.
       const neighbours=[-1,1].map(sign=>{const e=eye.clone();e.x+=sign*h*1e-8;ray.set(e,direction);return ray.intersectObjects(groundMeshes(),false).length>0;});
       if(neighbours.every(Boolean))edgeRoundoff++;else{rayMisses++;missedRays.push({x,z,yaw,first,pitch,du,eye:eye.toArray(),direction:direction.toArray()});}
      }}
    }
   }
  }
  check('Max 4H orbit / FP yaw-pitch near exposed-ground rays have coverage on slopes/water',rayTests>100&&rayMisses===0,{rayTests,rayMisses,edgeRoundoff,missedRays});
  // Scripted ordinary maximum route, real RAF preparation; do not alter simulation clocks.
  g.actor.position.set(0,forestHeightH(0,12)*h,12*h);await settle();let notReady=0;
  for(let i=0;i<300;i++){g.actor.position.x+=2.1/60*h;await frames(1);if(!s.canExpose(g.actor.position))notReady++;}
  check('2.1H/s multi-boundary route has no warm readiness stalls',notReady===0,{notReady,stats:s.inspect()});
  g.actor.position.set(0,forestHeightH(0,12)*h,12*h);g.runner.play('grove-idle',true);g.game.velocity.set(0,0,0);await settle();
  g.game.perspective.setGameplay(false);v.controls.target.copy(g.actor.position);v.camera.position.copy(g.actor.position).add(new T.Vector3(-3*h,h,0));v.camera.lookAt(v.controls.target);g.game.perspective.setGameplay(true);
  const stalls=s.stats.stalls,travelStart=g.actor.position.clone();g.game.held.add('KeyW');g.game.held.add('ShiftLeft');
  for(let i=0;i<600;i++){g.game.update(1/60);await frames(1);}g.game.held.clear();g.game.velocity.set(0,0,0);
  check('Actual held-run input crosses cells without readiness motion holds after warmup',s.stats.stalls===stalls&&g.actor.position.distanceTo(travelStart)>3*h,{stalls:s.stats.stalls-stalls,travelH:g.actor.position.distanceTo(travelStart)/h});
  g.actor.position.set(0,forestHeightH(0,-8)*h,-8*h);await settle();g.game.perspective.update();await frames(5);
  const river=g.vfx.river.inspect(),cells=[...s.slots.values()],riverTriangles=g.vfx.river.surfaces.children.reduce((n,o)=>n+o.children.reduce((a,m)=>a+m.geometry.attributes.position.count/3,0),0);
  check('River is bounded with active reflection quality',riverTriangles>0&&riverTriangles<272*24*2&&cells.length===81,{riverTriangles,river});
  return {checks,tierStats,counters:s.inspect()};
 });
 await p.screenshot({path:join(out,'70-river-window.png')});
 const lifecycle=await p.evaluate(async()=>{
  const v=window.__IMG2THREEJS_VIEWER__,g=v.scene.getObjectByName('monster-tree').userData.sculptRuntime.diagnostics,s=g.vfx.forest.terrain.stream;
  g.runner.play('vine-sweep',false);g.runner.seek('vine-sweep',.4);const clip=g.runner.current.id,time=g.runner.time;
  for(const scale of [1,.7,.85,1,.7]){g.game.renderScale=scale;await new Promise(requestAnimationFrame);}
  const castStable=g.runner.current.id===clip&&g.runner.time===time&&s.slots.size===81;
  document.querySelector('.groot-mode').click();const position=g.actor.position.toArray(),clock=g.vfx.river.clock.value;g.game.renderScale=1;await new Promise(requestAnimationFrame);g.game.renderScale=.7;await new Promise(requestAnimationFrame);
  const reviewStable=JSON.stringify(position)===JSON.stringify(g.actor.position.toArray())&&g.vfx.river.clock.value===clock&&!g.vfx.river.group.visible;
  const disposedGeometry=new Map(),sources=[...g.vfx.forest.terrain.chunks.authored.values()].flat();for(const source of sources)if(!disposedGeometry.has(source.geometry)){disposedGeometry.set(source.geometry,0);source.geometry.addEventListener('dispose',()=>disposedGeometry.set(source.geometry,disposedGeometry.get(source.geometry)+1));}
  const oldFog=g.game.dayNight.oldFog;g.game.renderScale=1;g.actor.position.set(50*g.runner.height,0,0);await new Promise(requestAnimationFrame);g.game.dispose();const pumps=s.stats.pumps;await new Promise(requestAnimationFrame);g.game.dispose();
  return {castStable,reviewStable,cancelled:s.disposed&&s.slots.size===0&&s.stats.queue===0&&s.stats.pumps===pumps,sharedDisposal:[...disposedGeometry.values()].every(n=>n===1),fogRestored:v.scene.fog===oldFog,riverDisposed:g.vfx.river.disposed&&g.vfx.river.reflection.disposed,veilRemoved:!document.querySelector('.groot-local-readiness')};
 });
 result.checks.push({name:'Rapid tiers during cast/review and queued dispose preserve state and release owned resources exactly once',pass:Object.values(lifecycle).every(Boolean),detail:lifecycle});
 const report={initial,...result,errors,pass:result.checks.every(c=>c.pass)&&!errors.length};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}finally{await browser.close();}
