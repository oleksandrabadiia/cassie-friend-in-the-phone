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
  voice:store.get('voice','coral'),
};
const today=()=>new Date().toLocaleDateString('en-CA');
function usage(){ const u=store.get('usage',{}); return u.date===today()?u:{date:today(),seconds:0,bonus:0}; }
function saveUsage(u){ store.set('usage',u); }
function minutesLeft(){ const u=usage(); return (S.limit+u.bonus)-u.seconds/60; }

// ---------- UI helpers ----------
const talkBtn=$('talk'), label=$('talklabel'), caption=$('caption');
const LABELS={idle:'Talk',listening:'I’m listening…',thinking:'Hmm…',speaking:'',sleeping:'Cassie is resting'};
let state='idle';
function setState(s){
  state=s; talkBtn.dataset.state=s; label.textContent=LABELS[s]??'';
  talkBtn.setAttribute('aria-label', s==='listening'?'Stop and send':s==='speaking'?'Interrupt Cassie':'Talk to Cassie');
  const f=face(); if(!f) return;
  if(s==='listening') f.mode('listening');
  else if(s==='thinking') f.mode('thinking');
  else if(s==='sleeping') f.mode('sleepy');
  else if(s==='idle') f.mode('idle');
}
function say(text,small){ caption.classList.toggle('small',!!small); caption.textContent=(S.showWords||small)?text:''; }

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
    case 'openai-limit': return 'Cassie needs a little rest. Try again in a minute.';
    default: return 'Oops, Cassie couldn’t hear the internet. Try again!';
  }
}

// ---------- audio: one AudioContext, unlocked by the first tap ----------
let ac=null, micStream=null;
function audioCtx(){ if(!ac){ const C=window.AudioContext||window.webkitAudioContext; ac=new C(); } if(ac.state==='suspended') ac.resume(); return ac; }

// ---------- active-time tracking for the daily limit ----------
let activeSince=null;
function markActive(on){
  const u=usage();
  if(on&&activeSince==null) activeSince=Date.now();
  if(!on&&activeSince!=null){ u.seconds+=(Date.now()-activeSince)/1000; activeSince=null; saveUsage(u); }
}
setInterval(()=>{ if(activeSince!=null){ const u=usage(); u.seconds+=(Date.now()-activeSince)/1000; activeSince=Date.now(); saveUsage(u); } },5000);

// ---------- listening ----------
let rec=null, recChunks=[], recInfo=null;
function pickMime(){
  const opts=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg'];
  for(const m of opts){ try{ if(window.MediaRecorder&&MediaRecorder.isTypeSupported(m)) return m; }catch(e){} }
  return '';
}
async function getMic(){
  if(micStream&&micStream.getTracks().some(t=>t.readyState==='live')) return micStream;
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  return micStream;
}
async function startListening(auto){
  if(minutesLeft()<=0){ return goToSleep(); }
  let stream;
  try{ stream=await getMic(); }
  catch(e){ setState('idle'); say('Cassie needs the microphone. A grown-up can allow it in Settings.',true); return; }
  const ctx=audioCtx();
  const src=ctx.createMediaStreamSource(stream), an=ctx.createAnalyser(); an.fftSize=1024; src.connect(an);
  const buf=new Float32Array(an.fftSize);
  const mime=pickMime();
  try{ rec=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream); }catch(e){ rec=new MediaRecorder(stream); }
  recChunks=[]; const started=performance.now();
  recInfo={mime:rec.mimeType||mime||'audio/mp4',heard:false,started,cancelled:false};
  rec.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
  rec.onstop=()=>{ try{ src.disconnect(); }catch(e){} onRecorded(); };
  rec.start(250);
  setState('listening'); markActive(true);
  if(!auto) say('',true);
  // voice detection: stop after a pause, or give up if he says nothing
  let noise=0.01, n=0, lastLoud=0;
  const tick=()=>{
    if(!rec||rec.state!=='recording') return;
    an.getFloatTimeDomainData(buf); let s=0; for(let i=0;i<buf.length;i++) s+=buf[i]*buf[i];
    const rms=Math.sqrt(s/buf.length), t=performance.now()-started;
    if(t<350){ noise=(noise*n+rms)/(++n); }
    else{
      const thr=Math.max(0.018,noise*3);
      if(rms>thr){ recInfo.heard=true; lastLoud=t; }
      if(recInfo.heard&&t-lastLoud>1400) return stopListening();
      if(!recInfo.heard&&t>(auto?7000:9000)){ recInfo.cancelled=true; return stopListening(); }
      if(t>20000) return stopListening();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopListening(){ if(rec&&rec.state==='recording') rec.stop(); }

const history=[];
async function onRecorded(){
  const info=recInfo, chunks=recChunks; rec=null;
  if(info.cancelled||!info.heard){ markActive(false); setState('idle'); if(!info.heard) say('Tap the button when you want to talk to me!',true); return; }
  setState('thinking');
  const blob=new Blob(chunks,{type:info.mime});
  const ext=info.mime.includes('webm')?'webm':info.mime.includes('ogg')?'ogg':'m4a';
  const seconds=(performance.now()-info.started)/1000;
  try{
    const fd=new FormData(); fd.append('audio',blob,'speech.'+ext); fd.append('seconds',String(seconds.toFixed(1)));
    const r=await api('/api/hear',{method:'POST',body:fd}); const {text}=await r.json();
    history.push({role:'user',content:text||'(William said something but it was too quiet or unclear to hear.)'});
    await cassieReplies(false);
  }catch(e){ console.error(e); markActive(false); setState('idle'); say(friendlyError(e),true); }
}

// ---------- Cassie replies ----------
let currentSource=null;
async function cassieReplies(isStart){
  setState('thinking');
  const r=await api('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history.slice(-16),minutesLeft:minutesLeft(),start:isStart})});
  const {say:text,mood}=await r.json();
  history.push({role:'assistant',content:text});
  await speak(text,mood);
}
async function speak(text,mood){
  const r=await api('/api/speak',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice:S.voice})});
  const bytes=await r.arrayBuffer();
  const ctx=audioCtx();
  const audio=await new Promise((res,rej)=>ctx.decodeAudioData(bytes,res,rej));
  const src=ctx.createBufferSource(); src.buffer=audio;
  const an=ctx.createAnalyser(); an.fftSize=512; src.connect(an); an.connect(ctx.destination);
  const buf=new Float32Array(an.fftSize);
  currentSource=src;
  say(text);
  setState('speaking'); markActive(true);
  const f=face(); f.speaking(true); if(mood&&mood!=='front') f.mood(mood);
  let running=true;
  const loop=()=>{ if(!running) return; an.getFloatTimeDomainData(buf); let s=0; for(let i=0;i<buf.length;i++) s+=buf[i]*buf[i]; f.level(Math.min(1,Math.sqrt(s/buf.length)*4)); requestAnimationFrame(loop); };
  await new Promise(res=>{ src.onended=res; src.start(); loop(); });
  running=false; f.speaking(false); currentSource=null;
  if(state!=='speaking') return;      // interrupted
  if(minutesLeft()<=0) return goToSleep();
  if(S.handsFree){ startListening(true); } else { markActive(false); setState('idle'); }
}
function interrupt(){ if(currentSource){ try{ currentSource.onended=null; currentSource.stop(); }catch(e){} currentSource=null; face().speaking(false); } }

function goToSleep(){ markActive(false); setState('sleeping'); say('That’s all our Cassie time for today. Let’s play again tomorrow!'); }

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
    try{ await cassieReplies(true); }catch(e){ console.error(e); started=false; markActive(false); setState('idle'); say(friendlyError(e),true); }
    return;
  }
  startListening(false);
});
$('cv').addEventListener('click',()=>{ if(state==='idle'||state==='sleeping') face().giggle(); });

// ---------- family code ----------
function openSetup(){ $('codeIn').value=S.code; $('setupErr').textContent=''; $('setup').hidden=false; setTimeout(()=>$('codeIn').focus(),50); }
$('setupForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const code=$('codeIn').value.trim().toLowerCase(); if(!code) return;
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
const pb=$('parentBtn'); let holdT=null, gateAns=0;
const startHold=e=>{ e.preventDefault(); pb.classList.add('holding'); holdT=setTimeout(()=>{ pb.classList.remove('holding'); openGate(); },1600); };
const endHold=()=>{ pb.classList.remove('holding'); clearTimeout(holdT); };
pb.addEventListener('pointerdown',startHold); ['pointerup','pointerleave','pointercancel'].forEach(ev=>pb.addEventListener(ev,endHold));
pb.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' ') openGate(); });
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
  $('limitIn').value=S.limit; setToggle($('handsFree'),S.handsFree); setToggle($('showWords'),S.showWords); $('voiceSel').value=S.voice;
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
$('showWords').addEventListener('click',()=>{ S.showWords=!S.showWords; store.set('showWords',S.showWords); setToggle($('showWords'),S.showWords); });
$('voiceSel').addEventListener('change',()=>{ S.voice=$('voiceSel').value; store.set('voice',S.voice); });
$('tryVoice').addEventListener('click',async ()=>{ audioCtx(); try{ $('parent').hidden=true; await speak('Hello William! It’s Cassie. Do you like this voice?','happy'); }catch(e){ say(friendlyError(e),true); } });
$('resetProfile').addEventListener('click',()=>{ $('resetConfirm').hidden=false; });
$('resetNo').addEventListener('click',()=>{ $('resetConfirm').hidden=true; });
$('resetYes').addEventListener('click',async ()=>{ try{ await api('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reset-profile'})}); $('resetConfirm').hidden=true; openParent(); }catch(e){ $('keyStatus').textContent=friendlyError(e); } });
$('changeCode').addEventListener('click',()=>{ $('parent').hidden=true; openSetup(); });

// keep the screen awake while she's chatting
let wake=null; async function keepAwake(){ try{ if('wakeLock' in navigator&&!wake){ wake=await navigator.wakeLock.request('screen'); wake.addEventListener('release',()=>wake=null); } }catch(e){} }
talkBtn.addEventListener('click',keepAwake);
document.addEventListener('visibilitychange',()=>{ if(document.hidden){ stopListening(); interrupt(); markActive(false); if(state!=='sleeping') setState('idle'); } });

// ---------- start ----------
function boot(){
  if(minutesLeft()<=0) goToSleep(); else setState('idle');
  if(!S.code) openSetup(); else say('Tap the big button to say hello!',true);
}
if(window.CassieFace) boot(); else document.addEventListener('cassie-ready',boot,{once:true});
})();
