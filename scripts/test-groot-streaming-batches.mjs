import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {homedir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});const driver=join(homedir(),'cloakbrowser-e2e/node_modules/cloakbrowser'),pkg=JSON.parse(readFileSync(join(driver,'package.json'),'utf8'));const {launch}=await import(pathToFileURL(join(driver,pkg.exports?.['.']?.import??pkg.main)).href),browser=await launch({headless:true,args:['--fingerprint=8731']}),errors=[];
try{const p=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'&&/Shader Error|VALIDATE_STATUS/.test(m.text()))errors.push(m.text());});await p.addInitScript(()=>{localStorage.setItem('groot:forest-ftue:v1','done');localStorage.setItem('groot:render-scale:v1','0.7');});await p.goto('http://127.0.0.1:5347/#/demo/monster-tree',{waitUntil:'domcontentloaded',timeout:120000});await p.waitForFunction(()=>window.__IMG2THREEJS_VIEWER__?.scene.getObjectByName('monster-tree')?.userData.sculptRuntime?.diagnostics.game&&!document.querySelector('.ldr'),null,{timeout:180000});
const result=await p.evaluate(async()=>{
 const T=await import('/node_modules/.vite/deps/three.js'),viewer=window.__IMG2THREEJS_VIEWER__,root=viewer.scene.getObjectByName('monster-tree'),g=root.userData.sculptRuntime.diagnostics,terrain=g.vfx.forest.terrain,s=terrain.stream,b=terrain.chunks.batches,h=g.runner.height,checks=[];
 const check=(name,pass,detail)=>checks.push({name,pass,detail}),frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},settle=async()=>{await frames(1);let n=0;while(s.stats.queue||s.radius.value!==({70:8,85:12,100:18}[s.tier])||!s.canExpose(g.actor.position)){if(n++>1800)throw Error('Unsettled');await frames(1);}};
 root.userData.tick=()=>{};viewer.refreshTickers();g.game.sound.setMuted(true);await settle();
 const arrays=new WeakSet(),dirty=new Map(),gl=viewer.renderer.getContext(),gpu={initial:0,partial:0,bytes:0,bad:[],neighbours:0,retired:0},pending=new WeakMap();
 // Refined contract: membership/count changes may relocate THIS bucket's suffix.
 // We authorize exactly that suffix, not the prefix, other buckets or regenerated sources.
 const resize=b.resize.bind(b);b.resize=(span,count,writeSource)=>{
  const mesh=span.mesh,oldTotal=mesh.count,oldEnd=span.offset+span.count,delta=count-span.count,newTotal=oldTotal+delta,end=delta?Math.max(oldTotal,newTotal):span.offset+count;
  const snapshots=[mesh.instanceMatrix,mesh.instanceColor].filter(Boolean).map(attr=>({attr,old:Array.from(attr.array)}));
  const bucket=[...b.buckets.values()].find(x=>x.mesh===mesh),neighbours=[...bucket.spans.values()].filter(x=>x!==span).map(x=>({span:x,offset:x.offset,version:x.source.instanceMatrix.version,source:Array.from(x.source.instanceMatrix.array)}));
  for(const {attr} of snapshots){arrays.add(attr.array);const size=attr.itemSize,ranges=dirty.get(attr.array)??[];ranges.push([span.offset*size,end*size]);dirty.set(attr.array,ranges);}
  const result=resize(span,count,writeSource);
  for(const {attr,old} of snapshots)for(let i=0;i<old.length;i++)if((i<span.offset*attr.itemSize||i>=end*attr.itemSize)&&old[i]!==attr.array[i])gpu.bad.push('outside authorized local suffix');
  for(const n of neighbours){if(n.span.offset!==n.offset+(delta&&n.offset>=oldEnd?delta:0)||n.span.source.instanceMatrix.version!==n.version||n.source.some((x,i)=>x!==n.span.source.instanceMatrix.array[i]))gpu.bad.push('source regenerated or illegal relocation');if(n.offset!==n.span.offset)gpu.neighbours++;}
  for(const {attr} of snapshots)for(let i=newTotal*attr.itemSize;i<oldTotal*attr.itemSize;i++)if(attr.array[i]!==0)gpu.bad.push('retired tail nonzero');
  if(!writeSource)gpu.retired++;return result;
 };
 for(const bucket of b.buckets.values())for(const attr of [bucket.mesh.instanceMatrix,bucket.mesh.instanceColor])if(attr){arrays.add(attr.array);const cb=attr.onUploadCallback;attr.onUpload(()=>{cb.call(attr);dirty.delete(attr.array);});pending.set(attr,true);}
 const data=gl.bufferData.bind(gl),sub=gl.bufferSubData.bind(gl);
 gl.bufferData=(...a)=>{if(arrays.has(a[1])){gpu.initial++;gpu.bytes+=a[1].byteLength;dirty.delete(a[1]);}return data(...a);};
 gl.bufferSubData=(...a)=>{const array=a[2];if(arrays.has(array)){gpu.partial++;const start=a[3]??0,end=start+(a[4]??array.length),ranges=dirty.get(array)??[];if(a[1]!==start*array.BYTES_PER_ELEMENT)gpu.bad.push('GPU destination differs from authorized range');gpu.bytes+=(end-start)*array.BYTES_PER_ELEMENT;for(let i=start;i<end;i++)if(!ranges.some(([lo,hi])=>i>=lo&&i<hi)){gpu.bad.push({type:'unchanged GPU upload',start,end,i,ranges});break;}}return sub(...a);};
 // Dirty ranges live until the renderer's onUpload callback, not until a neighbouring
 // copy. This includes delayed uploads of off-frustum buckets across multiple frames.
 const watch=b.attach.bind(b);b.attach=(...a)=>{const span=watch(...a);if(span)for(const attr of [span.mesh.instanceMatrix,span.mesh.instanceColor])if(attr&&!pending.has(attr)){const cb=attr.onUploadCallback;attr.onUpload(()=>{cb.call(attr);dirty.delete(attr.array);});pending.set(attr,true);}return span;};
 const before={copies:b.stats.copies,bytes:s.stats.uploadedBytes,gl:gpu.partial+gpu.initial};await frames(20);check('Settled same cell: zero generation/copies or actual GPU writes',before.copies===b.stats.copies&&before.bytes===s.stats.uploadedBytes&&before.gl===gpu.partial+gpu.initial);
 const original=new Map([...s.slots].map(([key,slot])=>[key,slot.vegetation?.sourceMeshes?.map(m=>({name:m.name,count:m.count,a:Array.from(m.instanceMatrix.array)}))]));
 let ownerCalls=0,shadowCalls=0,reflectionCalls=0;const badOwners=[],direct=viewer.renderer.renderBufferDirect.bind(viewer.renderer);
 let groundCalls=0;
 const groundBatches=terrain.chunks.groundBatches,groundDirty=new Map(),groundArrays=new WeakSet(),groundGPU={initial:0,partial:0,bad:[]};
 const trackGround=(cx,cz,attributes)=>{
  const side=groundBatches.cellSide,offset=((cz-Math.floor(cz/side)*side)*side+cx-Math.floor(cx/side)*side);
  for(const attr of attributes){groundArrays.add(attr.array);if(!pending.has(attr)){const cb=attr.onUploadCallback;attr.onUpload(()=>{cb.call(attr);groundDirty.delete(attr.array);});pending.set(attr,true);}}
  return()=>{for(const attr of attributes){const length=attr.array.length/(side*side),ranges=groundDirty.get(attr.array)??[];ranges.push([offset*length,(offset+1)*length]);groundDirty.set(attr.array,ranges);}};
 };
 for(const bucket of groundBatches.buckets.values())for(const span of bucket.spans.values()){
  const mark=trackGround(span.cx,span.cz,[...Object.values(bucket.mesh.geometry.attributes),bucket.mesh.geometry.index]),part=s.slots.get(span.key).ground,dispose=part.dispose;part.dispose=()=>{mark();dispose();};
 }
 const groundAttach=groundBatches.attach.bind(groundBatches);groundBatches.attach=(cx,cz,source)=>{
  const result=groundAttach(cx,cz,source),mark=trackGround(cx,cz,result.extraBuffers);mark();
  const dispose=result.dispose;result.dispose=()=>{mark();dispose();};return result;
 };
 const groundData=gl.bufferData.bind(gl),groundSub=gl.bufferSubData.bind(gl);
 gl.bufferData=(...a)=>{if(groundArrays.has(a[1])){groundGPU.initial++;groundDirty.delete(a[1]);}return groundData(...a);};
 gl.bufferSubData=(...a)=>{if(groundArrays.has(a[2])){groundGPU.partial++;const start=a[3]??0,end=start+(a[4]??a[2].length),ranges=groundDirty.get(a[2])??[];if(a[1]!==start*a[2].BYTES_PER_ELEMENT)groundGPU.bad.push('GPU destination offset');for(let i=start;i<end;i++)if(!ranges.some(([lo,hi])=>i>=lo&&i<hi)){groundGPU.bad.push({start,end,i,ranges});break;}}return groundSub(...a);};
 viewer.renderer.renderBufferDirect=(camera,scene,geometry,material,object,group)=>{if(object.isInstancedMesh&&object.userData.streamSpans){ownerCalls++;if(material.isMeshDepthMaterial)shadowCalls++;else if(camera!==viewer.camera)reflectionCalls++;const spans=object.userData.streamSpans,bucket=object.userData.streamBucket;for(const span of spans){const [cx,cz]=span.key.split(':').map(Number);if(!s.slots.get(span.key)?.vegetation||Math.floor(cx/b.cellSide)!==bucket.x||Math.floor(cz/b.cellSide)!==bucket.z)badOwners.push(span.key);}if(spans.length<1||spans.length>b.cellSide*b.cellSide||spans.reduce((n,s)=>n+s.count,0)!==object.count)badOwners.push('non-dense count');for(let i=0;i<object.count;i++)if(!spans.some(span=>i>=span.offset&&i<span.offset+span.count)){for(let j=0;j<16;j++)if(object.instanceMatrix.array[i*16+j]!==0)badOwners.push('unowned nonzero record');}}
 if(!object.isInstancedMesh&&object.userData.streamSpans){groundCalls++;const spans=object.userData.streamSpans,bucket=object.userData.streamBucket;for(const span of spans){const [cx,cz]=span.key.split(':').map(Number);if(!s.slots.get(span.key)?.ground||Math.floor(cx/groundBatches.cellSide)!==bucket.x||Math.floor(cz/groundBatches.cellSide)!==bucket.z)badOwners.push('ground '+span.key);for(let i=span.offset;i<span.offset+span.count;i++)if(geometry.index.array[i]<span.vertexOffset||geometry.index.array[i]>=span.vertexOffset+span.vertexCount)badOwners.push('cross-cell ground index');}for(let i=0;i<geometry.drawRange.count;i++)if(!spans.some(span=>i>=span.offset&&i<span.offset+span.count)&&geometry.index.array[i]!==0)badOwners.push('evicted ground geometry');}
 return direct(camera,scene,geometry,material,object,group);};
 for(const scale of [1,.7,.85,.7]){g.game.renderScale=scale;await settle();check('Tier '+scale+' bounded spatial pool',s.slots.size===({70:81,85:169,100:289}[s.tier])&&b.buckets.size<=Math.ceil((Math.sqrt(s.slots.size)+b.cellSide-1)/b.cellSide)**2*5&&groundBatches.buckets.size<=Math.ceil((Math.sqrt(s.slots.size)+groundBatches.cellSide-1)/groundBatches.cellSide)**2,{slots:s.slots.size,buckets:b.buckets.size,groundBuckets:groundBatches.buckets.size});}
 g.actor.position.x=3.05*h;await settle();g.actor.position.set(40*h,0,40*h);await settle();g.actor.position.set(0,0,0);await settle();
 const reentry=s.slots.get('1:1')?.vegetation?.sourceMeshes?.map(m=>({name:m.name,count:m.count,a:Array.from(m.instanceMatrix.array)}));check('Evicted cell reentry deterministically recreates source and uploaded transforms',JSON.stringify(original.get('1:1'))===JSON.stringify(reentry));
 for(let i=0;i<100;i++){g.actor.position.x+=.035*h;await frames(1);}await settle();
 viewer.camera.position.set(2.5*h,1.5*h,2.5*h);viewer.camera.lookAt(0,h,0);viewer.scene.updateMatrixWorld(true);g.vfx.river.reflection.invalidate();viewer.renderer.render(viewer.scene,viewer.camera);
 check('All actual cell owners audited in main/shadow/reflection; gaps/evictions degenerate',ownerCalls>0&&groundCalls>0&&shadowCalls>0&&reflectionCalls>0&&!badOwners.length,{ownerCalls,groundCalls,shadowCalls,reflectionCalls,badOwners:badOwners.slice(0,10)});
 check('Dense relocation uploads only authorized local suffixes; neighboring SOURCE cells unchanged',gpu.initial>0&&gpu.partial>0&&gpu.neighbours>0&&gpu.retired>0&&!gpu.bad.length,gpu);
 check('Ground arrival/retirement GPU ranges never include unchanged neighbour spans',groundGPU.initial>0&&groundGPU.partial>0&&!groundGPU.bad.length,groundGPU);
 let bounds=true,fidelity=true;for(const bucket of b.buckets.values())for(const span of bucket.spans.values()){
  bounds&&=bucket.mesh.boundingBox.containsBox(span.source.boundingBox)&&bucket.mesh.boundingSphere.radius>=0;
  for(const [attribute,source,size] of [[bucket.mesh.instanceMatrix,span.source.instanceMatrix,16],[bucket.mesh.instanceColor,span.source.instanceColor,3]])if(source)for(let i=0;i<span.count*size;i++)fidelity&&=attribute.array[span.offset*size+i]===source.array[i];
 }
 for(const bucket of groundBatches.buckets.values())for(const span of bucket.spans.values())for(const [name,attribute] of Object.entries(span.source.attributes)){const actual=bucket.mesh.geometry.attributes[name];for(let i=0;i<attribute.array.length;i++)fidelity&&=actual.array[span.offset*attribute.array.length+i]===attribute.array[i];}
 check('Rendered bucket bounds include every source deformation-padded bound',bounds);
 check('Every owned GPU matrix, colour and ground vertex matches its exact per-cell source',fidelity);
 const stats={...b.stats},stream=s.inspect();g.game.dispose();g.game.dispose();check('Dispose releases every bounded bucket once',b.buckets.size===0&&groundBatches.buckets.size===0&&b.stats.created===b.stats.released&&s.slots.size===0,{...b.stats});
 return{checks,stats,stream};
});const report={...result,errors,pass:result.checks.every(c=>c.pass)&&!errors.length};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}finally{await browser.close();}
