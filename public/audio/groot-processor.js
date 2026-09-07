import {createGrootSoundBank,BANK_RATE,VARIANTS} from './groot-bank.js';
const CAPACITY=24;
class GrootSoundProcessor extends AudioWorkletProcessor {
  constructor(){
    super();this.bank=createGrootSoundBank();this.index=new Int16Array(CAPACITY).fill(-1);
    this.position=new Float64Array(CAPACITY);this.rate=new Float32Array(CAPACITY);
    this.left=new Float32Array(CAPACITY);this.right=new Float32Array(CAPACITY);
    this.priority=new Uint8Array(CAPACITY);this.variant=0;this.target=.55;this.master=0;this.played=0;this.dropped=0;this.peak=0;
    this.port.onmessage=({data:m})=>{
      if(m.type==='stop'){this.index.fill(-1);return;}
      if(m.type==='volume'){this.target=Math.max(0,Math.min(1,m.value));return;}
      if(m.type==='inspect'){this.port.postMessage({type:'metrics',capacity:CAPACITY,active:this.index.reduce((n,v)=>n+Number(v>=0),0),played:this.played,dropped:this.dropped,peak:this.peak});return;}
      if(m.type!=='play'||!Number.isInteger(m.kind)||m.kind<0||m.kind>=this.bank.length/VARIANTS)return;
      let slot=this.index.indexOf(-1);
      if(slot<0){slot=0;for(let i=1;i<CAPACITY;i++)if(this.priority[i]<this.priority[slot]||(this.priority[i]===this.priority[slot]&&this.position[i]>this.position[slot]))slot=i;
        if(this.priority[slot]>m.priority){this.dropped++;return;}}
      this.index[slot]=m.kind*VARIANTS+(this.variant++%VARIANTS);this.position[slot]=0;
      this.rate[slot]=BANK_RATE/sampleRate*Math.max(.6,Math.min(1.5,m.rate));this.priority[slot]=m.priority;
      const angle=(Math.max(-1,Math.min(1,m.pan))+1)*Math.PI/4,gain=Math.max(0,Math.min(1,m.gain));
      this.left[slot]=Math.cos(angle)*gain;this.right[slot]=Math.sin(angle)*gain;this.played++;
    };
    this.port.postMessage({type:'ready',samples:this.bank.length,capacity:CAPACITY});
  }
  process(_inputs,outputs){
    const left=outputs[0][0],right=outputs[0][1];if(!left||!right)return true;left.fill(0);right.fill(0);
    for(let voice=0;voice<CAPACITY;voice++){
      const index=this.index[voice];if(index<0)continue;const pcm=this.bank[index];let pos=this.position[voice];
      for(let frame=0;frame<left.length;frame++){
        const i=Math.floor(pos);if(i>=pcm.length-1){this.index[voice]=-1;break;}
        const sample=pcm[i]+(pcm[i+1]-pcm[i])*(pos-i);left[frame]+=sample*this.left[voice];right[frame]+=sample*this.right[voice];pos+=this.rate[voice];
      }
      this.position[voice]=pos;
    }
    for(let i=0;i<left.length;i++){
      this.master+=(this.target-this.master)*.004;
      // Soft ceiling below -4 dBFS, even if every voice is occupied. No worklet render allocations.
      left[i]=.60*Math.tanh(left[i]*this.master/.60);right[i]=.60*Math.tanh(right[i]*this.master/.60);
      this.peak=Math.max(this.peak,Math.abs(left[i]),Math.abs(right[i]));
    }
    return true;
  }
}
registerProcessor('groot-sound',GrootSoundProcessor);
