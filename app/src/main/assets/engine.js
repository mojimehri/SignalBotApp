// engine.js — پورت کامل استراتژی Python به JavaScript
// هیچ dependency خارجی ندارد

const PAIRS = {
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "JPY=X",
  "AUD/USD": "AUDUSD=X", "USD/CAD": "CAD=X",   "USD/CHF": "CHF=X",
  "NZD/USD": "NZDUSD=X", "EUR/GBP": "EURGBP=X", "EUR/JPY": "EURJPY=X",
  "GBP/JPY": "GBPJPY=X", "AUD/JPY": "AUDJPY=X", "EUR/CHF": "EURCHF=X"
};

const TIMEFRAMES = {
  "1m":  {sec:60,   interval:"1m",  range:"5d"},
  "5m":  {sec:300,  interval:"5m",  range:"5d"},
  "15m": {sec:900,  interval:"15m", range:"5d"},
  "1h":  {sec:3600, interval:"60m", range:"1mo"},
  "1d":  {sec:86400,interval:"1d",  range:"6mo"}
};
const SELECTABLE = ["1m","5m","15m","1h"];
const HTF = {"1m":"5m","5m":"15m","15m":"1h","1h":"1d"};
const LEVELS = {normal:["معمولی",3], high:["بالا",4], max:["خیلی بالا",5]};
const ADX_MAX = 40;
const MIN_CANDLES = 60;

function entryWindow(sec){ return Math.min(Math.max(sec*0.4,25),90); }

// ---- اندیکاتورها ----
function rsi(closes, n=14){
  if(closes.length<=n) return 50;
  let ag=0,al=0;
  for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];ag+=Math.max(d,0);al+=Math.max(-d,0);}
  ag/=n; al/=n;
  for(let i=n+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(n-1)+Math.max(d,0))/n;
    al=(al*(n-1)+Math.max(-d,0))/n;
  }
  if(al===0) return 100;
  return 100-100/(1+ag/al);
}

function bollinger(closes, n=20, k=2){
  const w=closes.slice(-n);
  const m=w.reduce((a,b)=>a+b,0)/w.length;
  const sd=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/w.length);
  return [m-k*sd, m+k*sd];
}

function stochastic(cs, n=14){
  const w=cs.slice(-n);
  const lo=Math.min(...w.map(c=>c[3])), hi=Math.max(...w.map(c=>c[2]));
  return hi===lo?50:100*(w[w.length-1][4]-lo)/(hi-lo);
}

function emaSeries(vals, n){
  const k=2/(n+1), out=[vals[0]];
  for(let i=1;i<vals.length;i++) out.push(vals[i]*k+out[i-1]*(1-k));
  return out;
}

function macdHist(closes){
  const e12=emaSeries(closes,12), e26=emaSeries(closes,26);
  const macd=e12.map((v,i)=>v-e26[i]);
  const sig=emaSeries(macd,9);
  return macd.map((v,i)=>v-sig[i]);
}

function cci(cs, n=20){
  const tp=cs.slice(-n).map(c=>(c[2]+c[3]+c[4])/3);
  const m=tp.reduce((a,b)=>a+b,0)/tp.length;
  const md=tp.reduce((a,b)=>a+Math.abs(b-m),0)/tp.length;
  return md===0?0:(tp[tp.length-1]-m)/(0.015*md);
}

function adx(cs, n=14){
  if(cs.length<2*n+2) return null;
  const trs=[],pdm=[],mdm=[];
  for(let i=1;i<cs.length;i++){
    const h=cs[i][2],l=cs[i][3],ph=cs[i-1][2],pl=cs[i-1][3],pc=cs[i-1][4];
    const up=h-ph, dn=pl-l;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    pdm.push(up>dn&&up>0?up:0);
    mdm.push(dn>up&&dn>0?dn:0);
  }
  let atr=trs.slice(0,n).reduce((a,b)=>a+b,0);
  let p=pdm.slice(0,n).reduce((a,b)=>a+b,0);
  let m=mdm.slice(0,n).reduce((a,b)=>a+b,0);
  function dx(){
    if(atr===0) return [0,0,0];
    const pi=100*p/atr, mi=100*m/atr, s=pi+mi;
    return [s===0?0:100*Math.abs(pi-mi)/s, pi, mi];
  }
  const dxs=[dx()[0]];
  let pi=0,mi=0;
  for(let i=n;i<trs.length;i++){
    atr=atr-atr/n+trs[i]; p=p-p/n+pdm[i]; m=m-m/n+mdm[i];
    const r=dx(); dxs.push(r[0]); pi=r[1]; mi=r[2];
  }
  if(dxs.length<n) return null;
  let a=dxs.slice(0,n).reduce((s,v)=>s+v,0)/n;
  for(let i=n;i<dxs.length;i++) a=(a*(n-1)+dxs[i])/n;
  return [a,pi,mi];
}

function htfTrend(cs){
  if(!cs||cs.length<25) return null;
  const closes=cs.map(c=>c[4]);
  const e9=emaSeries(closes,9), e21=emaSeries(closes,21);
  return e9[e9.length-1]>e21[e21.length-1]?"up":"down";
}

// ---- حمایت/مقاومت ----
function supportResistance(cs, lookback=40, nLevels=3, tol=0.0003){
  if(cs.length<lookback+5) return [[],[]];
  const w=cs.slice(-(lookback+4));
  const supports=[], resistances=[];
  for(let i=2;i<w.length-2;i++){
    const hi=w[i][2], lo=w[i][3];
    if(hi>w[i-1][2]&&hi>w[i-2][2]&&hi>w[i+1][2]&&hi>w[i+2][2]){
      if(!resistances.some(r=>Math.abs(hi-r)/hi<tol)) resistances.push(hi);
    }
    if(lo<w[i-1][3]&&lo<w[i-2][3]&&lo<w[i+1][3]&&lo<w[i+2][3]){
      if(!supports.some(s=>Math.abs(lo-s)/lo<tol)) supports.push(lo);
    }
  }
  const cur=cs[cs.length-1][4];
  const nearestN=arr=>arr.sort((a,b)=>Math.abs(a-cur)-Math.abs(b-cur)).slice(0,nLevels);
  return [nearestN(supports), nearestN(resistances)];
}

function isNearLevel(price, levels, tol=0.0005){
  return levels.some(lvl=>Math.abs(price-lvl)/Math.max(lvl,1e-10)<=tol);
}

// ---- پین‌بار + انگالفینگ ----
function pinbarEngulfing(cs){
  if(cs.length<3) return [null,""];
  const [,o3,h3,l3,c3]=cs[cs.length-3];
  const [,o2,h2,l2,c2]=cs[cs.length-2];
  const [,o1,h1,l1,c1]=cs[cs.length-1];
  const rng2=Math.max(h2-l2,1e-12);
  const body2=Math.abs(c2-o2);
  const lowWick2=(Math.min(o2,c2)-l2)/rng2;
  const upWick2=(h2-Math.max(o2,c2))/rng2;
  const bodyRatio=body2/rng2;
  const body1Low=Math.min(o1,c1), body1High=Math.max(o1,c1);
  const body3Low=Math.min(o3,c3), body3High=Math.max(o3,c3);
  // CALL
  if(lowWick2>=0.5&&upWick2<0.3&&bodyRatio<=0.35){
    const green=c2>=o2;
    if(h1>h2&&body1High>=body3High&&body1Low<=body3Low)
      return ["CALL",`پین‌بار ${green?"سبز":"قرمز"} + انگالفینگ صعودی`];
  }
  // PUT
  if(upWick2>=0.5&&lowWick2<0.3&&bodyRatio<=0.35){
    const red=c2<=o2;
    if(l1<l2&&body1Low<=body3Low&&body1High>=body3High)
      return ["PUT",`پین‌بار ${red?"قرمز":"سبز"} + انگالفینگ نزولی`];
  }
  return [null,""];
}

// ---- ارزیابی اصلی ----
function evaluate(cs, htfCs, minScore){
  const closes=cs.map(c=>c[4]);
  const r=rsi(closes);
  const [blo,bup]=bollinger(closes);
  const st=stochastic(cs);
  const cc=cci(cs);
  const hist=macdHist(closes);
  const h0=hist[hist.length-1], h1=hist[hist.length-2];
  const ad=adx(cs);
  const trend=htfTrend(htfCs);
  const [,o,h,l,c]=cs[cs.length-1];
  const rng=Math.max(h-l,1e-12);

  const [supports,resistances]=supportResistance(cs);
  const nearSupport=supports.length?isNearLevel(c,supports):false;
  const nearResistance=resistances.length?isNearLevel(c,resistances):false;
  const [pbDir,pbText]=pinbarEngulfing(cs);

  const votes=[];
  const vote=(name,text,v)=>votes.push({name,text,vote:v});

  vote("RSI",r.toFixed(0), r<=30?"CALL":r>=70?"PUT":null);
  if(c<=blo) vote("بولینگر","زیر باند پایین","CALL");
  else if(c>=bup) vote("بولینگر","بالای باند بالا","PUT");
  else vote("بولینگر","داخل باند",null);
  vote("استوکاستیک",st.toFixed(0), st<=20?"CALL":st>=80?"PUT":null);
  vote("CCI",cc.toFixed(0), cc<=-100?"CALL":cc>=100?"PUT":null);
  const lowWick=(Math.min(o,c)-l)/rng>=0.5;
  const upWick=(h-Math.max(o,c))/rng>=0.5;
  if(lowWick&&!upWick) vote("سایه‌ی کندل","سایه‌ی پایین بلند","CALL");
  else if(upWick&&!lowWick) vote("سایه‌ی کندل","سایه‌ی بالا بلند","PUT");
  else vote("سایه‌ی کندل","—",null);
  if(h0<0&&h0>h1) vote("MACD","کاهش شتاب نزول","CALL");
  else if(h0>0&&h0<h1) vote("MACD","کاهش شتاب صعود","PUT");
  else vote("MACD","—",null);

  let pbVoted=false;
  if(pbDir==="CALL"&&nearSupport){
    vote("پین‌بار+انگالفینگ",pbText+" در حمایت","CALL");
    vote("پین‌بار+انگالفینگ ۲","تأیید سطح حمایت","CALL");
    pbVoted=true;
  } else if(pbDir==="PUT"&&nearResistance){
    vote("پین‌بار+انگالفینگ",pbText+" در مقاومت","PUT");
    vote("پین‌بار+انگالفینگ ۲","تأیید سطح مقاومت","PUT");
    pbVoted=true;
  } else if(pbDir){
    vote("پین‌بار+انگالفینگ",pbText+" (بدون سطح کلیدی)",pbDir);
  }

  const ncall=votes.filter(v=>v.vote==="CALL").length;
  const nput=votes.filter(v=>v.vote==="PUT").length;
  const adxVal=ad?ad[0]:null;
  const adxOk=adxVal!==null&&adxVal<ADX_MAX;

  let direction=null,score=0,reasons=[],note="";
  for(const [side,n,other,want] of [["CALL",ncall,nput,"up"],["PUT",nput,ncall,"down"]]){
    if(n<minScore||n<=other) continue;
    const sideName=side==="CALL"?"خرید (CALL)":"فروش (PUT)";
    if(!adxOk) note=`نشانه‌ی ${sideName} هست ولی ADX بالاست؛ روند خیلی شدید است.`;
    else if(trend===null) note=`نشانه‌ی ${sideName} هست ولی داده‌ی تایم‌فریم بالاتر نرسیده.`;
    else if(trend!==want) note=`نشانه‌ی ${sideName} هست ولی روند تایم‌فریم بالاتر مخالف است.`;
    else{
      direction=side; score=n;
      reasons=votes.filter(v=>v.vote===side).map(v=>`${v.name}: ${v.text}`);
      reasons.push("روند تایم‌فریم بالاتر "+(want==="up"?"صعودی":"نزولی"));
      if(adxVal!==null) reasons.push(`ADX=${adxVal.toFixed(0)} (روند افسارگسیخته نیست)`);
      note="";
    }
    break;
  }

  let srNote="";
  if(nearSupport) srNote=`نزدیک حمایت (${supports.slice(0,2).map(s=>s.toFixed(5)).join(", ")})`;
  else if(nearResistance) srNote=`نزدیک مقاومت (${resistances.slice(0,2).map(s=>s.toFixed(5)).join(", ")})`;

  return {
    direction, score, reasons,
    info:{
      price:c, trend, adxVal, votes, note,
      ncall, nput, supports, resistances,
      srNote, pinbar: pbVoted?pbText:""
    }
  };
}

// export برای Node.js تست
if(typeof module!=="undefined") module.exports={
  evaluate,rsi,bollinger,stochastic,cci,adx,htfTrend,
  supportResistance,pinbarEngulfing,emaSeries,macdHist,
  PAIRS,TIMEFRAMES,SELECTABLE,HTF,LEVELS,ADX_MAX,entryWindow
};
