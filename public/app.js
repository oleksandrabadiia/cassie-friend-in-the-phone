(function(){
"use strict";
const $=id=>document.getElementById(id);
const face=()=>window.CassieFace;

// ---------- settings saved on this device ----------
const store={
  get(k,d){ try{ const v=localStorage.getItem('cassie.'+k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem('cassie.'+k,JSON.stringify(v)); }catch(e){} }
};
const S={
  code:store.get('code',''),
  limit:store.get('limit',20),
  handsFree:store.get('handsFree',true),
  showWords:store.get('showWords',true),
  voice:store.get('voice','marin'),
  liveEars:store.get('liveEars',true),
  bargeIn:store.get('bargeIn',true),
  pause:store.get('pause',500),
};
const today=()=>new Date().toLocaleDateString('en-CA');
function usage(){ const u=store.get('usage',{}); return u.date===today()?u:{date:today(),seconds:0,bonus:0}; }
function saveUsage(u){ store.set('usage',u); }
function minutesLeft(){ const u=usage(); return (S.limit+u.bonus)-u.seconds/60; }

// ---------- UI helpers ----------
const talkBtn=$('talk'), label=$('talklabel'), caption=$('caption');
const LABELS={idle:'Talk',listening:'I’m listening…',thinking:'Hmm…',speaking:'',sleeping:'Cassie is resting'};
let state='idle', quietSince=Date.now(), idleStage=0;
function setState(s){
  state=s; quietSince=Date.now(); idleStage=0; talkBtn.dataset.state=s; label.textContent=LABELS[s]??'';
  talkBtn.setAttribute('aria-label', s==='listening'?'Stop and send':s==='speaking'?'Interrupt Cassie':'Talk to Cassie');
  const f=face(); if(!f) return;
  if(s==='listening') f.mode('listening');
  else if(s==='thinking') f.mode('thinking');
  else if(s==='sleeping') f.mode('sleepy');
  else if(s==='idle') f.mode('idle');
}
function say(text,small){ caption.classList.toggle('small',!!small); caption.textContent=(S.showWords||small)?text:''; caption.scrollTop=0; }
function applyWords(){ document.body.classList.toggle('nowords',!S.showWords); dispatchEvent(new Event('resize')); }
applyWords();
// while Cassie talks, gently scroll long captions so the current bit is visible
let capScroll=null;
function scrollCaption(seconds){ clearInterval(capScroll); caption.scrollTop=0; const max=caption.scrollHeight-caption.clientHeight; if(max<=4) return; const t0=performance.now(); capScroll=setInterval(()=>{ const p=Math.min(1,(performance.now()-t0)/(seconds*1000)); caption.scrollTop=max*Math.max(0,(p-.25)/.75); if(p>=1) clearInterval(capScroll); },100); }

// ---------- server calls ----------
async function api(path,opts={}){
  const headers=Object.assign({'x-cassie-code':S.code},opts.headers||{});
  const r=await fetch(path,Object.assign({},opts,{headers}));
  if(!r.ok){ let e={}; try{ e=await r.json(); }catch(_){} const err=new Error(e.error||('http-'+r.status)); err.code=e.error||r.status; throw err; }
  return r;
}
function friendlyError(e){
  switch(e.code){
    case 'wrong-code': return 'Ask a grown-up to check the family code.';
    case 'no-key': return 'Cassie isn’t connected yet. A grown-up needs to add the OpenAI key on Netlify.';
    case 'bad-key': return 'Cassie’s OpenAI key isn’t working. A grown-up needs to check it.';
    case 'budget': return 'Cassie has used this month’s pocket money. A grown-up can check the settings.';
    case 'no-google-key': return 'Google voices aren’t connected yet. A grown-up needs to add the Google key on Netlify.';
    case 'bad-google-key': return 'The Google voice key isn’t working. A grown-up needs to check it.';
    case 'openai-limit': return 'Cassie needs a little rest. Try again in a minute.';
    default: return 'Oops, Cassie couldn’t hear the internet. Try again!';
  }
}

// ---------- audio: one AudioContext, unlocked by the first tap ----------
let ac=null, micStream=null, micAn=null, pcmNode=null;
function audioCtx(){ if(!ac){ const C=window.AudioContext||window.webkitAudioContext; ac=new C(); } if(ac.state==='suspended') ac.resume(); return ac; }

// ---------- active-time tracking for the daily limit ----------
let activeSince=null;
function markActive(on){
  const u=usage();
  if(on&&activeSince==null) activeSince=Date.now();
  if(!on&&activeSince!=null){ u.seconds+=(Date.now()-activeSince)/1000; activeSince=null; saveUsage(u); }
}
setInterval(()=>{ if(activeSince!=null){ const u=usage(); u.seconds+=(Date.now()-activeSince)/1000; activeSince=Date.now(); saveUsage(u); } },5000);

// ---------- microphone: one stream, one level meter, one live-hearing feed ----------
async function getMic(){
  if(micStream&&micStream.getTracks().some(t=>t.readyState==='live')) return micStream;
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  micAn=null; pcmNode=null;
  return micStream;
}
async function micGraph(){
  const stream=await getMic(), ctx=audioCtx();
  if(!micAn){ const src=ctx.createMediaStreamSource(stream); micAn=ctx.createAnalyser(); micAn.fftSize=1024; src.connect(micAn);
    try{ await ctx.audioWorklet.addModule('/pcm-worklet.js?v=1'); pcmNode=new AudioWorkletNode(ctx,'pcm-sender'); src.connect(pcmNode); pcmNode.port.onmessage=e=>Ears.feed(e.data); pcmNode.port.postMessage(true); }catch(e){ console.warn('no worklet',e); pcmNode=null; }
  }
  return micAn;
}
const micBuf=new Float32Array(1024);
function micLevel(){ if(!micAn) return 0; micAn.getFloatTimeDomainData(micBuf); let s=0; for(let i=0;i<micBuf.length;i++) s+=micBuf[i]*micBuf[i]; return Math.sqrt(s/micBuf.length); }

// ---------- live ears: William's voice streams to OpenAI while he talks, so the words are ready the moment he stops ----------
const Ears={
  ws:null, connecting:false, fails:0, timeouts:0, open:false, sending:false, queue:[], preroll:[], text:'', waiters:[], item:null, expires:0,
  enabled(){ return S.liveEars&&this.fails<2; },
  async connect(){
    if(!this.enabled()||!pcmNode) return false;
    if(this.ws&&this.ws.readyState<=1&&Date.now()<this.expires-20000) return true;
    if(this.connecting) return false;
    this.close(); this.connecting=true;
    try{
      const d=await (await api('/api/ears',{method:'POST'})).json();
      if(!d.token) throw new Error('no token');
      this.expires=d.expires?d.expires*1000:Date.now()+540000;
      // try the current way first, then the older way, with the same key
      const tries=d.api==='beta'
        ?[['wss://api.openai.com/v1/realtime?intent=transcription',['realtime','openai-insecure-api-key.'+d.token,'openai-beta.realtime-v1']]]
        :[['wss://api.openai.com/v1/realtime',['realtime','openai-insecure-api-key.'+d.token]],['wss://api.openai.com/v1/realtime?intent=transcription',['realtime','openai-insecure-api-key.'+d.token,'openai-beta.realtime-v1']]];
      let ws=null, lastErr=null;
      for(const [url,protos] of tries){
        try{
          const w=new WebSocket(url,protos); this.ws=w; this.open=false;
          await new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('timeout')),4000); w.onopen=()=>{ clearTimeout(t); res(); }; w.onerror=e=>{ clearTimeout(t); rej(e); }; w.onclose=()=>{ clearTimeout(t); rej(new Error('closed')); }; });
          ws=w; break;
        }catch(e){ lastErr=e; try{ this.ws&&this.ws.close(); }catch(_){} this.ws=null; }
      }
      if(!ws) throw lastErr||new Error('no socket');
      this.open=true; this.fails=0;
      if(d.api==='beta') ws.send(JSON.stringify({type:'transcription_session.update',session:{input_audio_format:'pcm16',input_audio_transcription:{model:d.model,language:'en'},turn_detection:null}}));
      ws.onmessage=e=>{ let m; try{ m=JSON.parse(e.data); }catch(_){ return; } this.onEvent(m); };
      ws.onclose=()=>{ if(this.ws===ws){ this.ws=null; this.open=false; this.resolve(null); } };
      ws.onerror=()=>{};
      for(const q of this.queue) ws.send(q); this.queue=[];
      this.connecting=false; return true;
    }catch(e){ console.warn('live ears off',e); this.fails++; this.ws=null; this.open=false; this.queue=[]; this.connecting=false; return false; }
  },
  close(){ if(this.ws){ try{ this.ws.close(); }catch(e){} } this.ws=null; this.open=false; this.queue=[]; },
  onEvent(m){
    if(m.type==='conversation.item.input_audio_transcription.delta'){ if(this.item&&m.item_id&&m.item_id!==this.item) return; this.item=m.item_id||this.item; this.text+=m.delta||''; }
    else if(m.type==='conversation.item.input_audio_transcription.completed'){ this.resolve((m.transcript||'').trim()); }
    else if(m.type==='error'){ console.warn('ears error',m.error); if(m.error&&/session|unauthor|token|expired/i.test(m.error.message||'')) this.close(); }
  },
  // audio from the worklet: keep a little of the past (so an interruption doesn't lose his first word), send while listening
  feed(buf){
    this.preroll.push(buf); if(this.preroll.length>6) this.preroll.shift();
    if(!this.sending) return;
    this.send(buf);
  },
  send(buf){
    let bin=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    const msg=JSON.stringify({type:'input_audio_buffer.append',audio:btoa(bin)});
    if(this.ws&&this.open) this.ws.send(msg); else if(this.connecting&&this.queue.length<300) this.queue.push(msg);
  },
  start(withPreroll){
    this.text=''; this.item=null; this.resolve(null); this.waiters=[];
    if(!this.enabled()||!pcmNode) return false;
    this.connect();
    if(this.ws&&this.open) try{ this.ws.send(JSON.stringify({type:'input_audio_buffer.clear'})); }catch(e){}
    if(withPreroll) for(const b of this.preroll) this.send(b);
    this.preroll=[]; this.sending=true; return true;
  },
  // he stopped talking: ask for the words, wait briefly, give up and fall back if they don't come
  finish(ms){
    this.sending=false;
    if(!this.ws||!this.open) return Promise.resolve(null);
    try{ this.ws.send(JSON.stringify({type:'input_audio_buffer.commit'})); }catch(e){ return Promise.resolve(null); }
    return new Promise(res=>{ this.waiters.push(v=>{ this.timeouts=0; res(v); }); setTimeout(()=>{ if(this.waiters.length){ this.waiters=[]; if(++this.timeouts>=2){ this.fails=9; this.close(); } res(null); } },ms); });
  },
  cancel(){ this.sending=false; this.resolve(null); if(this.ws&&this.open) try{ this.ws.send(JSON.stringify({type:'input_audio_buffer.clear'})); }catch(e){} },
  resolve(v){ const w=this.waiters; this.waiters=[]; for(const r of w) r(v); },
};

// ---------- listening ----------
let rec=null, recChunks=[], recInfo=null;
function pickMime(){
  const opts=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg'];
  for(const m of opts){ try{ if(window.MediaRecorder&&MediaRecorder.isTypeSupported(m)) return m; }catch(e){} }
  return '';
}
async function startListening(auto,opts={}){
  if(minutesLeft()<=0){ return goToSleep(); }
  let an;
  try{ an=await micGraph(); }
  catch(e){ setState('idle'); say('Cassie needs the microphone. A grown-up can allow it in Settings.',true); return; }
  const stream=micStream, mime=pickMime();
  try{ rec=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream); }catch(e){ rec=new MediaRecorder(stream); }
  recChunks=[]; const started=performance.now();
  recInfo={mime:rec.mimeType||mime||'audio/mp4',heard:!!opts.interrupted,started,cancelled:false,live:false,token:playToken};
  rec.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
  rec.onstop=()=>onRecorded();
  rec.start(250);
  recInfo.live=Ears.start(!!opts.interrupted);
  setState('listening'); markActive(true);
  if(!auto) say('',true);
  // voice detection: stop after a short pause, or give up if he says nothing
  let noise=0.01, n=0, lastLoud=opts.interrupted?0:-1;
  const tick=()=>{
    if(!rec||rec.state!=='recording') return;
    const rms=micLevel(), t=performance.now()-started;
    if(t<300&&!opts.interrupted){ noise=(noise*n+rms)/(++n); }
    else{
      const thr=Math.max(0.018,noise*3);
      if(rms>thr){ recInfo.heard=true; lastLoud=t; }
      if(recInfo.heard&&t-lastLoud>S.pause) return stopListening();
      if(!recInfo.heard&&t>(auto?7000:9000)){ recInfo.cancelled=true; return stopListening(); }
      if(t>20000) return stopListening();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopListening(){ if(rec&&rec.state==='recording') rec.stop(); }

const history=[];
// ---------- instant reactions: tiny clips in Cassie's own voice, made once and kept on the phone ----------
const FILLERS=['Hmm…','Ooh!','Ooh, okay!','Let me think…','Oh yeah!','Nice!','Wow!','Gotcha!','Aha!','Ha!','Ooh, good one!','Right…','Hmm, let me see…','Oh! Okay, okay…','Brilliant!'];
const CALLOUTS=['William? Where did you go?','Hello-o! I’m getting a bit bored. Shall we play a game?','Psst, William! Tap the big button when you want to talk to me!'];
const calloutBufs={};
async function loadCallouts(){ const v=S.voice; if(calloutBufs[v]) return; calloutBufs[v]=[]; for(const t of CALLOUTS){ try{ calloutBufs[v].push({t,b:await fetchAudio(t,'wink')}); }catch(e){} } }
const fillerBufs={};  // voice -> [AudioBuffer]
async function fetchAudio(text,mood){
  const r=await api('/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:S.voice,mood:mood||'front'})});
  const bytes=await r.arrayBuffer(); const ctx=audioCtx();
  return await new Promise((res,rej)=>ctx.decodeAudioData(bytes,res,rej));
}
async function loadFillers(){
  const v=S.voice; if(fillerBufs[v]) return;
  fillerBufs[v]=[];
  const list=FILLERS.slice().sort(()=>Math.random()-.5);
  for(let i=0;i<list.length;i+=3){ await Promise.all(list.slice(i,i+3).map(async t=>{ try{ fillerBufs[v].push(await fetchAudio(t,'think')); }catch(e){} })); }
}
let lastFiller=null;
function randomFiller(){ const l=fillerBufs[S.voice]; if(!l||!l.length) return null; let b; do{ b=l[Math.floor(Math.random()*l.length)]; }while(l.length>1&&b===lastFiller); lastFiller=b; return b; }

async function onRecorded(){
  const info=recInfo, chunks=recChunks; rec=null;
  if(info.cancelled||!info.heard){ Ears.cancel(); if(info.token!==playToken) return;   // something else (a topic button) has taken over
    markActive(false); setState('idle'); if(!info.heard) say('Tap the button when you want to talk to me!',true); return; }
  setState('thinking');
  const seconds=(performance.now()-info.started)/1000;
  const token=++playToken;
  try{
    // 1) the words, hopefully already waiting from live hearing
    let heard=info.live?await Ears.finish(2500):null;
    if(token!==playToken) return;
    if(heard!==null){
      history.push({role:'user',content:heard||'(William said something but it was too quiet or unclear to hear.)'});
      await talkStream({text:heard,heardSeconds:seconds},token);
    }else{
      // 2) the slower way: send the recording up and wait for the whole answer
      const blob=new Blob(chunks,{type:info.mime});
      const ext=info.mime.includes('webm')?'webm':info.mime.includes('ogg')?'ogg':'m4a';
      const fd=new FormData(); fd.append('audio',blob,'speech.'+ext); fd.append('seconds',String(seconds.toFixed(1)));
      fd.append('meta',JSON.stringify({messages:history.slice(-15),minutesLeft:minutesLeft()}));
      const turnP=api('/api/turn',{method:'POST',body:fd}).then(r=>r.json());
      const filler=randomFiller(); const fillerDone=filler?playBuffer(filler,null,{keepThinking:true}):Promise.resolve();
      const {heard:h,say:text,mood}=await turnP;
      if(token!==playToken) return;
      history.push({role:'user',content:h||'(William said something but it was too quiet or unclear to hear.)'});
      history.push({role:'assistant',content:text});
      await fillerDone;
      await speakReply(text,mood,token);
    }
  }catch(e){ console.error(e); if(token!==playToken) return; markActive(false); setState('idle'); say(friendlyError(e),true); }
}

// ---------- Cassie replies ----------
let currentSource=null, playToken=0;
async function cassieReplies(isStart,topic){
  setState('thinking');
  const token=++playToken;
  if(topic) history.push({role:'user',content:'(William tapped the '+topic+' button.)'});
  await talkStream({start:isStart,topic},token);
  loadFillers().then(loadCallouts);
}
// Cassie's words arrive bit by bit; each finished sentence is voiced and played while the next is still being written
async function talkStream(req,token){
  const body=Object.assign({messages:history.slice(-16),minutesLeft:minutesLeft()},req);
  const r=await api('/api/talk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const reader=r.body.getReader(), dec=new TextDecoder();
  const sp=new Speaker(token); let pending='', text='', spoken=0, final=null;
  // a quick "Hmm…" if her first words take a moment
  let fillerTimer=setTimeout(()=>{ if(!sp.started&&token===playToken){ const f=randomFiller(); if(f) sp.filler(f); } },350);
  const cut=()=>{ // hand over every complete sentence
    const m=text.slice(spoken).match(/^([\s\S]{28,}?[.!?…]+["”’)]?)(\s+)(?=\S)/);
    if(m){ spoken+=m[1].length+m[2].length; sp.push(m[1]); say(text); cut(); }
  };
  while(true){
    const {value,done}=await reader.read(); if(done) break;
    if(token!==playToken){ reader.cancel(); sp.stop(); return; }
    pending+=dec.decode(value,{stream:true});
    const lines=pending.split('\n'); pending=lines.pop()||'';
    for(const l of lines){ if(!l.trim()) continue; let j; try{ j=JSON.parse(l); }catch(e){ continue; }
      if(j.mood){ sp.mood=j.mood; if(j.mood!=='front') face().mood(j.mood); }
      if(j.t){ text+=j.t; cut(); }
      if(j.error){ const err=new Error(j.error); err.code=j.error; clearTimeout(fillerTimer); sp.stop(); throw err; }
      if(j.done) final=j; }
  }
  clearTimeout(fillerTimer);
  const full=(final&&final.say)||text;
  if(full.slice(spoken).trim()) sp.push(full.slice(spoken).trim());
  say(full); scrollCaption(Math.max(3,(full.length-spoken)/14)); history.push({role:'assistant',content:full});
  await sp.end();
  if(token!==playToken||state!=='speaking') return;
  face().speaking(false);
  afterReply();
}
function afterReply(){
  if(minutesLeft()<=0) return goToSleep();
  if(S.handsFree){ startListening(true); } else { markActive(false); setState('idle'); }
}
// plays sentences in order, fetching the voice for the next one while the current one plays
class Speaker{
  constructor(token){ this.token=token; this.q=[]; this.playing=null; this.started=false; this.mood='front'; this.ended=false; this.first=true; this.fillerP=null; }
  filler(buf){ if(this.started) return; this.fillerP=playBuffer(buf,null,{keepThinking:true}); }
  push(text){ const item={text,audio:fetchAudio(text,this.mood)}; this.q.push(item); this.pump(); }
  async pump(){
    if(this.playing||!this.q.length) return;
    const item=this.q[0]; this.playing=item;
    try{
      const buf=await item.audio;
      if(this.fillerP){ await this.fillerP; this.fillerP=null; }
      if(this.token!==playToken) return;
      this.started=true;
      await playBuffer(buf,this.first?this.mood:null); this.first=false;
    }catch(e){ console.warn('voice failed',e); }
    this.q.shift(); this.playing=null;
    if(this.q.length) this.pump(); else if(this.ended&&this.done) this.done();
  }
  end(){ this.ended=true; if(!this.playing&&!this.q.length) return Promise.resolve(); return new Promise(res=>{ this.done=res; if(!this.playing) this.pump(); }); }
  stop(){ this.q=[]; this.ended=true; }
}
async function speakReply(text,mood,token){
  const sp=new Speaker(token); sp.mood=mood;
  say(text); scrollCaption(Math.max(3,text.length/14));
  let rest=text; const parts=[];
  while(rest){ const m=rest.match(/^([\s\S]{28,}?[.!?…]+["”’)]?)(\s+)(?=\S)/); if(!m){ parts.push(rest); break; } parts.push(m[1]); rest=rest.slice(m[0].length); }
  parts.forEach(p=>sp.push(p));
  await sp.end();
  if(token!==playToken||state!=='speaking') return;
  face().speaking(false);
  afterReply();
}
function playBuffer(audio,mood,opts={}){
  const ctx=audioCtx();
  const src=ctx.createBufferSource(); src.buffer=audio;
  const an=ctx.createAnalyser(); an.fftSize=512; src.connect(an); an.connect(ctx.destination);
  const buf=new Float32Array(an.fftSize);
  currentSource=src;
  if(!opts.keepThinking){ setState('speaking'); }
  markActive(true);
  const f=face(); f.speaking(true); if(mood&&mood!=='front') f.mood(mood);
  let running=true;
  const loop=()=>{ if(!running) return; an.getFloatTimeDomainData(buf); let s=0; for(let i=0;i<buf.length;i++) s+=buf[i]*buf[i]; f.level(Math.min(1,Math.sqrt(s/buf.length)*4)); requestAnimationFrame(loop); };
  return new Promise(res=>{ src.onended=()=>{ running=false; if(opts.keepThinking){ f.speaking(false); f.mode('thinking'); } if(currentSource===src) currentSource=null; res(); }; src.start(); loop(); });
}
function interrupt(){ playToken++; if(currentSource){ try{ currentSource.onended=null; currentSource.stop(); }catch(e){} currentSource=null; face().speaking(false); } }

// ---------- William talks over her: if he speaks up while she's talking, she stops and listens ----------
let bargeFloor=0, bargeSince=0, bargeCal=0;
setInterval(()=>{
  if(!S.bargeIn||state!=='speaking'||!micAn||!currentSource){ bargeFloor=0; bargeCal=0; bargeSince=0; return; }
  const rms=micLevel(); bargeCal++;
  if(bargeCal<12){ bargeFloor=Math.max(bargeFloor,rms); return; }           // first ~0.5 s: learn how loud her own voice sounds in the mic
  const loud=rms>Math.max(0.045,bargeFloor*2.4);
  if(!loud){ bargeFloor=Math.max(bargeFloor*0.995,rms); bargeSince=0; return; }
  if(!bargeSince) bargeSince=Date.now();
  else if(Date.now()-bargeSince>380){ bargeSince=0; interrupt(); startListening(false,{interrupted:true}); }
},40);

function goToSleep(){ markActive(false); setState('sleeping'); say('That’s all our Cassie time for today. Let’s play again tomorrow!'); }

// ---------- when nobody is talking: be silly, call out once, then get sleepy ----------
let calloutsDone=0;
function playCallout(){
  const list=calloutBufs[S.voice]; if(!list||!list.length||!ac) return false;
  const {t,b}=list[calloutsDone%list.length];
  const src=ac.createBufferSource(); src.buffer=b; const an=ac.createAnalyser(); an.fftSize=512; src.connect(an); an.connect(ac.destination);
  const buf=new Float32Array(an.fftSize), f=face(); let run=true;
  f.speaking(true); f.mood('surprise'); say(t);
  const loop=()=>{ if(!run) return; an.getFloatTimeDomainData(buf); let x=0; for(let i=0;i<buf.length;i++) x+=buf[i]*buf[i]; f.level(Math.min(1,Math.sqrt(x/buf.length)*4)); requestAnimationFrame(loop); };
  src.onended=()=>{ run=false; f.speaking(false); };   // not counted in William's daily time
  src.start(); loop(); return true;
}
setInterval(()=>{
  if(state!=='idle'||document.hidden) return;
  if(!$('parent').hidden||!$('gate').hidden||!$('setup').hidden) return;
  const q=(Date.now()-quietSince)/1000, f=face(); if(!f) return;
  if(idleStage===0&&q>25){ idleStage=1; Math.random()<.5?f.jump():f.rollEyes(); }
  else if(idleStage===1&&q>50){ idleStage=2; if(started&&calloutsDone<2&&playCallout()) calloutsDone++; else f.jump(); }
  else if(idleStage===2&&q>65){ idleStage=3; f.rollEyes(); }
  else if(idleStage===3&&q>90){ idleStage=4; f.mode('sleepy'); say('Zzz… tap me to wake me up!',true); }
},1000);
document.addEventListener('pointerdown',()=>{ if(state==='idle'){ if(idleStage>=4){ face().mode('idle'); say('',true); } quietSince=Date.now(); idleStage=0; } },true);

// ---------- the big button ----------
let started=false;
talkBtn.addEventListener('click',async ()=>{
  audioCtx();
  if(!S.code){ openSetup(); return; }
  if(state==='sleeping'){ say('Cassie is resting. See you tomorrow!',true); face().giggle(); return; }
  if(state==='listening'){ stopListening(); return; }
  if(state==='thinking') return;
  if(state==='speaking'){ interrupt(); return startListening(false); }
  if(minutesLeft()<=0) return goToSleep();
  if(!started){
    started=true;
    try{ await getMic(); }catch(e){ say('Cassie needs the microphone. A grown-up can allow it in Settings.',true); started=false; return; }
    micGraph().then(()=>Ears.connect()).catch(()=>{});
    try{ await cassieReplies(true); }catch(e){ console.error(e); started=false; markActive(false); setState('idle'); say(friendlyError(e),true); }
    return;
  }
  startListening(false);
});
document.querySelectorAll('.topic, .talk').forEach(b=>b.addEventListener('pointerdown',()=>{ b.classList.add('pressed'); setTimeout(()=>b.classList.remove('pressed'),350); }));
document.querySelectorAll('.topic').forEach(b=>b.addEventListener('click',async ()=>{
  audioCtx(); if(!S.code){ openSetup(); return; }
  if(state==='sleeping'||minutesLeft()<=0) return goToSleep();
  if(state==='thinking') return;
  if(state==='listening'){ recInfo&&(recInfo.cancelled=true); stopListening(); }
  interrupt();
  try{ if(!started){ started=true; try{ await getMic(); micGraph().then(()=>Ears.connect()); }catch(e){} }
    await cassieReplies(false,b.dataset.topic); }
  catch(e){ console.error(e); markActive(false); setState('idle'); say(friendlyError(e),true); }
}));
$('cv').addEventListener('click',()=>{ if(state==='idle'||state==='sleeping'){ Math.random()<.4?face().jump():face().giggle(); } });

// ---------- family code ----------
function openSetup(){ $('codeIn').value=S.code; $('setupErr').textContent=''; $('setup').hidden=false; setTimeout(()=>$('codeIn').focus(),50); }
$('setupForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const code=$('codeIn').value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g,''); if(!code) return;
  $('setupErr').textContent='Checking…';
  try{
    const r=await fetch('/api/status',{headers:{'x-cassie-code':code}});
    if(r.status===401){ $('setupErr').textContent='That code isn’t right. Check it and try again.'; return; }
    if(!r.ok) throw new Error('x');
    S.code=code; store.set('code',code); $('setup').hidden=true;
    say('Tap the big button to say hello to Cassie!',true);
  }catch(err){ $('setupErr').textContent='Couldn’t reach Cassie’s server. Check the internet and try again.'; }
});

// ---------- grown-up gate: press and hold, then a sum ----------
const pb=$('parentBtn'); let gateAns=0, taps=[];
// grown-up entry: tap the cog 3 times quickly (iPhone cancels long presses), then answer a sum
pb.addEventListener('click',e=>{
  e.preventDefault();
  const t=Date.now(); taps=taps.filter(x=>t-x<1500); taps.push(t);
  pb.classList.remove('tap1','tap2'); if(taps.length<3) pb.classList.add('tap'+taps.length);
  if(taps.length>=3){ taps=[]; openGate(); }
});
function openGate(){
  const a=6+Math.floor(Math.random()*7), b=5+Math.floor(Math.random()*8);
  const useTimes=Math.random()<.5; gateAns=useTimes?a*b:a+b+10;
  $('gateQ').textContent=useTimes?`What is ${a} × ${b}?`:`What is ${a+10} + ${b}?`;
  $('gateIn').value=''; $('gateErr').textContent=''; $('gate').hidden=false; setTimeout(()=>$('gateIn').focus(),50);
}
$('gateForm').addEventListener('submit',e=>{ e.preventDefault(); if(parseInt($('gateIn').value,10)===gateAns){ $('gate').hidden=true; openParent(); } else $('gateErr').textContent='Not quite. Try again.'; });
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{ b.closest('.sheet').hidden=true; }));

// ---------- parent settings ----------
function setToggle(el,on){ el.setAttribute('aria-checked',on?'true':'false'); }
function chips(el,items,cls){ el.innerHTML=''; if(!items.length){ el.innerHTML='<span class="empty">Nothing yet</span>'; return; } items.forEach(t=>{ const s=document.createElement('span'); s.className='chip'+(cls?' '+cls:''); s.textContent=t; el.appendChild(s); }); }
async function openParent(){
  $('limitIn').value=S.limit; setToggle($('handsFree'),S.handsFree); setToggle($('showWords'),S.showWords); setToggle($('liveEars'),S.liveEars); setToggle($('bargeIn'),S.bargeIn); renderVoices();
  const u=usage(); $('usedToday').textContent=Math.round(u.seconds/60)+' of '+(S.limit+u.bonus)+' min';
  $('parent').hidden=false; $('resetConfirm').hidden=true;
  $('keyStatus').textContent='Checking Cassie’s connection…';
  if(!S.code){ $('keyStatus').textContent='No family code on this device yet.'; return; }
  try{
    const d=await (await api('/api/status')).json();
    $('keyStatus').innerHTML=d.keyReady?'<span class="good">Cassie is connected and ready.</span>':'<span class="err">Cassie isn’t connected yet. Add OPENAI_API_KEY in Netlify, then redeploy.</span>';
    const pct=Math.min(100,(d.month.usd/d.monthlyLimitUsd)*100);
    $('spend').textContent='$'+d.month.usd.toFixed(2)+' of $'+d.monthlyLimitUsd.toFixed(0);
    $('spendBar').style.width=pct+'%';
    const top=o=>Object.entries(o||{}).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k])=>k);
    chips($('pPractised'),top(d.profile.practised)); chips($('pTricky'),top(d.profile.tricky),'tricky'); chips($('pLikes'),(d.profile.likes||[]).slice(-14));
  }catch(e){ $('keyStatus').innerHTML='<span class="err">'+friendlyError(e)+'</span>'; }
}
$('limitIn').addEventListener('change',()=>{ const v=Math.max(5,Math.min(120,parseInt($('limitIn').value,10)||20)); S.limit=v; store.set('limit',v); $('limitIn').value=v; if(state==='sleeping'&&minutesLeft()>0) setState('idle'); });
$('plus10').addEventListener('click',()=>{ const u=usage(); u.bonus+=10; saveUsage(u); $('usedToday').textContent=Math.round(u.seconds/60)+' of '+(S.limit+u.bonus)+' min'; if(state==='sleeping') { setState('idle'); say('',true); } });
$('handsFree').addEventListener('click',()=>{ S.handsFree=!S.handsFree; store.set('handsFree',S.handsFree); setToggle($('handsFree'),S.handsFree); });
$('showWords').addEventListener('click',()=>{ S.showWords=!S.showWords; store.set('showWords',S.showWords); setToggle($('showWords'),S.showWords); applyWords(); });
$('liveEars').addEventListener('click',()=>{ S.liveEars=!S.liveEars; store.set('liveEars',S.liveEars); setToggle($('liveEars'),S.liveEars); if(S.liveEars){ Ears.fails=0; Ears.timeouts=0; } else Ears.close(); });
$('bargeIn').addEventListener('click',()=>{ S.bargeIn=!S.bargeIn; store.set('bargeIn',S.bargeIn); setToggle($('bargeIn'),S.bargeIn); });
const VOICES=[
  ['marin','Marin','OpenAI · soft and natural'],['shimmer','Shimmer','OpenAI · light and bright'],['sage','Sage','OpenAI · calm and kind'],['coral','Coral','OpenAI · warm and friendly'],
  ['nova','Nova','OpenAI · cheerful'],['fable','Fable','OpenAI · storyteller'],['alloy','Alloy','OpenAI · clear'],['ballad','Ballad','OpenAI · soft and dreamy'],
  ['g:en-GB-Chirp3-HD-Aoede','Aoede','Google · British, free'],['g:en-GB-Chirp3-HD-Kore','Kore','Google · British, free'],['g:en-GB-Chirp3-HD-Leda','Leda','Google · British, free'],
  ['g:en-GB-Chirp3-HD-Zephyr','Zephyr','Google · British, free'],['g:en-GB-Chirp3-HD-Sulafat','Sulafat','Google · British, free'],['g:en-GB-Chirp3-HD-Achernar','Achernar','Google · British, free']];
let sampleSrc=null;
function renderVoices(){
  const box=$('voiceList'); box.innerHTML='';
  VOICES.forEach(([id,name,desc])=>{
    const row=document.createElement('div'); row.className='vrow'+(S.voice===id?' on':'');
    row.innerHTML=`<button class="play" type="button" aria-label="Hear ${name}">&#9654;</button><button class="pick" type="button" role="radio" aria-checked="${S.voice===id}"><b>${name}</b><span>${desc}</span></button><span class="tick">${S.voice===id?'Chosen':''}</span>`;
    row.querySelector('.pick').addEventListener('click',()=>{ S.voice=id; store.set('voice',id); renderVoices(); if(started) loadFillers(); });
    const pb=row.querySelector('.play');
    pb.addEventListener('click',async ()=>{
      audioCtx(); if(sampleSrc){ try{ sampleSrc.stop(); }catch(e){} sampleSrc=null; }
      pb.classList.add('busy');
      try{
        const r=await api('/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:`Hello William! It's me, Cassie, your friend in the phone. This is my ${name} voice. Ooh, I've got an idea! Spider-Man needs our help today. He's lost his web somewhere in the city, and we need to find it. Can you think of something that begins with the sound sss? Take your time, I'm listening.`,voice:id})});
        const bytes=await r.arrayBuffer(); const ctx=audioCtx();
        const audio=await new Promise((res,rej)=>ctx.decodeAudioData(bytes,res,rej));
        const src=ctx.createBufferSource(); src.buffer=audio; src.connect(ctx.destination); sampleSrc=src; src.start();
        src.onended=()=>{ if(sampleSrc===src) sampleSrc=null; };
      }catch(e){ $('keyStatus').innerHTML='<span class="err">'+friendlyError(e)+'</span>'; }
      pb.classList.remove('busy');
    });
    box.appendChild(row);
  });
}
$('resetProfile').addEventListener('click',()=>{ $('resetConfirm').hidden=false; });
$('resetNo').addEventListener('click',()=>{ $('resetConfirm').hidden=true; });
$('resetYes').addEventListener('click',async ()=>{ try{ await api('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reset-profile'})}); $('resetConfirm').hidden=true; openParent(); }catch(e){ $('keyStatus').textContent=friendlyError(e); } });
$('changeCode').addEventListener('click',()=>{ $('parent').hidden=true; openSetup(); });

// keep the screen awake while she's chatting
let wake=null; async function keepAwake(){ try{ if('wakeLock' in navigator&&!wake){ wake=await navigator.wakeLock.request('screen'); wake.addEventListener('release',()=>wake=null); } }catch(e){} }
talkBtn.addEventListener('click',keepAwake);
document.addEventListener('visibilitychange',()=>{ if(document.hidden){ stopListening(); Ears.cancel(); interrupt(); markActive(false); if(state!=='sleeping') setState('idle'); } });

// no pinch or double-tap zoom in Safari
document.addEventListener('gesturestart',e=>e.preventDefault(),{passive:false});
document.addEventListener('touchmove',e=>{ if(e.scale&&e.scale!==1) e.preventDefault(); },{passive:false});
let lastTouch=0; document.addEventListener('touchend',e=>{ const n=Date.now(); if(n-lastTouch<300&&!e.target.closest('button,input,select')) e.preventDefault(); lastTouch=n; },{passive:false});

// ---------- start ----------
function boot(){
  if(minutesLeft()<=0) goToSleep(); else setState('idle');
  if(!S.code) openSetup(); else say('Tap the big button to say hello!',true);
}
if(window.CassieFace) boot(); else document.addEventListener('cassie-ready',boot,{once:true});
})();
