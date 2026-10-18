// Turns the microphone into small 24 kHz 16-bit chunks for live hearing. Runs on the audio thread.
class PcmSender extends AudioWorkletProcessor {
  constructor(){ super(); this.rate=sampleRate; this.acc=[]; this.n=0; this.pos=0; this.on=false; this.port.onmessage=e=>{ this.on=!!e.data; }; }
  process(inputs){
    const ch=inputs[0]&&inputs[0][0]; if(!ch) return true;
    if(!this.on) return true;
    const ratio=this.rate/24000, out=[];
    // simple resample: walk through the input at the output rate
    let p=this.pos;
    for(; p<ch.length; p+=ratio){ const i=Math.floor(p), f=p-i, a=ch[i], b=ch[i+1]!==undefined?ch[i+1]:a; out.push(a+(b-a)*f); }
    this.pos=p-ch.length;
    this.acc.push(out); this.n+=out.length;
    if(this.n>=2400){ // ~100 ms
      const buf=new Int16Array(this.n); let k=0;
      for(const arr of this.acc) for(let j=0;j<arr.length;j++){ const v=Math.max(-1,Math.min(1,arr[j])); buf[k++]=v<0?v*32768:v*32767; }
      this.acc=[]; this.n=0;
      this.port.postMessage(buf.buffer,[buf.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-sender',PcmSender);
