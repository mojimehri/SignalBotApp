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

// سه حالت:
// fast  = سریع: حداقل 2 امتیاز، بدون شرط روند HTF
// normal= متوسط: حداقل 3 امتیاز، با شرط روند HTF
// precise= دقیق: حداقل 5 امتیاز، با شرط روند HTF + پین‌بار در S/R الزامی
const LEVELS = {
  fast:    ["⚡ سریع",    2, false, false],
  normal:  ["⚖️ متوسط",   3, true,  false],
  precise: ["🎯 دقیق",    5, true,  true]
};

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
  return hi===lo?50:100*(w[w.length-1][4]
