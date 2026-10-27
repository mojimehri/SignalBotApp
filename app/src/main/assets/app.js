// app.js — منطق اصلی ربات در اندروید

const PAYOUT = 0.85;
const BREAKEVEN = +(100/(1+PAYOUT)).toFixed(1);
const LOG_KEY = "signals_log_v2";
const STATS_KEY = "stats_v2";

// ---- وضعیت ----
let state = {
  running: false,
  pair: "EUR/USD",
  tf: "1m",
  level: "normal",
  signals: [],    // سیگنال‌های اخیر
  pending: [],    // منتظر نتیجه
  stats: {},      // "tf|pair" -> [w,l,t]
  history: [],    // ۲۰ نتیجه اخیر
  panel: null,    // آخرین تحلیل
  error: "",
  stale: false,
  lastEval: {}    // "pair|tf" -> ts آخرین کندل بررسی‌شده
};

// ---- بارگذاری آمار از localStorage ----
function loadStats(){
  try{
    const s=localStorage.getItem(STATS_KEY);
    if(s) state.stats=JSON.parse(s);
    const h=localStorage.getItem(LOG_KEY);
    if(h) state.history=JSON.parse(h).slice(0,20);
  }catch(_){}
}

function saveStats(){
  try{
    localStorage.setItem(STATS_KEY,JSON.stringify(state.stats));
    localStorage.setItem(LOG_KEY,JSON.stringify(state.history.slice(0,50)));
  }catch(_){}
}

// ---- درخواست HTTP از طریق Bridge اندروید ----
const pendingReqs={};
window.__onGet=function(id,ok,body){
  const cb=pendingReqs[id];
  if(cb){ delete pendingReqs[id]; cb(ok,body); }
};

function nativeGet(url){
  return new Promise((resolve,reject)=>{
    const id="r"+(Math.random()*1e9|0);
    pendingReqs[id]=function(ok,body){
      if(ok) resolve(body);
      else reject(new Error(body));
    };
    setTimeout(()=>{ if(pendingReqs[id]){ delete pendingReqs[id]; reject(new Error("timeout")); } },20000);
    try{ Android.get(url,id); }
    catch(e){ delete pendingReqs[id]; reject(e); }
  });
}

// ---- دریافت کندل ----
async function fetchCandles(ticker, tf){
  const {interval,range}=TIMEFRAMES[tf];
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
  const body=await nativeGet(url);
  const data=JSON.parse(body);
  const res=data.chart.result[0];
  const q=res.indicators.quote[0];
  const out=[];
  for(let i=0;i<(res.timestamp||[]).length;i++){
    const t=res.timestamp[i],o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i];
    if(o==null||h==null||l==null||c==null) continue;
    out.push([t,o,h,l,c]);
  }
  return out;
}

// ---- چرخه اصلی ----
let cycleTimer=null;

async function cycle(){
  if(!state.running) return;
  const {pair,tf,level}=state;
  const ticker=PAIRS[pair];
  const sec=TIMEFRAMES[tf].sec;
  const minScore=LEVELS[level][1];
  const htfKey=HTF[tf];

  try{
    const [cs,htfCs]=await Promise.all([
      fetchCandles(ticker,tf),
      fetchCandles(ticker,htfKey)
    ]);

    if(cs.length<MIN_CANDLES){
      state.error=`داده کافی نیست (${cs.length} کندل)`; render(); return;
    }

    const closed=cs.slice(0,-1); // کندل‌های بسته‌شده
    const last=closed[closed.length-1];
    const ts=last[0];
    const evalKey=`${pair}|${tf}`;

    // بررسی نتیجه سیگنال‌های در انتظار
    const now=Date.now()/1000;
    for(const s of [...state.pending]){
      if(now>=s.resultTs){
        const exit=closed.find(c=>c[0]===s.resultTs);
        const exitPrice=exit?exit[4]:last[4];
        let res;
        if(Math.abs(exitPrice-s.entry)<1e-10) res="TIE";
        else if((exitPrice>s.entry)===(s.dir==="CALL")) res="WIN";
        else res="LOSS";
        state.pending=state.pending.filter(p=>p!==s);
        const k=`${s.tf}|${s.pair}`;
        if(!state.stats[k]) state.stats[k]=[0,0,0];
        if(res==="WIN") state.stats[k][0]++;
        else if(res==="LOSS") state.stats[k][1]++;
        else state.stats[k][2]++;
        state.history.unshift({time:s.ts*1000,pair:s.pair,tf:s.tf,dir:s.dir,res,entry:s.entry,exit:exitPrice});
        if(state.history.length>50) state.history.pop();
        saveStats();
        try{ Android.vibrate(); }catch(_){}
      }
    }

    if(ts===state.lastEval[evalKey]){
      state.stale=false; state.error=""; render(); return;
    }
    state.lastEval[evalKey]=ts;

    const {direction,score,reasons,info}=evaluate(closed,htfCs.slice(0,-1),minScore);
    state.panel=info;
    state.error=""; state.stale=false;

    if(direction){
      const entry=last[4];
      const win=entryWindow(sec);
      const sig={pair,tf,dir:direction,score,reasons,entry,ts,found_at:now,resultTs:ts+sec};
      state.signals.unshift(sig);
      if(state.signals.length>30) state.signals.pop();
      state.pending.push(sig);
      // اعلان + لرزش
      try{ Android.signal(pair,direction,score); }
      catch(_){ try{ Android.vibrate(); }catch(__){} }
    }
  } catch(e){
    state.error=e.message||"خطای شبکه";
    state.stale=true;
  }
  render();
}

function scheduleNext(){
  if(!state.running) return;
  const sec=TIMEFRAMES[state.tf].sec;
  const now=Date.now()/1000;
  const nextClose=Math.ceil(now/sec)*sec;
  const delay=Math.max((nextClose-now+2)*1000,3000);
  cycleTimer=setTimeout(async()=>{ await cycle(); scheduleNext(); }, delay);
}

function start(pair,tf,level){
  state.pair=pair; state.tf=tf; state.level=level;
  state.running=true; state.error=""; state.panel=null;
  cycle().then(scheduleNext);
}

function stop(){
  state.running=false;
  if(cycleTimer){ clearTimeout(cycleTimer); cycleTimer=null; }
}

// ---- آمار ----
function packStats(k){
  const [w,l,t]=state.stats[k]||[0,0,0];
  const d=w+l;
  return {wins:w,losses:l,ties:t,decided:d,rate:d?+(w/d*100).toFixed(1):null};
}

function overallStats(){
  let W=0,L=0,T=0;
  for(const v of Object.values(state.stats)){ W+=v[0];L+=v[1];T+=v[2]; }
  const d=W+L; return {wins:W,losses:L,ties:T,decided:d,rate:d?+(W/d*100).toFixed(1):null};
}

// ---- رندر داشبورد ----
function fmt(n){ return n==null?"—":n.toFixed(5); }
function $id(id){ return document.getElementById(id); }

function render(){
  const s=state;
  const sec=TIMEFRAMES[s.tf].sec;
  const now=Date.now()/1000;
  const win=entryWindow(sec);

  // سیگنال فعال
  const live=s.signals.filter(sg=>sg.pair===s.pair&&sg.tf===s.tf&&now-(sg.ts+sec)<=win);
  const best=live.length?live[0]:null;

  const orb=$id("orb"), arrow=$id("arrow"), verdict=$id("verdict"), why=$id("why");
  const left=$id("left"), dots=$id("dots");

  if(best){
    const elapsed=now-(best.ts+sec);
    const rem=Math.max(0,Math.ceil(win-elapsed));
    orb.className="orb "+(best.dir==="CALL"?"call":"put");
    arrow.textContent=best.dir==="CALL"?"▲":"▼";
    verdict.textContent=best.dir==="CALL"?"CALL — خرید":"PUT — فروش";
    dots.textContent=best.reasons.slice(0,3).join(" | ");
    why.textContent=`قدرت: ${best.score} | ورود تا ${rem} ثانیه دیگر`;
  } else if(!s.running){
    orb.className="orb"; arrow.textContent="⏸"; verdict.textContent="ربات متوقف است";
    dots.textContent=""; why.textContent="جفت‌ارز و تایم‌فریم را انتخاب کنید و استارت بزنید";
  } else {
    orb.className="orb"; arrow.textContent="⏳"; verdict.textContent="منتظر سیگنال تأییدشده…";
    dots.textContent="";
    const nextClose=Math.ceil(now/sec)*sec;
    why.textContent="کندل بعدی تا "+Math.max(0,Math.ceil(nextClose-now))+" ثانیه دیگر بسته می‌شود";
  }

  // وضعیت اتصال
  $id("liveIndicator").className="live"+(s.running?" on":"");
  $id("liveIndicator").textContent=s.running?(s.stale?"در حال اتصال...":"● زنده"):"● متوقف";
  if(s.error) $id("warn").innerHTML=`<div class="warn">⚠️ ${s.error}</div>`;
  else $id("warn").innerHTML="";

  // آمار
  const st=packStats(`${s.tf}|${s.pair}`);
  $id("rate").textContent=st.decided>=30?st.rate+"%":(st.decided?(st.rate+"% (کم‌اعتبار)"):"—");
  $id("rateSub").textContent=st.decided>=30?("از "+st.decided+" سیگنال"):("جمع‌آوری داده: "+st.decided+" از ۳۰");
  $id("wl").textContent=st.wins+" / "+st.losses+" / "+st.ties;
  $id("be").textContent="سر‌به‌سر شدن ≈ "+BREAKEVEN+"٪";

  // پنل اندیکاتورها
  const p=s.panel;
  $id("panelCard").style.display=(s.running&&p)?"block":"none";
  if(s.running&&p){
    $id("chips").innerHTML=(p.votes||[]).map(v=>`<div class="chip ${v.vote==="CALL"?"up":v.vote==="PUT"?"dn":""}">${v.name}<b>${v.text}</b></div>`).join("");
    const tr=p.trend==="up"?"صعودی ↗":p.trend==="down"?"نزولی ↘":"نامشخص";
    const htfLabel=HTF[s.tf];
    const srLine=p.srNote?`<br>📍 <b>${p.srNote}</b>`:"";
    const pbLine=p.pinbar?`<br>🕯️ الگو: <b>${p.pinbar}</b>`:"";
    $id("gates").innerHTML=`قیمت: ${fmt(p.price)} • روند (${htfLabel}): <b>${tr}</b> • ADX: <b>${p.adxVal==null?"—":p.adxVal.toFixed(0)}</b><br>CALL: ${p.ncall} / PUT: ${p.nput} (حداقل: ${LEVELS[s.level][1]})${srLine}${pbLine}`;
    if(p.note) $id("warn").innerHTML+=`<div class="note" style="margin-top:8px">ℹ️ ${p.note}</div>`;
  }

  // تاریخچه
  const hist=s.history.slice(0,15);
  $id("hist").innerHTML=hist.length?hist.map(h=>{
    const t=new Date(h.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    const c=h.res==="WIN"?"up":h.res==="LOSS"?"dn":"tie";
    return `<tr><td>${t}</td><td>${h.pair}</td><td>${h.tf}</td><td>${h.dir}</td><td><span class="b ${c}">${h.res}</span></td></tr>`;
  }).join(""):"<tr><td colspan='5' class='note'>هنوز نتیجه‌ای ثبت نشده</td></tr>";

  // دکمه استارت/استاپ
  $id("btnStart").style.display=s.running?"none":"inline-block";
  $id("btnStop").style.display=s.running?"inline-block":"none";
  $id("pairSel").disabled=s.running;
  $id("tfSel").disabled=s.running;
  $id("levelSel").disabled=s.running;
}

// ---- رویدادهای UI ----
document.addEventListener("DOMContentLoaded",()=>{
  loadStats();

  // پر کردن آپشن‌ها
  const pairSel=$id("pairSel");
  Object.keys(PAIRS).forEach(p=>{ const o=document.createElement("option"); o.value=o.textContent=p; pairSel.appendChild(o); });

  const tfSel=$id("tfSel");
  SELECTABLE.forEach(tf=>{ const o=document.createElement("option"); o.value=o.textContent=tf; tfSel.appendChild(o); });

  const levelSel=$id("levelSel");
  Object.entries(LEVELS).forEach(([k,v])=>{ const o=document.createElement("option"); o.value=k; o.textContent=v[0]; levelSel.appendChild(o); });

  $id("btnStart").onclick=()=>{
    start(pairSel.value, tfSel.value, levelSel.value);
    render();
  };
  $id("btnStop").onclick=()=>{ stop(); render(); };

  render();
  setInterval(render, 2000);
});
