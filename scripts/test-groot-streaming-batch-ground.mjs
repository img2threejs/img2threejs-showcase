// Rendered-bucket coverage, not invisible source tiles or analytic-query proxies.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {homedir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});const driver=join(homedir(),'cloakbrowser-e2e/node_modules/cloakbrowser'),pkg=JSON.parse(readFileSync(join(driver,'package.json'),'utf8'));const {launch}=await import(pathToFileURL(join(driver,pkg.exports?.['.']?.import??pkg.main)).href),browser=await launch({headless:true,args:['--fingerprint=8731']}),errors=[];
try{const p=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});p.on('pageerror',e=>errors.push(e.message));await p.addInitScript(()=>{localStorage.setItem('groot:forest-ftue:v1','done');localStorage.setItem('groot:render-scale:v1','0.7');});await p.goto('http://127.0.0.1:5347/#/demo/monster-tree',{waitUntil:'domcontentloaded',timeout:120000});await p.waitForFunction(()=>window.__IMG2THREEJS_VIEWER__?.scene.getObjectByName('monster-tree')?.userData.sculptRuntime?.diagnostics.game&&!document.querySelector('.ldr'),null,{timeout:180000});
const result=await p.evaluate(async()=>{
 const T=await import('/node_modules/.vite/deps/three.js'),{forestHeightH}=await import('/src/demos/monster-tree/grootWorld.ts'),v=window.__IMG2THREEJS_VIEWER__,root=v.scene.getObjectByName('monster-tree'),g=root.userData.sculptRuntime.diagnostics,s=g.vfx.forest.terrain.stream,h=g.runner.height,rows=[],misses=[];
 root.userData.tick=()=>{};v.refreshTickers();g.game.sound.setMuted(true);const frames=async()=>new Promise(requestAnimationFrame),ray=new T.Raycaster();let tested=0,edgeRoundoff=0;
 for(const scale of [.7,.85,1])for(const [x,z] of [[0,0],[7,-8],[20,12],[-20,-12],[-3.001,2.999]]){
  g.game.renderScale=scale;g.actor.position.set(x*h,forestHeightH(x,z)*h,z*h);await frames();let n=0;while(s.stats.queue||!s.canExpose(g.actor.position)||s.radius.value!==({70:8,85:12,100:18}[s.tier])){if(n++>1800)throw Error('Not ready');await frames();}
  v.scene.updateMatrixWorld(true);const meshes=[...g.vfx.forest.terrain.chunks.groundBatches.buckets.values()].map(b=>b.mesh).filter(m=>m.visible);let localMisses=0;
  for(let yaw=0;yaw<11;yaw++)for(const first of [false,true])for(let j=0;j<20;j++){
   const angle=yaw*Math.PI*2/11,orbit=first?0:4,eye=g.actor.position.clone().add(new T.Vector3(Math.cos(angle)*orbit,first?.8:1.5,Math.sin(angle)*orbit).multiplyScalar(h));
   const r=(s.groundRadius.value-2)*(j+.5)/20,a=angle+Math.PI+(j%2?-.4:.4),tx=x+Math.cos(a)*r,tz=z+Math.sin(a)*r;
   // The analytic height is NOT the piecewise-linear rendered tile height. A nearly
   // horizontal ray aimed at the former can legitimately fly above the entire mesh.
   // First require coverage at the chosen XZ, then aim at that actual rendered point.
   ray.set(new T.Vector3(tx*h,5*h,tz*h),new T.Vector3(0,-1,0));const vertical=ray.intersectObjects(meshes,false)[0];
   if(!vertical){tested++;localMisses++;misses.push({type:'vertical coverage',scale,x,z,yaw,first,j,tx,tz});continue;}
   const direction=vertical.point.clone().sub(eye).normalize();
   ray.set(eye,direction);tested++;if(!ray.intersectObjects(meshes,false).length){const neighbours=[-1,1].map(sign=>{const e=eye.clone();e.x+=sign*h*1e-8;ray.set(e,direction);return ray.intersectObjects(meshes,false).length>0;});if(neighbours.every(Boolean))edgeRoundoff++;else{localMisses++;misses.push({scale,x,z,yaw,first,j,eye:eye.toArray(),direction:direction.toArray()});}}
  }
  rows.push({scale,x,z,tested:440,misses:localMisses,slots:s.slots.size,buckets:meshes.length,radius:s.radius.value});
 }
 return{tested,edgeRoundoff,misses,rows,pass:tested===6600&&!misses.length};
});const report={...result,errors,pass:result.pass&&!errors.length};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}finally{await browser.close();}
