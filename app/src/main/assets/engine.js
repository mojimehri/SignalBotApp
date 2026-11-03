// engine.js — استراتژی: واکنش سوم به حمایت/مقاومت قوی + پین‌بار هم‌جهت با روند
// کندل‌ها: [زمان, باز, بالا, پایین, بسته]

const PAIRS = {
  "EUR/USD":"EUR/USD", "GBP/USD":"GBP/USD", "USD/JPY":"USD/JPY",
  "AUD/USD":"AUD/USD", "USD/CAD":"USD/CAD", "USD/CHF":"USD/CHF",
  "NZD/USD":"NZD/USD", "EUR/GBP":"EUR/GBP", "EUR/JPY":"EUR/JPY",
  "GBP/JPY":"GBP/JPY", "AUD/JPY":"AUD/JPY", "EUR/CHF":"EUR/CHF"
};

const TIMEFRAMES = {
  "1m": {sec:60,   interval:"1min", size:300},
  "5m": {sec:300,  interval:"5min", size:300},
  "15m":{sec:900,  interval:"15min",size:300},
  "1h": {sec:3600, interval:"1h",   size:300}
};
const SELECTABLE = ["1m","5m","15m","1h"];

// سه حالت (همه از یک استراتژی‌اند؛ فقط سخت‌گیری فرق می‌کند)
// minTouches : حداقل واکنش‌های قبلی به سطح (قبل از کندل سیگنال)
// wick/body  : نسبت سایه‌ی پین‌بار به کل کندل / حداکثر نسبت بدنه
// trend      : false = بدون فیلتر روند | 1 = روند EMA | 2 = روند قوی
// color      : رنگ کندل الزامی باشد (قرمز در مقاومت، سبز در حمایت)
// zone       : پهنای ناحیه بر حسب ATR
const LEVELS = {
  fast:    ["⚡ سریع",  {minTouches:2, wick:0.55, body:0.40, trend:false, color:false, zone:0.50}],
  normal:  ["⚖️ متوسط", {minTouches:2, wick:0.60, body:0.35, trend:1,     color:true,  zone:0.40}],
  precise: ["🎯 دقیق",  {minTouches:3, wick:0.66, body:0.30, trend:2,     color:true,  zone:0.30}]
};

const MIN_CANDLES = 80;
const LOOKBACK = 150;

function entryWindow(sec){ return Math.min(Math.max(sec*0.4,25),90); }

function emaSeries(vals, n){
  const k=2/(n+1), out=[vals[0]];
  for(let i=1;i<vals.length;i++) out.push(vals[i]*k+out[i-1]*(1-k));
  return out;
}

function atr(cs, n=14){
  let s=0;
  for(let i=cs.length-n;i<cs.length;i++){
    const h=cs[i][2], l=cs[i][3], pc=cs[i-1][4];
    s+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
  }
  return s/n;
}

// قله/دره‌هایی که بعدشان واکنش واقعی (حداقل 0.8 ATR) دیده شده
// کندل آخر (کندل سیگنال) عمداً کنار گذاشته می‌شود
function findPivots(cs, atrV, k=2, reactBars=5, reactMult=0.8){
  const end=cs.length-1;
  const highs=[], lows=[];
  for(let i=Math.max(k,end-LOOKBACK); i<=end-1-k; i++){
    const h=cs[i][2], l=cs[i][3];
    let isH=true, isL=true;
    for(let j=1;j<=k;j++){
      if(!(h>cs[i-j][2] && h>=cs[i+j][2])) isH=false;
      if(!(l<cs[i-j][3] && l<=cs[i+j][3])) isL=false;
    }
    if(isH){
      let m=Infinity;
      for(let j=1;j<=reactBars&&i+j<end;j++) m=Math.min(m,cs[i+j][3]);
      if(h-m>=reactMult*atrV) highs.push({i,p:h});
    }
    if(isL){
      let m=-Infinity;
      for(let j=1;j<=reactBars&&i+j<end;j++) m=Math.max(m,cs[i+j][2]);
      if(m-l>=reactMult*atrV) lows.push({i,p:l});
    }
  }
  return {highs,lows};
}

// قله/دره‌های نزدیک به هم = یک سطح؛ n = تعداد واکنش‌ها
function clusterLevels(pivots, zone, minGap=4){
  const cl=[];
  for(const pv of pivots){
    const c=cl.find(x=>Math.abs(x.p-pv.p)<=zone);
    if(c){
      if(pv.i-c.lastI>=minGap){ c.n++; c.ps.push(pv.p); }
      c.lastI=pv.i;
      c.p=c.ps.reduce((a,b)=>a+b,0)/c.ps.length;
    } else cl.push({p:pv.p, ps:[pv.p], n:1, firstI:pv.i, lastI:pv.i});
  }
  return cl;
}

// سطح شکسته‌شده (بسته شدن کندل‌ها آن‌سوی سطح) معتبر نیست
function isBroken(cs, lvl, isRes, zone){
  for(let i=lvl.firstI+1;i<cs.length-1;i++){
    const c=cs[i][4];
    if(isRes ? c>lvl.p+zone : c<lvl.p-zone) return true;
  }
  return false;
}

function trendOf(cs, atrV){
  const closes=cs.map(c=>c[4]);
  const e20=emaSeries(closes,20), e50=emaSeries(closes,50);
  const n=closes.length-1;
  const a=e20[n], b=e50[n], a10=e20[n-10], b10=e50[n-10];
  let dir="side", strong=false;
  if(a<b && b<b10){ dir="down"; strong = a<a10 && (b-a)>=0.3*atrV; }
  else if(a>b && b>b10){ dir="up"; strong = a>a10 && (a-b)>=0.3*atrV; }
  return {dir, strong};
}

function fmtP(p){ return p==null?"—":p.toFixed(p>=20?3:5); }

// level: "fast" | "normal" | "precise"
function evaluate(cs, level){
  const P=(LEVELS[level]||LEVELS.normal)[1];
  const end=cs.length-1;
  const [,o,h,l,c]=cs[end];
  const atrV=atr(cs);
  const zone=P.zone*atrV;
  const {highs,lows}=findPivots(cs,atrV);
  const resList=clusterLevels(highs,zone).filter(x=>x.n>=P.minTouches && !isBroken(cs,x,true,zone));
  const supList=clusterLevels(lows,zone).filter(x=>x.n>=P.minTouches && !isBroken(cs,x,false,zone));
  const tr=trendOf(cs,atrV);

  // شکل کندل سیگنال
  const rng=Math.max(h-l,1e-12);
  const upW=(h-Math.max(o,c))/rng, loW=(Math.min(o,c)-l)/rng, body=Math.abs(c-o)/rng;
  const sizeOk=rng>=0.5*atrV && rng<=3*atrV;
  const bearPin=sizeOk && upW>=P.wick && body<=P.body && loW<=0.25;
  const bullPin=sizeOk && loW>=P.wick && body<=P.body && upW<=0.25;
  const red=c<o, green=c>o;

  const trendOkSell = !P.trend || (tr.dir==="down" && (P.trend<2 || tr.strong));
  const trendOkBuy  = !P.trend || (tr.dir==="up"   && (P.trend<2 || tr.strong));

  // نزدیک‌ترین سطح قوی که کندل سیگنال به آن رسیده
  const nearest=(list,price)=>list.reduce((b,x)=>(!b||Math.abs(x.p-price)<Math.abs(b.p-price))?x:b,null);
  const resHit=nearest(resList.filter(x=>h>=x.p-zone && h<=x.p+zone*1.5 && c<x.p), h);
  const supHit=nearest(supList.filter(x=>l<=x.p+zone && l>=x.p-zone*1.5 && c>x.p), l);

  let direction=null, score=0, reasons=[], hit=null;
  if(resHit && bearPin && (!P.color||red) && trendOkSell){
    direction="PUT"; hit=resHit;
    reasons=[`مقاومت قوی ${fmtP(hit.p)} با ${hit.n} واکنش قبلی`,
             `پین‌بار ${red?"قرمز":"(رنگ دیگر)"} با سایه‌ی بالایی ${(upW*100).toFixed(0)}٪`];
    if(P.trend) reasons.push("روند نزولی");
  } else if(supHit && bullPin && (!P.color||green) && trendOkBuy){
    direction="CALL"; hit=supHit;
    reasons=[`حمایت قوی ${fmtP(hit.p)} با ${hit.n} واکنش قبلی`,
             `پین‌بار ${green?"سبز":"(رنگ دیگر)"} با سایه‌ی پایینی ${(loW*100).toFixed(0)}٪`];
    if(P.trend) reasons.push("روند صعودی");
  }
  if(direction) score=Math.min(5, hit.n+1+((P.trend&&(direction==="PUT"?tr.dir==="down":tr.dir==="up"))?1:0));

  // توضیح وضعیت برای پنل
  const nearRes=nearest(resList,c), nearSup=nearest(supList,c);
  let note="";
  if(!direction){
    const closeTo=x=>x && Math.abs(x.p-c)<=1.0*atrV;
    if(closeTo(nearRes) && h>=nearRes.p-zone){
      if(!bearPin) note=`قیمت به مقاومت ${fmtP(nearRes.p)} (${nearRes.n} واکنش) رسیده ولی کندل پین‌بار نیست.`;
      else if(P.color&&!red) note="پین‌بار در مقاومت هست ولی قرمز نیست.";
      else if(!trendOkSell) note="پین‌بار در مقاومت هست ولی روند نزولی نیست.";
    } else if(closeTo(nearSup) && l<=nearSup.p+zone){
      if(!bullPin) note=`قیمت به حمایت ${fmtP(nearSup.p)} (${nearSup.n} واکنش) رسیده ولی کندل پین‌بار نیست.`;
      else if(P.color&&!green) note="پین‌بار در حمایت هست ولی سبز نیست.";
      else if(!trendOkBuy) note="پین‌بار در حمایت هست ولی روند صعودی نیست.";
    } else if(!resList.length && !supList.length){
      note=`سطح قوی (حداقل ${P.minTouches} واکنش) پیدا نشد.`;
    } else note="قیمت از سطح‌های قوی دور است؛ منتظر رسیدن به حمایت/مقاومت.";
  }

  const trLabel = tr.dir==="up"?"صعودی":tr.dir==="down"?"نزولی":"خنثی";
  const votes=[
    {name:"روند", text:trLabel+(tr.strong?" (قوی)":""), vote:tr.dir==="up"?"CALL":tr.dir==="down"?"PUT":null},
    {name:"مقاومت قوی", text:nearRes?`${fmtP(nearRes.p)} (${nearRes.n}×)`:"—", vote:resHit?"PUT":null},
    {name:"حمایت قوی", text:nearSup?`${fmtP(nearSup.p)} (${nearSup.n}×)`:"—", vote:supHit?"CALL":null},
    {name:"پین‌بار", text:bearPin?"بالایی":bullPin?"پایینی":"—", vote:bearPin?"PUT":bullPin?"CALL":null}
  ];

  return {direction, score, reasons, info:{price:c, trend:tr.dir, trendLabel:trLabel, atr:atrV, votes, note, nearRes, nearSup, minTouches:P.minTouches}};
}

if(typeof module!=="undefined") module.exports={evaluate,findPivots,clusterLevels,trendOf,atr,emaSeries,LEVELS,TIMEFRAMES,PAIRS,SELECTABLE,MIN_CANDLES,entryWindow};
