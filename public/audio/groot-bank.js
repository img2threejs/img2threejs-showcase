// Original procedural Foley. No recordings, third-party samples or voice impersonation.
export const SOUND_NAMES=['step','run','strike','earth','grow','shed','wind','seed','spirit','roar','jump','taken'];
export const BANK_RATE=24000;
export const VARIANTS=3;
const durations=[.34,.40,.60,1.15,1.05,.78,.52,.62,1.45,1.3,.36,.46];
const chimes=[392,587.33,783.99,1174.66];

export function createGrootSoundBank(){
  const bank=[];
  for(let kind=0;kind<SOUND_NAMES.length;kind++)for(let variant=0;variant<VARIANTS;variant++){
    const duration=durations[kind],pcm=new Float32Array(Math.ceil(duration*BANK_RATE));
    let seed=7381+kind*311+variant*7919,low=0,slow=0,previous=0,peak=0;
    const detune=1+(variant-1)*.047;
    for(let i=0;i<pcm.length;i++){
      const t=i/BANK_RATE,u=t/duration;
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2147483648-1;
      low+=.13*(noise-low);slow+=.014*(noise-slow);const high=noise-previous;previous=noise;
      const wood=(Math.sin(t*2*Math.PI*137*detune)*Math.exp(-t*18)+.5*Math.sin(t*2*Math.PI*327*detune)*Math.exp(-t*27)+.22*Math.sin(t*2*Math.PI*791*detune)*Math.exp(-t*40));
      const thud=Math.sin(2*Math.PI*(62*t-12*t*t)*detune)*Math.exp(-t*17);
      let value=0;
      if(kind===0||kind===1){
        const heavy=kind===1?1.3:1;
        value=heavy*(wood*.32+thud*.55)+low*Math.exp(-t*14)*.65+high*Math.exp(-t*31)*.055;
        value+=noise*.045*Math.exp(-Math.max(0,t-.055)*17)*Math.sin(Math.PI*Math.min(1,t/.09))**2;
      }else if(kind===2||kind===11){
        value=wood*.7+thud*.38+noise*Math.exp(-t*65)*.38+low*Math.exp(-t*10)*.28;
        value+=Math.sin(t*2*Math.PI*211*detune)*Math.exp(-Math.abs(t-.07)*55)*.19;
      }else if(kind===3){
        value=wood*.30+Math.sin(2*Math.PI*(44*t-6*t*t))*Math.exp(-t*5)*.60+slow*Math.exp(-t*3)*2.6;
        for(let crack=0;crack<6;crack++){const age=t-crack*.036;if(age>=0)value+=noise*Math.exp(-age*60)*(.17-crack*.016);}
      }else if(kind===4||kind===5){
        const phase=kind===5?1-u:u,envelope=Math.sin(Math.PI*u)**.8;
        value=(low*.9+slow*1.2)*envelope*(.3+.7*Math.sin(t*32+Math.sin(t*11))**8);
        value+=Math.sin(2*Math.PI*(145*t+35*t*t)*detune)*envelope*.10*(.5+.5*Math.sin(phase*19));
        value+=noise*.1*Math.exp(-Math.abs(t-duration*.73)*35);
      }else if(kind===6||kind===10){
        value=(low*.7+high*.025)*Math.sin(Math.PI*u)**2+Math.sin(2*Math.PI*(105*t-38*t*t))*Math.sin(Math.PI*u)*.10;
      }else if(kind===7){
        value=wood*.20+noise*Math.exp(-t*35)*.12+low*Math.sin(Math.PI*u)*.24;
        value+=Math.sin(2*Math.PI*(640*t-220*t*t)*detune)*Math.exp(-t*7)*.13;
      }else if(kind===8){
        for(let note=0;note<4;note++){
          const age=t-note*.12;if(age<0)continue;const hz=chimes[note]*detune;
          value+=(Math.sin(2*Math.PI*hz*age)+.15*Math.sin(2*Math.PI*hz*2.76*age))*Math.min(1,age/.015)*Math.exp(-age*4)*.13;
        }
        value+=low*.10*Math.sin(Math.PI*u)**2;
      }else if(kind===9){
        const envelope=Math.sin(Math.PI*u)**.65;
        value=(slow*2.3+low*.35)*envelope;
        value+=(Math.sin(t*2*Math.PI*53+Math.sin(t*18)*.65)+.28*Math.sin(t*2*Math.PI*113))*envelope*.20;
      }
      const fade=Math.min(1,i/(BANK_RATE*.004))*Math.min(1,(pcm.length-1-i)/(BANK_RATE*.04));
      pcm[i]=value*fade;peak=Math.max(peak,Math.abs(pcm[i]));
    }
    // -12 dBFS sample peak per isolated asset. The mixer provides additional headroom.
    const gain=.25/Math.max(peak,1e-6);for(let i=0;i<pcm.length;i++)pcm[i]*=gain;
    bank.push(pcm);
  }
  return bank;
}
