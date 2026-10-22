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
  voice:store.get('voice','marin'),
  liveEars:store.get('liveEars',true),
  bargeIn:store.get('bargeIn',true),
  pause:store.get('pause',800),   // how long a quiet gap means he's finished (young children pause mid-sentence)
};
const today=()=>new Date().toLocaleDateString('en-CA');
function usage(){ const u=store.get('usage',{}); return u.date===today()?u:{date:today(),seconds:0,bonus:0}; }
function saveUsage(u){ store.set('usage',u); }
function minutesLeft(){ const u=usage(); return (S.limit+u.bonus)-u.seconds/60; }

// ---------- UI helpers ----------
const talkBtn=$('talk'), label=$('talklabel');
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
// On-screen words are switched off for now: say() only logs, so nothing appears on screen.
function say(text,small){ if(text) console.log('[Cassie]',text); }
// while Cassie talks, gently scroll long captions so the current bit is visible
let capScroll=null;
function scrollCaption(){}

// ---------- timings: how long each step of a turn takes (console + window.cassieTimings; the last one is sent to the server so it shows in Netlify's function logs) ----------
const Tm={cur:null,log:[],last:null,
  begin(kind){ this.cur={kind,at:new Date().toISOString(),t0:performance.now(),m:{}}; },
  mark(k){ if(this.cur&&this.cur.m[k]==null) this.cur.m[k]=Math.round(performance.now()-this.cur.t0); },
  set(k,v){ if(this.cur) this.cur.m[k]=v; },
  end(){ if(!this.cur) return; const r=this.cur; this.cur=null; this.last={kind:r.kind,...r.m}; this.log.push(this.last); this.log=this.log.slice(-30); window.cassieTimings=this.log; console.log('[timing]',r.kind,JSON.stringify(r.m)); },
  take(){ const l=this.last; this.last=null; return l; }
};

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
// how loud the room is when nobody is talking; follows quiet moments quickly and loud ones hardly at all, and carries over between turns
let ambient=0.004;
function trackAmbient(rms,thr){ if(rms<ambient) ambient=ambient*0.7+rms*0.3; else if(rms<thr) ambient=Math.min(0.015,ambient*0.98+rms*0.02); }
function micLevel(){ if(!micAn) return 0; micAn.getFloatTimeDomainData(micBuf); let s=0; for(let i=0;i<micBuf.length;i++) s+=micBuf[i]*micBuf[i]; return Math.sqrt(s/micBuf.length); }

// ---------- live ears: William's voice streams to OpenAI while he talks, so the words are ready the moment he stops ----------
const Ears={
  ws:null, connecting:false, fails:0, timeouts:0, open:false, sending:false, queue:[], preroll:[], text:'', waiters:[], item:null, committed:null, expires:0,
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
    // only the item created by THIS turn's commit counts; a late result from an earlier turn is ignored (it used to be mistaken for the new answer)
    if(m.type==='input_audio_buffer.committed'){ this.committed=m.item_id||null; }
    else if(m.type==='conversation.item.input_audio_transcription.delta'){ if(this.item&&m.item_id&&m.item_id!==this.item) return; this.item=m.item_id||this.item; this.text+=m.delta||''; }
    else if(m.type==='conversation.item.input_audio_transcription.completed'){ if(this.committed&&m.item_id&&m.item_id!==this.committed) return; this.resolve((m.transcript||'').trim()); }
    else if(m.type==='error'){ console.warn('ears error',m.error); const msg=(m.error&&m.error.message)||'';
      if(/buffer.*(empty|too small)|commit_empty/i.test(msg)||(m.error&&/commit_empty|buffer_too_small/.test(m.error.code||''))) this.resolve('');   // nothing was said: don't wait for the timeout
      if(/session|unauthor|token|expired/i.test(msg)) this.close(); }
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
    if(this.ws&&this.open){ if(this.ws.bufferedAmount<512000) this.ws.send(msg); } else if(this.connecting&&this.queue.length<120) this.queue.push(msg);   // ~12 s can queue while the socket opens
  },
  start(withPreroll){
    this.sending=false; this.text=''; this.item=null; this.committed=null; this.resolve(null); this.waiters=[];
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
    return new Promise(res=>{ const done=v=>{ this.timeouts=0; res(v); }; this.waiters.push(done); setTimeout(()=>{ const i=this.waiters.indexOf(done); if(i>=0){ this.waiters.splice(i,1); if(++this.timeouts>=2){ this.fails=9; this.close(); } res(null); } },ms); });   // a timeout only gives up on its own wait
  },
  cancel(){ this.sending=false; this.resolve(null); this.text=''; this.item=null; this.committed=null; if(this.ws&&this.open) try{ this.ws.send(JSON.stringify({type:'input_audio_buffer.clear'})); }catch(e){} },
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
  recInfo={mime:rec.mimeType||mime||'audio/mp4',heard:!!opts.interrupted,started,cancelled:false,quiet:false,maybe:false,live:false,token:playToken,auto:!!auto,nudged:!!opts.nudged};
  keepAwake();
  rec.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
  rec.onstop=()=>onRecorded();
  rec.start(250);
  recInfo.live=Ears.start(!!opts.interrupted);
  setState('listening'); markActive(true);
  if(!auto) say('',true);
  // voice detection: stop after a short pause, or give up if he says nothing
  let lastLoud=opts.interrupted?0:-1, soft=0, lastT=0, loudRun=0;   // soft: ms of gentle sound (a quiet voice), so silence is never sent for transcription
  const tick=()=>{
    if(!rec||rec.state!=='recording') return;
    const rms=micLevel(), t=performance.now()-started;
    const thr=Math.max(0.010,ambient*3);   // his voice must stand out from the room, however quiet the room is
    trackAmbient(rms,thr);
    if(t>=150||opts.interrupted){   // the first 150 ms can still hold the tail of her own voice
      const dt=Math.max(0,Math.min(100,t-lastT));
      if(rms>thr){ if(++loudRun>=3||recInfo.heard){ recInfo.heard=true; lastLoud=t; } soft=0; }   // ~50 ms of sound, so a click doesn't count
      else{ loudRun=0; if(rms>Math.max(0.005,ambient*1.8)){ soft+=dt; if(soft>400) recInfo.maybe=true; } else soft=0; }
      if(recInfo.heard&&t-lastLoud>S.pause) return stopListening();
      if(!recInfo.heard&&t>12000){ recInfo.quiet=true; return stopListening(); }   // the meter heard nothing: still check the live ears before giving up
      if(t>20000) return stopListening();
    }
    lastT=t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopListening(){ if(rec&&rec.state==='recording'){ Tm.begin('turn'); rec.stop(); } }

const saved=store.get('history',null);
const history=(saved&&Array.isArray(saved.m)&&Date.now()-(saved.at||0)<6*3600e3)?saved.m.slice(-40):[];
const resumed=history.length>0;
function remember(m){ history.push(m); store.set('history',{at:Date.now(),m:history.slice(-40)}); }
// the game William picked with a topic button, so Cassie keeps it going over several turns
let activity=null, activityTurns=0;
// a grown-up announcing themselves ("it's Mummy here", "Daddy speaking", "it's Ara") switches Cassie to Parent Mode
let parentMode=false, speaker=null;   // speaker: 'Mummy' | 'Daddy' | null (a grown-up, not sure which)
const tag=()=>parentMode?'('+(speaker||'A grown-up')+' speaking) ':'';
function whoFrom(t){ return /\b(dad|daddy|james)\b/i.test(t)?'Daddy':/\b(mum|mummy|mom|mommy|ara)\b/i.test(t)?'Mummy':null; }
function setParent(on,who){
  const was=parentMode; parentMode=on; if(on){ if(who) speaker=who; } else speaker=null;
  const b=$('pmode'); if(b){ b.dataset.on=on?'true':'false'; b.setAttribute('aria-pressed',on?'true':'false'); }
  if(was&&!on&&started) remember({role:'user',content:'(William is talking to Cassie again now.)'});
}
// Only an explicit announcement switches to Parent Mode: "I'm Mummy", "it's Mummy here", "Mummy speaking", "this is William's mum here".
// NOT "it's Mummy's birthday", "Daddy's here" (he walked in), "William's dad is tall" — those are William talking about his parents.
const GROWN=String.raw`(?:mummy|mommy|mum|mom|daddy|dad|ara|james)`;
const PARENT_ON=new RegExp(String.raw`\b(?:i'?m|i am)\s+(?:william'?s\s+)?${GROWN}\b(?!'s)|\b(?:it'?s|this is)\s+(?:william'?s\s+)?${GROWN}\b(?!'s)[^.?!]{0,6}\b(?:here|speaking|talking)\b|\b${GROWN}\s+(?:speaking|here now)\b|\bparent mode\b`,'i');
const PARENT_OFF=/back to william|william'?s (here|back|turn)|william is (here|back)|over to william/i;
function checkParent(heard){
  if(!heard) return;
  if(parentMode&&PARENT_OFF.test(heard)){ setParent(false); }
  else if(PARENT_ON.test(heard)){ setParent(true,whoFrom(heard)); }
}
// ---------- instant reactions: tiny clips in Cassie's own voice, made once and kept on the phone ----------
const FILLERS=['Hmm…','Let me think…','Oh yeah!','Gotcha!','Aha!','Ha!','Right…','Hmm, let me see…'];
const CALLOUTS=['William? Where did you go?','Hello-o! I’m getting a bit bored. Shall we play a game?','Psst, William! Tap the big button when you want to talk to me!'];
const calloutBufs={};
async function loadCallouts(){ const v=S.voice; if(calloutBufs[v]) return; calloutBufs[v]=[]; for(const t of CALLOUTS){ try{ calloutBufs[v].push({t,b:await fetchAudio(t,'wink',true)}); }catch(e){} } }
// little clips (fillers, call-outs, "I'm still here") are kept on the phone, so they are only ever bought once per voice
const clipDB={
  db:null,
  open(){ if(this.db!==null) return this.db; this.db=new Promise(res=>{ try{ const r=indexedDB.open('cassie-clips',1); r.onupgradeneeded=()=>r.result.createObjectStore('clips'); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); r.onblocked=()=>res(null); }catch(e){ res(null); } }); return this.db; },
  async get(k){ const d=await this.open(); if(!d) return null; return new Promise(res=>{ try{ const q=d.transaction('clips').objectStore('clips').get(k); q.onsuccess=()=>res(q.result||null); q.onerror=()=>res(null); }catch(e){ res(null); } }); },
  async put(k,v){ const d=await this.open(); if(!d) return; try{ d.transaction('clips','readwrite').objectStore('clips').put(v,k); }catch(e){} },
};
const CLIPS={nudge:'I’m still here! Have a little think, then tell me.',tap:'Tap the big purple button when you want to talk to me!',sleep:'That’s all our Cassie time for today. Let’s play again tomorrow!',oops:'Oops, my ears went wonky! Tap the button and say it again.',grownup:'Uh-oh, I need a grown-up to check my settings.'};
const clipBufs={};
async function loadClips(){ const v=S.voice; if(clipBufs[v]) return; clipBufs[v]={}; for(const k in CLIPS){ try{ clipBufs[v][k]=await fetchAudio(CLIPS[k],'gentle',true); }catch(e){} } }
// clips are fetched after the first reply, one at a time, so they never compete with Cassie's own voice for the network
let clipsLoading=null;
function loadAllClips(){ if(clipsLoading) return clipsLoading; return clipsLoading=loadClips().then(loadFillers).then(loadCallouts).catch(()=>{}).finally(()=>{ clipsLoading=null; }); }
async function playClip(k){ const b=(clipBufs[S.voice]||{})[k]; if(!b||!ac) return false; await playBuffer(b,'gentle'); face().speaking(false); return true; }
let errorStreak=0;
function showError(e){ say(friendlyError(e),true); markActive(false); setState('idle');
  const cfg=['wrong-code','no-key','bad-key','budget','no-google-key','bad-google-key'].includes(e&&e.code);
  const tok=playToken;
  playClip(cfg?'grownup':'oops').then(()=>{ if(state==='speaking') setState('idle'); markActive(false);
    // a passing internet wobble shouldn't end the chat: listen again (twice at most in a row)
    if(!cfg&&S.handsFree&&started&&tok===playToken&&++errorStreak<=2&&minutesLeft()>0) startListening(true); }); }
const fillerBufs={};  // voice -> [AudioBuffer]
async function fetchAudio(text,mood,keep){
  const key=S.voice+'|'+(mood||'front')+'|'+text;
  if(keep){ const b=await clipDB.get(key); if(b){ try{ return await new Promise((res,rej)=>audioCtx().decodeAudioData(b.slice(0),res,rej)); }catch(e){} } }
  let lastErr=null;
  for(let go=0;go<2;go++){   // one retry, so a single hiccup doesn't swallow a sentence
    try{
      const r=await api('/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:S.voice,mood:mood||'front'})});
      const bytes=await r.arrayBuffer(); const ctx=audioCtx();
      if(keep) clipDB.put(key,bytes.slice(0));
      return await new Promise((res,rej)=>ctx.decodeAudioData(bytes,res,rej));
    }catch(e){ lastErr=e; if(['wrong-code','no-key','bad-key','budget','no-google-key','bad-google-key'].includes(e.code)) break; await new Promise(r=>setTimeout(r,300)); }
  }
  throw lastErr;
}
async function loadFillers(){
  const v=S.voice; if(fillerBufs[v]) return;
  fillerBufs[v]=[];
  const list=FILLERS.slice().sort(()=>Math.random()-.5);
  for(const t of list){ try{ fillerBufs[v].push(await fetchAudio(t,'think',true)); }catch(e){} }
}
let lastFiller=null;
function randomFiller(){ const l=fillerBufs[S.voice]; if(!l||!l.length) return null; let b; do{ b=l[Math.floor(Math.random()*l.length)]; }while(l.length>1&&b===lastFiller); lastFiller=b; return b; }

// did the ears really hear words (not the odd 'Thank you.' transcription invents out of silence)?
function realWords(t){ if(!t) return false; const w=t.replace(/[^a-z' ]/gi,' ').replace(/\s+/g,' ').trim(); if(w.length<2) return false; return !/^(thank you|thanks|thank you for watching|thanks for watching|you|bye|bye bye|the end|hmm+|mm+|um+|uh+|oh|ah|yeah|so|okay|ok|subtitles by.*|amara org)$/i.test(w); }
async function onRecorded(){
  const info=recInfo, chunks=recChunks.slice(); rec=null; if(!info) return; if(recInfo===info) recInfo=null;
  if(info.cancelled||info.token!==playToken){ Ears.cancel(); if(info.token!==playToken) return; markActive(false); setState('idle'); return; }   // something else (a topic button) has taken over
  let heard=null;
  if(!info.heard){
    // the level meter heard nothing, but he may have spoken softly: ask the live ears before deciding
    if(info.live&&info.maybe){ setState('thinking'); heard=await Ears.finish(2500); Tm.mark('transcript'); if(info.token!==playToken) return; }   // only if the mic saw some gentle sound; pure silence is never transcribed (it invents words)
    else Ears.cancel();
    if(!realWords(heard)){
      heard=null;
      // he didn't say anything: say so out loud (no more silent stops), give him one more go, then rest
      const tok=playToken;
      if(info.auto&&!info.nudged&&minutesLeft()>0){ await playClip('nudge'); if(tok!==playToken) return; return startListening(true,{nudged:true}); }
      await playClip('tap'); if(tok!==playToken) return;
      markActive(false); setState('idle'); return; }
  }
  setState('thinking');
  const seconds=(performance.now()-info.started)/1000;
  const token=++playToken;
  try{
    // 1) the words, hopefully already waiting from live hearing
    if(heard===null&&info.live) heard=await Ears.finish(2500);
    Tm.mark('transcript'); Tm.set('live',heard!==null);
    if(token!==playToken) return;
    if(heard!==null){
      checkParent(heard);
      remember({role:'user',content:tag()+(heard||'(William said something but it was too quiet or unclear to hear.)')});
      await talkStream({text:heard,heardSeconds:seconds},token);
    }else{
      // 2) the slower way: send the recording up and wait for the whole answer
      const blob=new Blob(chunks,{type:info.mime});
      const ext=info.mime.includes('webm')?'webm':info.mime.includes('ogg')?'ogg':'m4a';
      const fd=new FormData(); fd.append('audio',blob,'speech.'+ext); fd.append('seconds',String(seconds.toFixed(1)));
      fd.append('meta',JSON.stringify({messages:history.slice(-30),minutesLeft:minutesLeft(),parent:parentMode,speaker,activity:nextActivity()}));
      const turnP=api('/api/turn',{method:'POST',body:fd}).then(r=>r.json());
      const filler=randomFiller(); let fsrc=null, fstop=null;
      if(filler){ playBuffer(filler,null,{keepThinking:true}); fsrc=currentSource; fstop=currentStop; }   // a quick 'Hmm…' while the slow path runs
      const {heard:h,say:text,mood}=await turnP;
      Tm.mark('turnUpload');
      if(token!==playToken) return;
      if(fsrc&&currentSource===fsrc){ try{ fsrc.onended=null; fsrc.stop(); }catch(e){} if(fstop) fstop(); }   // the answer is here: stop the filler rather than wait for it
      checkParent(h);
      remember({role:'user',content:tag()+(h||'(William said something but it was too quiet or unclear to hear.)')});
      remember({role:'assistant',content:text});
      await speakReply(text,mood,token);
    }
  }catch(e){ console.error(e); if(token!==playToken) return; showError(e); }
}

// ---------- Cassie replies ----------
let currentSource=null, playToken=0;
async function cassieReplies(isStart,topic){
  Tm.begin(isStart?'start':'topic');
  setState('thinking');
  const token=++playToken;
  if(topic){ remember({role:'user',content:'(William tapped the '+topic+' button.)'}); activity=topic; activityTurns=0; }
  if(isStart) activity=null;
  await talkStream({start:isStart,topic,resume:isStart&&resumed},token);
}
// Cassie's words arrive bit by bit; each finished sentence is voiced and played while the next is still being written
async function talkStream(req,token){
  const body=Object.assign({messages:history.slice(-30),minutesLeft:minutesLeft(),parent:parentMode,speaker,activity:req.topic?null:nextActivity(),timings:Tm.take()},req);
  Tm.mark('talkSent');
  const r=await api('/api/talk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const reader=r.body.getReader(), dec=new TextDecoder();
  const sp=new Speaker(token); let pending='', text='', spoken=0, final=null;
  // a quick "Hmm…" if her first words take a moment
  let fillerTimer=setTimeout(()=>{ if(!sp.started&&token===playToken){ const f=randomFiller(); if(f) sp.filler(f); } },350);
  let ended=false;
  const cut=()=>{ // hand over every complete sentence (the first one can be short, so she starts sooner)
    const re=spoken?/^([\s\S]{28,}?[.!?…]+["”’)]?)(\s+)(?=\S)/:/^([\s\S]{8,}?[.!?…]+["”’)]?)(\s+)(?=\S)/;
    const m=text.slice(spoken).match(re);
    if(m){ spoken+=m[1].length+m[2].length; Tm.mark('firstSentence'); sp.push(m[1]); say(text); cut(); }
  };
  const finishText=full=>{ if(ended) return; ended=true; if(full&&full.length>=text.length) text=full; const rest=text.slice(spoken).trim(); if(rest){ sp.push(rest); spoken=text.length; } };
  while(true){
    const {value,done}=await reader.read(); if(done) break;
    if(token!==playToken){ reader.cancel(); sp.stop(); return; }
    pending+=dec.decode(value,{stream:true});
    const lines=pending.split('\n'); pending=lines.pop()||'';
    for(const l of lines){ if(!l.trim()) continue; let j; try{ j=JSON.parse(l); }catch(e){ continue; }
      if(j.mood){ Tm.mark('firstToken'); sp.mood=j.mood; if(j.mood!=='front') face().mood(j.mood); }
      if(j.t){ Tm.mark('firstToken'); text+=j.t; cut(); }
      if(j.error){ const err=new Error(j.error); err.code=j.error; clearTimeout(fillerTimer); sp.stop(); throw err; }
      if(j.end){ Tm.mark('textEnd'); finishText(j.say||text); }   // her words are complete: voice the last bit now, don't wait for the bookkeeping
      if(j.done){ final=j; Tm.mark('done'); if(j.srv) Tm.set('srv',j.srv); } }
  }
  clearTimeout(fillerTimer);
  const full=(final&&final.say)||text;
  if(!ended){ ended=true; if(full.slice(spoken).trim()) sp.push(full.slice(spoken).trim()); }
  say(full); scrollCaption(Math.max(3,(full.length-spoken)/14)); remember({role:'assistant',content:full});
  await sp.end();
  Tm.mark('replyDone'); Tm.end();
  if(token!==playToken) return;   // (before: if her voice failed to load she stayed stuck on "thinking")
  face().speaking(false);
  afterReply();
}
// the chosen game stays "on" for about 10 of William's answers, unless he picks something else
function nextActivity(){ if(!activity) return null; if(++activityTurns>10){ activity=null; return null; } return activity; }
function afterReply(){
  errorStreak=0; setTimeout(loadAllClips,1500);
  if(minutesLeft()<=0) return goToSleep();
  if(S.handsFree){ startListening(true); } else { markActive(false); setState('idle'); }
}
// plays sentences in order, fetching the voice for the next one while the current one plays
class Speaker{
  constructor(token){ this.token=token; this.q=[]; this.playing=null; this.started=false; this.mood='front'; this.ended=false; this.first=true; this.fillerP=null; this.fillerSrc=null; this.fillerStop=null; }
  filler(buf){ if(this.started||this.fillerP) return; Tm.mark('filler'); this.fillerP=playBuffer(buf,null,{keepThinking:true}); this.fillerSrc=currentSource; this.fillerStop=currentStop; }
  push(text){ const item={text,audio:fetchAudio(text,this.mood)}; this.q.push(item); this.pump(); }   // the voice for every sentence is fetched as soon as it is written
  async pump(){
    if(this.playing||!this.q.length) return;
    const item=this.q[0]; this.playing=item;
    try{
      const buf=await item.audio; if(this.first) Tm.mark('firstAudio');
      if(this.fillerP){   // her real words are ready: give the "Hmm…" up to 300 ms to finish, then cut it
        await Promise.race([this.fillerP,new Promise(r=>setTimeout(r,300))]);
        if(this.fillerSrc&&currentSource===this.fillerSrc){ try{ this.fillerSrc.onended=null; this.fillerSrc.stop(); }catch(e){} if(this.fillerStop) this.fillerStop(); }
        this.fillerP=null; this.fillerSrc=null; this.fillerStop=null;
      }
      if(this.token!==playToken) return;
      this.started=true; if(this.first) Tm.mark('firstWord');
      await playBuffer(buf,this.first?this.mood:null); this.first=false;
    }catch(e){ console.warn('voice failed',e); }
    finally{ this.q.shift(); this.playing=null; if(this.token===playToken&&this.q.length) this.pump(); else if(this.ended&&this.done){ const d=this.done; this.done=null; d(); } }
  }
  end(){ this.ended=true; if(!this.playing&&!this.q.length) return Promise.resolve(); return new Promise(res=>{ this.done=res; if(!this.playing) this.pump(); }); }
  stop(){ this.q=[]; this.ended=true; if(this.done){ const d=this.done; this.done=null; d(); } }
}
async function speakReply(text,mood,token){
  const sp=new Speaker(token); sp.mood=mood;
  say(text); scrollCaption(Math.max(3,text.length/14));
  let rest=text; const parts=[];
  while(rest){ const m=rest.match(/^([\s\S]{28,}?[.!?…]+["”’)]?)(\s+)(?=\S)/); if(!m){ parts.push(rest); break; } parts.push(m[1]); rest=rest.slice(m[0].length); }
  parts.forEach(p=>sp.push(p));
  await sp.end();
  if(token!==playToken) return;
  face().speaking(false);
  afterReply();
}
// loudness of a clip every 25 ms, worked out from the sound itself (so the mouth always matches, on every phone)
function envelope(audio){
  if(audio.__env) return audio.__env;
  const d=audio.getChannelData(0), step=Math.max(1,Math.floor(audio.sampleRate*0.025)), env=[];
  for(let i=0;i<d.length;i+=step){ let s=0; const n=Math.min(step,d.length-i); for(let j=0;j<n;j+=4) s+=d[i+j]*d[i+j]; env.push(Math.sqrt(s/(n/4))); }
  return audio.__env=env;
}
function playBuffer(audio,mood,opts={}){
  const ctx=audioCtx();
  const src=ctx.createBufferSource(); src.buffer=audio; src.connect(ctx.destination);
  const env=envelope(audio);
  currentSource=src;
  if(!opts.keepThinking){ setState('speaking'); }
  markActive(true);
  const f=face(); f.speaking(true); if(mood&&mood!=='front') f.mood(mood);
  let running=true; const t0=ctx.currentTime;
  const loop=()=>{ if(!running) return; const i=Math.floor((ctx.currentTime-t0)/0.025); f.level(Math.min(1,(env[i]||0)*4)); requestAnimationFrame(loop); };
  return new Promise(res=>{
    const finish=()=>{ if(!running) return; running=false; f.level(0); if(opts.keepThinking){ f.speaking(false); f.mode('thinking'); } if(currentSource===src){ currentSource=null; currentStop=null; } res(); };
    src.onended=finish; currentStop=finish;   // interrupt() also calls finish, so no old mouth loop keeps running
    src.start(); loop();
  });
}
let currentStop=null;
function interrupt(){ playToken++; if(currentSource){ const src=currentSource, stop=currentStop; currentSource=null; currentStop=null; try{ src.onended=null; src.stop(); }catch(e){} if(stop) stop(); face().speaking(false); } }

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

let sleptSaid=false;
function goToSleep(){ markActive(false); setState('sleeping'); say(CLIPS.sleep);
  if(!sleptSaid){ sleptSaid=true; const b=(clipBufs[S.voice]||{}).sleep; if(b&&ac){ const src=ac.createBufferSource(); src.buffer=b; src.connect(ac.destination); src.start(); } } }

// ---------- when nobody is talking: be silly, call out once, then get sleepy ----------
let calloutsDone=0;
function playCallout(){
  const list=calloutBufs[S.voice]; if(!list||!list.length||!ac) return false;
  const {t,b}=list[calloutsDone%list.length];
  const src=ac.createBufferSource(); src.buffer=b; src.connect(ac.destination);
  const env=envelope(b), f=face(); let run=true; const t0=ac.currentTime;
  f.speaking(true); f.mood('surprise'); say(t);
  const loop=()=>{ if(!run) return; const i=Math.floor((ac.currentTime-t0)/0.025); f.level(Math.min(1,(env[i]||0)*4)); requestAnimationFrame(loop); };
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
    try{ await cassieReplies(true); }catch(e){ console.error(e); started=false; showError(e); }
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
  catch(e){ console.error(e); showError(e); }
}));
// small grown-up button next to the talk button: tap to talk as Mummy or Daddy, tap again for William
$('pmode').addEventListener('pointerdown',()=>{ const b=$('pmode'); b.classList.add('pressed'); setTimeout(()=>b.classList.remove('pressed'),350); });
$('pmode').addEventListener('click',async ()=>{
  audioCtx(); if(!S.code){ openSetup(); return; }
  setParent(!parentMode,null);
  if(!started||state==='sleeping'||state==='thinking') return;   // first tap of the big button will greet the grown-up
  if(state==='listening'){ recInfo&&(recInfo.cancelled=true); stopListening(); }
  interrupt();
  if(parentMode) startListening(false); else { try{ await cassieReplies(false); }catch(e){ showError(e); } }
});
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
  $('limitIn').value=S.limit; setToggle($('handsFree'),S.handsFree); setToggle($('liveEars'),S.liveEars); setToggle($('bargeIn'),S.bargeIn); renderVoices();
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
    row.querySelector('.pick').addEventListener('click',()=>{ S.voice=id; store.set('voice',id); renderVoices(); if(started) loadAllClips(); });
    const pb=row.querySelector('.play');
    pb.addEventListener('click',async ()=>{
      audioCtx(); if(sampleSrc){ try{ sampleSrc.stop(); }catch(e){} sampleSrc=null; }
      pb.classList.add('busy');
      try{
        const r=await api('/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:`Hello William! It's me, Cassie, your friend in the phone. This is my ${name} voice. I've got an idea! Loly and Pop the guinea pigs are hungry, and Pop will only eat things that begin with the sound sss. Can you think of something? Take your time, I'm listening.`,voice:id})});
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
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) keepAwake(); if(document.hidden){ stopListening(); Ears.cancel(); interrupt(); markActive(false); if(state!=='sleeping') setState('idle'); } });

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
