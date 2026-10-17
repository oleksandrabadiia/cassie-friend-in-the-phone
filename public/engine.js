(function(){
const G={"W": 520, "H": 470, "face": {"cx": 269.5931701660156, "cy": 298.3185119628906, "w": 262.4246520996094, "h": 280.4004821777344, "a": 158.451416015625, "bottom": 463, "left": 28, "right": 501, "top": 29}, "frames": {"talk": {"eyes": [{"cx": 193.63294982910156, "cy": 302.455078125, "rx": 42.57811737060547, "ry": 50.169559478759766, "ang": 4.42592191696167, "pupil": {"x": 189, "y": 275, "w": 47, "h": 47, "cx": 212.72413793103448, "cy": 298.6853448275862, "r": 17.186959427966244}, "side": "L"}, {"cx": 334.0859375, "cy": 275.1626892089844, "rx": 40.75178146362305, "ry": 52.12907028198242, "ang": -16.913345336914062, "pupil": {"x": 327, "y": 245, "w": 45, "h": 45, "cx": 349.7733990147783, "cy": 267.9064039408867, "r": 16.07692842495848}, "side": "R"}], "face": {"x": 21, "y": 35, "w": 475, "h": 435}, "hairL": {"x": 23, "y": 227, "w": 188, "h": 243}, "hairR": {"x": 329, "y": 227, "w": 165, "h": 236}}}, "mouths": {"o": {"x": 240, "y": 343, "w": 65, "h": 66}, "line": {"x": 237, "y": 362, "w": 71, "h": 30}, "smile": {"x": 225, "y": 342, "w": 91, "h": 61}, "frown": {"x": 241, "y": 359, "w": 69, "h": 39}}, "turn_q_left": {"x": 54, "y": 38, "w": 421, "h": 426}, "turn_q_right": {"x": 64, "y": 23, "w": 401, "h": 441}, "shadow": {"x": 0, "y": 0, "w": 520, "h": 550}};      // hair, shadow, turn frames
const SRC={"face_talk": "/img/face_talk.webp", "hairL_talk": "/img/hairL_talk.webp", "hairR_talk": "/img/hairR_talk.webp", "pupil_talkL": "/img/pupil_talkL.webp", "pupil_talkR": "/img/pupil_talkR.webp", "turn_q_left": "/img/turn_q_left.webp", "turn_q_right": "/img/turn_q_right.webp", "shadow": "/img/shadow.webp", "mouth_o": "/img/mouth_o.webp", "mouth_line": "/img/mouth_line.webp", "mouth_smile": "/img/mouth_smile.webp", "mouth_frown": "/img/mouth_frown.webp"};
const $=id=>document.getElementById(id);
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const VIEW={x:0,y:0,w:G.W,h:G.H+40};
const img={};
Promise.all(Object.entries(SRC).map(([k,s])=>new Promise(res=>{const i=new Image();i.onload=()=>{img[k]=i;res();};i.onerror=res;i.src=s;}))).then(start);
const cv=$('cv'),stage=$('stage'); let ctx=cv.getContext('2d');
let S=1;
function resize(){
  const r=stage.getBoundingClientRect(), sc=Math.min(r.width/VIEW.w,r.height/VIEW.h);
  const cw=Math.floor(VIEW.w*sc),ch=Math.floor(VIEW.h*sc),dpr=Math.min(2,devicePixelRatio||1);
  cv.style.width=cw+'px';cv.style.height=ch+'px';cv.width=Math.round(cw*dpr);cv.height=Math.round(ch*dpr);S=cv.width/VIEW.w;
}
addEventListener('resize',resize);
const rad=d=>d*Math.PI/180;

// ---------- expressions: each is a real face from the sheet ----------
const F=G.frames;
let mode='idle',speaking=false,exp='happy',prevExp='happy',expFade=1;
let turn=null,turnA=0,turnT=0;
let blinkAnim=null,mouthShape='smile';
let float=0,floatAmp=4,tilt=0,tiltT=0;
const hair={L:{x:0,v:0,ph:0},R:{x:0,v:0,ph:1.7}};
const pup={L:{x:0,y:0,vx:0,vy:0},R:{x:0,y:0,vx:0,vy:0}};
let wander={x:0,y:0};
let prevTilt=0,prevFloat=0,prevVel=0,lastAct=performance.now();
// one head for everything: expressions only change pupils, eyelids and mouth
const EXP={
  happy:   {look:[.35,-.35], mouth:'smile', lid:0,   lidL:0, p:1},
  front:   {look:[0,.05],    mouth:'smile', lid:0,   lidL:0, p:1},
  think:   {look:[-.55,-.8], mouth:'frown', lid:.14, lidL:0, p:1},
  surprise:{look:[0,0],      mouth:'o',     lid:0,   lidL:0, p:.8},
  tired:   {look:[0,.45],    mouth:'line',  lid:.5,  lidL:0, p:1},
  wink:    {look:[.25,-.55], mouth:'smile', lid:0,   lidL:0, p:1},
};
let lidV=0,lidLV=0,pS=1;
function frameKey(){ return 'talk'; }
function setExp(e){ exp=e; }
function setMode(m){
  mode=m; lastAct=performance.now();
  if(m==='listening'){ setExp('front'); tiltT=5; }
  else if(m==='thinking'){ setExp('think'); tiltT=-5; }
  else if(m==='surprised'){ setExp('surprise'); tiltT=0; }
  else if(m==='talking'){ tiltT=2; }
  else if(m==='wink'){ setExp('wink'); tiltT=4; }
  else if(m==='bored'||m==='sleepy'){ setExp('tired'); tiltT=-2; }
  else { setExp('happy'); tiltT=0; }
}
function idleLife(){
  const t=performance.now();
  if(mode==='idle'){
    if(false) setMode('bored');
    else{
      const r=Math.random();
      if(r<.28){ setExp('front'); setTimeout(()=>{ if(mode==='idle') setExp('happy'); },1800+Math.random()*1600); }
      else if(r<.45&&!speaking) startTurn(Math.random()<.5?'turn_q_left':'turn_q_right');
      else if(r<.8){ wander={x:(Math.random()-.5)*.7,y:(Math.random()-.5)*.5}; setTimeout(()=>wander={x:0,y:0},1300); }
    }
  }
  setTimeout(idleLife,2400+Math.random()*2800);
}
function startTurn(k){ if(turn) return; turn=k; turnT=1; setTimeout(()=>{ turnT=0; setTimeout(()=>{ if(turnT===0) turn=null; },400); },1300+Math.random()*700); }
function blink(){ if(blinkAnim) return; const t0=performance.now();
  blinkAnim=t=>{const d=t-t0; if(d<80) return d/80; if(d<120) return 1; if(d<240) return 1-(d-120)/120; blinkAnim=null; return 0;}; }
function scheduleBlink(){ setTimeout(()=>{ blink(); if(Math.random()<.18) setTimeout(blink,300); scheduleBlink(); },1800+Math.random()*3600); }
let jumpT0=-1, rollT0=-1;
let flapTimer=null, extMouth=false, lastShape=0;
function mouthFromLevel(v){ const t=performance.now(); if(t-lastShape<70) return; lastShape=t; const ns=v<.06?'smile':v<.22?'line':'o'; if(ns!==mouthShape&&ns==='o'&&Math.random()<.4){ for(const s of 'LR'){ pup[s].vx+=(Math.random()-.5)*2.4; pup[s].vy+=(Math.random()-.5)*2.4; } } mouthShape=ns; }
function flap(){
  if(!speaking){ mouthShape='smile'; return; }
  const r=Math.random(); mouthShape=r<.45?'o':r<.75?'line':'smile';
  if(Math.random()<.35){ for(const s of 'LR'){ pup[s].vx+=(Math.random()-.5)*3; pup[s].vy+=(Math.random()-.5)*3; } }
  flapTimer=setTimeout(flap,110+Math.random()*100);
}
const rest=(k,i)=>{ const e=F[k].eyes[i]; return {x:e.pupil.cx-e.cx,y:e.pupil.cy-e.cy}; };
function ellipse(e,pad){ ctx.beginPath(); ctx.ellipse(e.cx,e.cy,e.rx+pad,e.ry+pad,rad(e.ang),0,Math.PI*2); }
function drawEyes(k,lidAll){
  const fr=F[k]; if(!fr.eyes) return;
  fr.eyes.forEach((e,i)=>{
    const q=pup[e.side], p=e.pupil, im=img['pupil_'+k+e.side];
    ctx.save(); ellipse(e,-1); ctx.clip();
    ctx.translate(e.cx+q.x,e.cy+q.y); ctx.scale(pS,pS); ctx.drawImage(im,-(p.cx-p.x),-(p.cy-p.y),p.w,p.h);
    ctx.restore();
  });
}
const hairCv={};
function drawHair(k,side,off,t){
  const im=img['hair'+side+'_'+k],L=F[k]['hair'+side]; if(!im) return;
  const pad=24, key=k+side; let o=hairCv[key];
  const W=Math.ceil((L.w+pad*2)*S),H=Math.ceil(L.h*S);
  if(!o||o.width!==W||o.height!==H){ o=hairCv[key]=document.createElement('canvas'); o.width=W; o.height=H; }
  const c=o.getContext('2d'); c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,W,H);
  for(let r=0;r<H;r+=2){
    const y=r/S,f=Math.pow(y/L.h,1.6), ripple=reduce?0:Math.sin(t*2.1+y*0.05+hair[side].ph)*.8*f;
    c.drawImage(im,0,y,L.w,2/S,Math.round((pad+off*f+ripple)*S),r,Math.round(L.w*S),2);
  }
  ctx.drawImage(o,L.x-pad,L.y,W/S,H/S);
}
// draw one whole face frame into an offscreen layer, so crossfades never show parts through each other
const layer=document.createElement('canvas'), lctx=layer.getContext('2d');
function drawFrame(k,lid,t){
  const L=F[k].face; ctx.drawImage(img['face_'+k],L.x,L.y,L.w,L.h);
  drawEyes(k,lid);
  { const ms=speaking?mouthShape:EXP[exp].mouth, M=G.mouths[ms]; ctx.drawImage(img['mouth_'+ms],M.x,M.y,M.w,M.h); }
  drawHair(k,'L',hair.L.x,t); drawHair(k,'R',hair.R.x,t);
}
let last=performance.now();
function frame(t){
  const dt=Math.min(50,t-last)/16.67; last=t;
  const k=(a,b,s)=>a+(b-a)*Math.min(1,s*dt);
  const s=t/1000;
  expFade=Math.min(1,expFade+0.14*dt);
  turnA=k(turnA,turnT,.22);
  const showTurn=turn&&turnA>.5, squish=1-0.07*Math.sin(Math.PI*Math.min(1,turnA*(1-turnA)*4)/2);
  const E=EXP[exp]; lidV=k(lidV,E.lid,.12); lidLV=k(lidLV,E.lidL,.3); pS=k(pS,E.p,.15); const lid=0;
  floatAmp=k(floatAmp,reduce?0:(speaking?11:4),.05);
  float=Math.sin(s*(speaking?3.2:1.6))*floatAmp-(speaking?6:0)*(floatAmp/11);
  let jsq=1;
  if(jumpT0>=0){ const p=(t-jumpT0)/1000;
    if(p<0.12){ jsq=1-0.10*(p/0.12); }                                   // crouch
    else if(p<0.62){ const q=(p-0.12)/0.5; float-=Math.sin(Math.PI*q)*70; jsq=1+0.06*Math.sin(Math.PI*q); }  // jump
    else if(p<0.8){ const q=(p-0.62)/0.18; jsq=1-0.12*Math.sin(Math.PI*q); }  // squash on landing
    else jumpT0=-1; }
  if(rollT0>=0){ const p=(t-rollT0)/1000;
    if(p<1.6){ const a=p*Math.PI*2*1.5; for(const sd of 'LR'){ const k=sd==='L'?1:-1; pup[sd].vx+=Math.cos(a*k)*1.6*dt; pup[sd].vy+=Math.sin(a)*1.6*dt; } }
    else rollT0=-1; }
  tilt=k(tilt,tiltT,.06);
  const ang=tilt+(reduce?0:Math.sin(s*.9)*1.2);
  const dT=ang-prevTilt, vel=float-prevFloat, acc=vel-prevVel; prevTilt=ang; prevFloat=float; prevVel=vel;
  for(const side of ['L','R']){
    const h=hair[side];
    const force=((reduce?0:Math.sin(s*1.25+h.ph)*1.6)-h.x)*0.07-dT*2.5+(side==='L'?1:-1)*vel*.3;
    h.v=(h.v+force*dt)*Math.pow(0.88,dt); h.x=Math.max(-5,Math.min(5,h.x+h.v*dt));
  }
  const cur=frameKey();
  // googly pupils: springs pulled toward where she looks, shaken by her floating
  if(F[cur].eyes){
    F[cur].eyes.forEach((e,i)=>{
      const q=pup[e.side], pr=e.pupil.r*pS, ax=Math.max(4,e.rx-pr-4), ay=Math.max(4,e.ry-pr-4);
      const lk=speaking?[0,.05]:E.look; const tx=(lk[0]+wander.x)*ax, ty=(lk[1]+wander.y)*ay;
      const stiff=speaking?.10:.16, damp=speaking?.80:.72;
      q.vx+=((tx-q.x)*stiff-dT*1.5)*dt; q.vy+=((ty-q.y)*stiff+acc*(speaking?2.2:1))*dt;
      q.vx*=Math.pow(damp,dt); q.vy*=Math.pow(damp,dt); q.x+=q.vx*dt; q.y+=q.vy*dt;
      const n=Math.hypot(q.x/ax,q.y/ay); if(n>1){ q.x/=n; q.y/=n; q.vx*=-.4; q.vy*=-.4; }
    });
  }
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,cv.width,cv.height);
  ctx.setTransform(S,0,0,S,-VIEW.x*S,-VIEW.y*S);
  const lift=Math.max(0,-float);
  ctx.save(); ctx.globalAlpha=Math.max(.45,1-lift*.03);
  const cxs=G.face.cx,bys=G.H-8; ctx.translate(cxs,bys); ctx.scale(1-lift*.012,1-lift*.012); ctx.translate(-cxs,-bys);
  ctx.drawImage(img.shadow,0,0); ctx.restore();
  // render the head into an offscreen layer per frame, then composite (clean crossfades)
  if(layer.width!==cv.width||layer.height!==cv.height){ layer.width=cv.width; layer.height=cv.height; }
  const head=(key,alpha)=>{
    const main=ctx; lctx.setTransform(1,0,0,1,0,0); lctx.clearRect(0,0,layer.width,layer.height);
    lctx.setTransform(S,0,0,S,-VIEW.x*S,-VIEW.y*S);
    ctx=lctx;
    ctx.translate(G.face.cx,G.H-10+float); ctx.rotate(rad(ang)); ctx.scale(squish*(2-jsq),jsq); ctx.translate(-G.face.cx,-(G.H-10));
    if(key.startsWith('turn_')){ const L=G[key]; ctx.drawImage(img[key],L.x,L.y,L.w,L.h); } else drawFrame(key,lid,s);
    ctx=main; ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha=alpha; ctx.drawImage(layer,0,0); ctx.restore();
  };
  if(showTurn) head(turn,1);
  else head('talk',1);
  requestAnimationFrame(frame);
}
function start(){ resize(); setMode('idle'); setTimeout(idleLife,2500); requestAnimationFrame(frame); document.dispatchEvent(new Event('cassie-ready')); }
window.CassieFace={
  mode:m=>setMode(m),
  mood:m=>{ if(EXP[m]) setExp(m); },
  speaking:on=>{ speaking=on; if(on){ setMode('talking'); } else { mouthShape='smile'; setMode('idle'); } },
  level:v=>mouthFromLevel(v),
  jump:()=>{ if(reduce) return; jumpT0=performance.now(); setTimeout(()=>{ hair.L.v+=5; hair.R.v-=5; for(const sd of 'LR'){ pup[sd].vy+=5; } },650); },
  rollEyes:()=>{ if(reduce) return; rollT0=performance.now(); },
  giggle:()=>{ setMode('wink'); for(const s of 'LR'){ pup[s].vy-=4; pup[s].vx+=(Math.random()-.5)*4; } hair.L.v-=4; hair.R.v+=4; setTimeout(()=>{ if(mode==='wink') setMode('idle'); },1400); },
  get mode_(){ return mode; }
};
})();
