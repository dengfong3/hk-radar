/**
 * 单文件 PWA 验证：
 *   1) 静态检查：手机 meta / manifest / 免责 / 无内置个人计划 / 所有 id 都存在
 *   2) 场景一：A 股 603083 + 用户自定计划 + 持仓 → 人民币口径 / 用户档位 / 计划摘要
 *   3) 场景二：全新安装（空 localStorage）→ 默认 06166、无计划、无信号崩溃
 * 运行：node test/pwa.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`)); };

/* ---------- 1) 静态检查 ---------- */
console.log("\n[静态检查]");
ok("有 viewport meta（手机适配）", /<meta name="viewport"[^>]*width=device-width/.test(html));
ok("有 apple-mobile-web-app-capable", html.includes("apple-mobile-web-app-capable"));
ok("引用了 manifest", html.includes('rel="manifest"'));
ok("有免责声明（不构成投资建议）", html.includes("不构成") && html.includes("免责声明"));
ok("声明计划由使用者自行设定", html.includes("本工具不提供") || html.includes("你自己"));
ok("未内置个人计划：无 96.7 / 67.45", !/96\.7/.test(html) && !/67\.45/.test(html));
ok("未内置个人计划：无 92–97 / 104–110 / 128–135", !/92[–-]97/.test(html) && !/104[–-]110/.test(html) && !/128[–-]135/.test(html));
ok("标签页标题含『盯盘雷达』", /<title>[^<]*盯盘雷达/.test(html));

const coreSrc = (html.match(/<script id="core">([\s\S]*?)<\/script>/) || [])[1];
const uiSrc = (html.match(/<script id="ui">([\s\S]*?)<\/script>/) || [])[1];
ok("找到 core 脚本", !!coreSrc && coreSrc.length > 2000);
ok("找到 ui 脚本", !!uiSrc && uiSrc.length > 2000);

// 所有 $("id") 引用都必须存在于 HTML（防止拼写错误导致某块永不更新）
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...uiSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missing = [...usedIds].filter((id) => !htmlIds.has(id));
ok(`ui 引用的 ${usedIds.size} 个 id 全部存在于 HTML`, missing.length === 0, missing);
ok("HTML 里没有重复 id", (() => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  return new Set(all).size === all.length;
})());

/* ---------- 假 DOM 工具 ---------- */
const CTX = new Proxy({}, { get: (t, k) => (typeof k === "string" && /^(fill|stroke|line|font|global|set|clear|save|restore|begin|move|close|arc|rect)/.test(k) ? (() => {}) : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
    this._text = ""; this._cls = ""; this._html = ""; this.value = ""; this.placeholder = "";
    this.width = 0; this.height = 0; this.clientWidth = 360; this.clientHeight = 150;
    this.listeners = {};
    const s = new Set();
    this.classList = { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (x) => s.has(x) };
  }
  set className(v) { this._cls = String(v); } get className() { return this._cls; }
  set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ""); } get innerHTML() { return this._html; }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  getContext() { return CTX; }
}

/* 合成 3 天东财分时（用于多周期/3 日背景）：120 点/天，价格缓慢上行 */
function makeEmPayload() {
  const days = ["2026-10-14", "2026-10-15", "2026-10-16"];
  const trends = [];
  let px = 160;
  days.forEach((d, di) => {
    for (let i = 0; i < 120; i++) {
      px += 0.03 + Math.sin((i + di * 30) / 5) * 0.02;
      const o = +(px - 0.02).toFixed(2), c = +px.toFixed(2);
      const vol = 1000 + (i % 5) * 300;
      const hh = 9 + Math.floor((30 + i) / 60), mm = (30 + i) % 60;
      const t = d + " " + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
      trends.push(t + "," + o + "," + c + "," + (c + 0.05).toFixed(2) + "," + (o - 0.05).toFixed(2) + "," + vol + "," + (vol * c).toFixed(2) + "," + c);
    }
  });
  return { rc: 0, data: { code: "603083", name: "剑桥科技", preClose: 158.0, trends } };
}

function makeHarness(seedStore, payloadFor, opts) {
  const ids = new Map();
  const byId = (id) => { if (!ids.has(id)) ids.set(id, new El("div")); return ids.get(id); };
  const doc = {
    title: "", hidden: false, listeners: {},
    getElementById: (id) => byId(id),
    createElement: (t) => new El(t),
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  };
  doc.body = new El("body");
  const mem = new Map(seedStore ? [["hk-radar-pwa-v1", JSON.stringify(seedStore)]] : []);
  const ls = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const fetchShim = async (url) => {
    const u = String(url);
    const o = opts || {};
    if (o.snapshotOnly) {
      if (u.indexOf("qt.gtimg.cn") >= 0) return { ok: true, text: async () => o.snapshotText };
      return { ok: false, status: 501, json: async () => ({}), text: async () => "" };
    }
    if (u.indexOf("trends2") >= 0) return { ok: true, json: async () => makeEmPayload() };
    const code = decodeURIComponent(u.split("code=")[1] || "");
    const payload = payloadFor(code);
    if (!payload) return { ok: true, json: async () => ({ code: 0, data: {} }) };
    return { ok: true, json: async () => payload };
  };
  const win = { devicePixelRatio: 1, innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} };
  const run = (src) => new Function(
    "window", "document", "localStorage", "fetch", "setTimeout", "clearTimeout", "console",
    "navigator", "Notification", "alert", "prompt", "encodeURIComponent", "Math", "Date", "JSON", src
  )(win, doc, ls, fetchShim, setTimeout, clearTimeout, console,
    {}, undefined, () => {}, () => null, encodeURIComponent, Math, Date, JSON);
  const deepText = (el) => {
    let out = String(el._text || "");
    for (const c of el.children || []) out += " " + deepText(c);
    return out.replace(/\s+/g, " ").trim();
  };
  return {
    win, doc, byId, run,
    txt: (id) => (byId(id).textContent || "").replace(/\s+/g, " ").trim(),
    deep: (id) => deepText(byId(id)),
    saved: () => JSON.parse(mem.get("hk-radar-pwa-v1") || "{}")
  };
}

/* ---------- 真实报文样本 ---------- */
function aSharePayload() {
  const QT = new Array(88).fill("0");
  Object.assign(QT, { 0: "1", 1: "剑桥科技", 2: "603083" });
  QT[3] = "168.51"; QT[4] = "167.20"; QT[5] = "174.00"; QT[6] = "190625";
  QT[30] = "20261016161459"; QT[31] = "1.31"; QT[32] = "0.78";
  QT[33] = "174.00"; QT[34] = "166.58"; QT[37] = "323884"; QT[39] = "138.55"; QT[43] = "4.44";
  const rows = ["0930 174.00 2704 47049600.00", "1000 170.00 30000 510500000.00",
    "1130 169.50 120000 2033000000.00", "1430 168.00 170000 2880000000.00", "1530 168.51 190753 3240986819.99"];
  return { code: 0, msg: "", data: { sh603083: { data: { data: rows, date: "20261016" }, qt: { sh603083: QT } } } };
}
function hkPayload() {
  const QT = new Array(78).fill("0");
  Object.assign(QT, { 0: "100", 1: "剑桥科技", 2: "06166" });
  QT[3] = "84.150"; QT[4] = "81.600"; QT[5] = "85.850"; QT[6] = "9825285";
  QT[30] = "2026/10/16 16:08:22"; QT[31] = "2.550"; QT[32] = "3.13";
  QT[33] = "87.650"; QT[34] = "82.750"; QT[37] = "837019141.750"; QT[39] = "111.55"; QT[43] = "6.00";
  const rows = ["0930 85.850 100850 8657972.500", "0931 84.900 300850 25970000.000",
    "0932 84.300 500850 43080000.000", "0933 84.500 700850 60000000.000",
    "0934 84.200 900850 77000000.000", "0935 84.150 9825285 837019141.750"];
  return { code: 0, msg: "", data: { hk06166: { data: { data: rows, date: "20261016" }, qt: { hk06166: QT } } } };
}

/* ---------- 2) 场景一：A 股 + 用户自定计划 ---------- */
console.log("\n[场景一：A股 603083 + 用户自定计划 + 持仓 100 股 @175]");
const PLAN = {
  takes: [{ id: "T1", lo: 175, hi: 180, short: "减 1 手", label: "减 1 手区" },
    { id: "T2", lo: 185, hi: 190, short: "再减 1 手", label: "再减 1 手区" }],
  reds: [{ id: "R1", at: 160, dir: "below", level: "warn", short: "减半", label: "跌破 160：减半" },
    { id: "R2", at: 150, dir: "below", level: "danger", short: "清仓", label: "跌破 150：清仓" }],
  buys: [], maxShares: 100, lossBudget: 5000, hardStopFloor: null,
  vwapBand: 1.5, roundTripCostPct: 1.2, levels: [160, 150]
};
const h1 = makeHarness({
  code: "sh603083", watch: ["sh603083", "hk06166"], sound: true, chartMode: "min",
  pos: { sh603083: { shares: 100, cost: 175, realized: 0 } },
  plans: { sh603083: PLAN }, trade: {}, lastFired: {}
}, (code) => (code === "sh603083" ? aSharePayload() : null));

let threw = null;
try { h1.run(coreSrc); h1.run(uiSrc); } catch (e) { threw = e; }
ok("脚本执行无异常", !threw, threw && threw.message);
ok("core 暴露 RADAR_CORE", !!h1.win.RADAR_CORE && !!h1.win.RADAR_CORE.evaluateSignals);
ok("币种：603083 → CNY", h1.win.RADAR_CORE.currencyOf("sh603083") === "CNY");

await new Promise((r) => setTimeout(r, 350));
ok("标题 = 剑桥科技 603083.SH", h1.txt("name") === "剑桥科技 603083.SH", h1.txt("name"));
ok("现价 168.51", h1.txt("px") === "168.51", h1.txt("px"));
ok("涨跌幅 +0.78%", h1.txt("chg").includes("+0.78%"), h1.txt("chg"));
ok("成交额 32.39 亿（万元已换算）", h1.deep("grid").includes("32.39 亿"), h1.deep("grid"));
ok("均价 169.90（手→股换算）", h1.deep("grid").includes("169.90"), h1.deep("grid"));
ok("浮亏 -649 人民币", h1.txt("pnl").includes("-649") && h1.txt("pnl").includes("人民币"), h1.txt("pnl"));
ok("持仓信息含预算 5000 人民币", h1.txt("posInfo").includes("/5000") && h1.txt("posInfo").includes("人民币"), h1.txt("posInfo"));
ok("T 成本用人民币", h1.txt("tradeInfo").includes("人民币"), h1.txt("tradeInfo"));
const lad = h1.deep("ladder");
ok("阶梯含用户的减仓档 175 / 185", lad.includes("175.00") && lad.includes("185.00"), lad);
ok("阶梯含用户的风控线 160 / 150", lad.includes("160.00") && lad.includes("150.00"), lad);
ok("阶梯含资金硬止损 125（175−5000÷100）", lad.includes("125.00"), lad);
ok("阶梯标注盈亏单位：人民币", h1.txt("ladderUnit").includes("人民币"), h1.txt("ladderUnit"));
ok("计划摘要显示 减仓 175–180 / 清仓线 150", h1.txt("planSummary").includes("减仓 175–180") && h1.txt("planSummary").includes("清仓线 150"), h1.txt("planSummary"));
const sig = h1.deep("signals");
ok("信号含回本价 175.00", sig.includes("回本价 175.00"), sig);
ok("信号含预算占用（人民币）", sig.includes("风险预算已用") && sig.includes("人民币"), sig);
const saved1 = h1.saved();
ok("持仓按代码保存", saved1.pos && saved1.pos.sh603083 && saved1.pos.sh603083.shares === 100, saved1.pos);
ok("计划按代码保存", saved1.plans && saved1.plans.sh603083 && saved1.plans.sh603083.maxShares === 100, saved1.plans);

/* ---------- 3) 场景二：全新安装 ---------- */
console.log("\n[场景二：全新安装（空 localStorage，默认 06166）]");
const h2 = makeHarness(null, (code) => (code === "hk06166" ? hkPayload() : null));
threw = null;
try { h2.run(coreSrc); h2.run(uiSrc); } catch (e) { threw = e; }
ok("脚本执行无异常", !threw, threw && threw.message);
await new Promise((r) => setTimeout(r, 350));
ok("默认代码 = 06166.HK", h2.txt("name") === "剑桥科技 06166.HK", h2.txt("name"));
ok("现价 84.15", h2.txt("px") === "84.15", h2.txt("px"));
ok("无计划时出现提示", String(h2.byId("noPlan").style.display) !== "none" && h2.txt("noPlan").includes("未设交易计划"), h2.txt("noPlan"));
ok("无计划时阶梯不显示任何价位", h2.byId("ladder").children.length === 0, h2.byId("ladder").children.length);
ok("无持仓时显示『未填持仓』", h2.txt("pnl") === "未填持仓", h2.txt("pnl"));
ok("无计划仍给出 NOPLAN 提示信号", h2.deep("signals").includes("未设交易计划"), h2.deep("signals"));
ok("计划摘要显示未设置", h2.txt("planSummary").includes("未设置"), h2.txt("planSummary"));
ok("无计划时不出现制式减仓档文案", !h2.deep("signals").includes("减仓区"), h2.deep("signals"));
ok("全新安装不写入任何计划", !h2.saved().plans || Object.keys(h2.saved().plans).length === 0, h2.saved().plans);
ok("全新安装默认币种 = 港元", h2.txt("posUnit").includes("港元") || h2.txt("tradeInfo").includes("港元"), h2.txt("posUnit") + " / " + h2.txt("tradeInfo"));

/* ---------- 4) 计划编辑器：表单 → 计划 ---------- */
console.log("\n[计划编辑器：表单 → 计划对象]");
h2.byId("fT1lo").value = 92; h2.byId("fT1hi").value = 97;
h2.byId("fRwarn").value = 78; h2.byId("fRdanger").value = 60.5;
h2.byId("fMax").value = 200; h2.byId("fBudget").value = 5850; h2.byId("fFloor").value = 67.45;
h2.byId("btnPlanSave").listeners.click[0]();
const saved2 = h2.saved();
const p2 = saved2.plans && saved2.plans.hk06166;
ok("保存后写入计划", !!p2, saved2.plans);
ok("减仓档 92–97", p2 && p2.takes.length === 1 && p2.takes[0].lo === 92 && p2.takes[0].hi === 97, p2 && p2.takes);
ok("风控线 78 减半 / 60.5 清仓", p2 && p2.reds.length === 2 && p2.reds[0].at === 78 && p2.reds[1].level === "danger", p2 && p2.reds);
ok("仓位上限 200 / 预算 5850 / 地板 67.45", p2 && p2.maxShares === 200 && p2.lossBudget === 5850 && p2.hardStopFloor === 67.45, p2);
ok("levels 供轮询加速使用（78 / 60.5）", p2 && p2.levels.indexOf(78) >= 0 && p2.levels.indexOf(60.5) >= 0, p2 && p2.levels);
ok("保存后计划摘要已更新", h2.txt("planSummary").includes("减仓 92–97"), h2.txt("planSummary"));

/* ---------- 5) 日内参考位 + 备用数据源 ---------- */
console.log("\n[日内参考位（机械计算）与备用源]");
const C = h1.win.RADAR_CORE;
ok("页面包含『日内参考位』卡片", html.includes("日内参考位") && html.includes('id="refs"'));
ok("卡片标注『机械位，非建议』", html.includes("机械位，非建议"));
ok("核心导出 parseEastmoney / intradayRefs", !!(C.parseEastmoney && C.intradayRefs && C.lotOf && C.eastmoneySecid));
ok("secid 映射：港股/沪/深/北/美股",
  C.eastmoneySecid("hk06166") === "116.06166" && C.eastmoneySecid("sh603083") === "1.603083" &&
  C.eastmoneySecid("sz000001") === "0.000001" && C.eastmoneySecid("bj835185") === "0.835185" &&
  C.eastmoneySecid("usAAPL") === null);
ok("每手股数：港股 50 / A股 100", C.lotOf("hk06166") === 50 && C.lotOf("sh603083") === 100);

// 东财报文（真实格式裁剪：时间,开,收,高,低,分钟量,分钟额,均价）
const EM = { data: { code: "603083", name: "剑桥科技", preClose: 167.2, trends: [
  "2026-10-16 09:30,174.00,174.00,174.00,174.00,2704,47049600.00,174.000",
  "2026-10-16 09:31,174.00,173.60,174.00,173.50,3000,52080000.00,173.890",
  "2026-10-16 15:00,168.88,168.51,168.88,168.51,8632,145460697.00,169.906"
] } };
const em = C.parseEastmoney(EM, "sh603083");
ok("备用源解析成功", em.ok === true && em.source === "eastmoney");
ok("备用源：3 个分时点 / 量累加", em.points.length === 3 && em.points[1].cumVol === 570400, em.points[1].cumVol);
ok("备用源：涨跌幅由昨收算出", Math.abs(em.quote.changePct - (168.51 - 167.2) / 167.2 * 100) < 1e-6, em.quote.changePct);
ok("备用源：日内高低从分时推出", em.quote.high === 174 && em.quote.low === 168.51, [em.quote.high, em.quote.low]);
ok("备用源：空 trends → ok=false", C.parseEastmoney({ data: { trends: [] } }, "sh603083").ok === false);

// 用线上渲染出来的 refs 断言（场景一：A股 603083 + 100 股 @175）
const refsText = h1.deep("refs");
ok("A股场景：参考位卡片有内容", refsText.length > 20, refsText.slice(0, 80));
ok("A股场景：显示减仓参考段", refsText.includes("减仓参考"), refsText.slice(0, 120));
ok("A股场景：显示现价分隔", refsText.includes("现价 168.51"), refsText.slice(0, 160));
ok("A股场景：标注 T+1", h1.txt("refsBias").includes("T+1"), h1.txt("refsBias"));
ok("A股场景：有依据文字（前高/均价/枢轴/关口）",
  /前高|均价|枢轴|整数关口|昨收|开盘|成本/.test(refsText), refsText.slice(0, 160));
ok("A股场景：声明非预测", refsText.includes("非预测") && refsText.includes("不构成投资建议"), refsText.slice(-120));
ok("A股场景：加仓参考被过滤到风控线 160 之上",
  C.intradayRefs({ price: 168.51, high: 174, low: 166.58, open: 174, prevClose: 167.2, vwap: 169.9, vwapDevPct: -0.8, volRatio: 1 }, [], { shares: 100, cost: 175 }, { code: "sh603083", plan: PLAN }).add.every((x) => x.price > 160));
// 全新安装场景：无持仓 → 减仓一侧应为「观察」
ok("空仓场景：参考位显示『观察』", h2.deep("refs").includes("观察"), h2.deep("refs").slice(0, 200));


/* ---------- 6) 多周期 K 线（5/15/30/60）+ 3 日背景 ---------- */
console.log("\n[多周期 K 线与 3 日背景]");
ok("页面包含『多周期节奏』卡片", html.includes("多周期节奏") && html.includes('id="mp"'));
ok("核心导出多周期函数", !!(C.buildBars && C.ema && C.periodStats && C.multiPeriod && C.threeDayContext && C.shortTermPlan));
const mpBars = C.buildBars([
  { date: "20261016", hhmm: "0930", slot: 0, price: 10, volInc: 100 },
  { date: "20261016", hhmm: "0931", slot: 1, price: 10.2, volInc: 100 },
  { date: "20261016", hhmm: "0945", slot: 15, price: 10.5, volInc: 100 }
], 15);
ok("聚合：两天槽位 → 2 根 15 分钟 K", mpBars.length === 2, mpBars.length);
ok("聚合：首根 OHLC 正确", mpBars[0].o === 10 && mpBars[0].c === 10.2 && mpBars[0].v === 200, mpBars[0]);
ok("EMA 正确", Math.abs(C.ema([1, 2, 3], 2)[2] - 2.5556) < 1e-3);
const emPts = C.parseEastmoney(makeEmPayload(), "sh603083").points;
ok("合成 3 天数据解析成分钟点", emPts.length === 360, emPts.length);
const mp3 = C.multiPeriod(emPts);
ok("多周期：4 个周期都有统计", mp3.valid === 4, mp3.valid);
ok("多周期：上行数据 → 偏多/强多", ["偏多", "强多", "弱多"].includes(mp3.bias), mp3.bias);
const ctx3 = C.threeDayContext(emPts, 3);
ok("3 日背景：识别出 3 天", ctx3.days === 3, ctx3.days);
ok("3 日背景：累计涨跌为正", ctx3.chgPct > 0, ctx3.chgPct);
ok("3 日背景：区间位置 0–100", ctx3.posInRange >= 0 && ctx3.posInRange <= 100, ctx3.posInRange);
ok("3 日背景：量能比有值", ctx3.volRatio != null, ctx3.volRatio);
// 渲染：A 股场景（含历史源）应出现四行周期
const mpText = h1.deep("mp");
ok("渲染：多周期卡片有 4 个周期标签", ["5分", "15分", "30分", "60分"].every((x) => mpText.includes(x)), mpText.slice(0, 160));
ok("渲染：显示共振结论", h1.txt("mpBias").includes("共振"), h1.txt("mpBias"));
ok("渲染：显示 3 日背景", mpText.includes("近3日"), mpText.slice(-200));
ok("渲染：显示时机建议", /回踩|减仓|区间|共振|分歧/.test(mpText), mpText.slice(-200));
// 短周期数据不足时也要能优雅降级
ok("数据不足时不抛异常", (() => { try { C.shortTermPlan({ price: 10, vwap: 10, vwapDevPct: 0 }, [], { shares: 0, cost: 0 }, { code: "hk06166" }); return true; } catch (e) { return false; } })());


/* ---------- 7) 第三兜底：腾讯快照 + 退避 ---------- */
console.log("\n[第三兜底与退避]");
ok("核心导出快照解析与退避", !!(C.parseTencentSnapshot && C.backoffDelay));
const sq = new Array(60).fill("0");
sq[1] = "剑桥科技"; sq[2] = "06166"; sq[3] = "84.150"; sq[4] = "81.600"; sq[5] = "85.850"; sq[6] = "9825285.0";
sq[30] = "2026/10/16 16:08:22"; sq[31] = "2.550"; sq[32] = "3.13"; sq[33] = "87.650"; sq[34] = "82.750";
sq[37] = "837019141.750"; sq[39] = "111.55"; sq[43] = "6.00"; sq[48] = "172.900"; sq[49] = "60.500"; sq[59] = "50";
const snap = C.parseTencentSnapshot('v_hk06166="' + sq.join("~") + '";', "hk06166");
ok("快照：解析出报价", snap && snap.ok && snap.quote.price === 84.15 && snap.quote.time === "16:08:22", snap && snap.quote);
ok("快照：没有分时点", snap && snap.points.length === 0);
ok("快照：无效文本 → null", C.parseTencentSnapshot("<html>", "hk06166") === null);
ok("退避：1/2/3/10 → 60/120/240/300 秒",
  C.backoffDelay(1) === 60000 && C.backoffDelay(2) === 120000 && C.backoffDelay(3) === 240000 && C.backoffDelay(10) === 300000,
  [C.backoffDelay(1), C.backoffDelay(2), C.backoffDelay(3), C.backoffDelay(10)]);
ok("页面包含快照模式提示与三源兜底", html.includes("快照模式") && html.includes("qt.gtimg.cn"));


/* ---------- 8) 最坏情况：分钟线 501 + 东财拒绝 → 快照兜底仍能报价 ---------- */
console.log("\n[三源全挂时的快照兜底]");
const sq2 = new Array(60).fill("0");
sq2[1] = "剑桥科技"; sq2[2] = "06166"; sq2[3] = "84.150"; sq2[4] = "81.600"; sq2[5] = "85.850"; sq2[6] = "9825285.0";
sq2[30] = "2026/10/16 16:08:22"; sq2[31] = "2.550"; sq2[32] = "3.13"; sq2[33] = "87.650"; sq2[34] = "82.750";
sq2[37] = "837019141.750"; sq2[39] = "111.55"; sq2[43] = "6.00"; sq2[48] = "172.900"; sq2[49] = "60.500"; sq2[59] = "50";
const h3 = makeHarness(
  { code: "hk06166", watch: ["hk06166"], sound: false, chartMode: "min",
    pos: { hk06166: { shares: 200, cost: 96.7, realized: 0 } }, plans: {}, trade: {}, lastFired: {} },
  () => null,
  { snapshotOnly: true, snapshotText: 'v_hk06166="' + sq2.join("~") + '";' });
let threw3 = null;
try { h3.run(coreSrc); h3.run(uiSrc); } catch (e) { threw3 = e; }
ok("快照场景：脚本执行无异常", !threw3, threw3 && threw3.message);
await new Promise((r) => setTimeout(r, 350));
ok("快照场景：仍能显示现价 84.15", h3.txt("px") === "84.15", h3.txt("px"));
ok("快照场景：显示涨跌幅 +3.13%", h3.txt("chg").includes("+3.13"), h3.txt("chg"));
ok("快照场景：提示『快照模式』", h3.txt("snapHint").includes("快照模式"), h3.txt("snapHint"));
ok("快照场景：数据时间标『快照』", h3.txt("qtime").includes("快照"), h3.txt("qtime"));
ok("快照场景：回本价仍可算（需成本）", h3.txt("posInfo").includes("回本价 96.70"), h3.txt("posInfo"));
ok("快照场景：多周期显示数据不足而非报错", h3.deep("mp").includes("周期数据不足") || h3.deep("mp").includes("快照"), h3.deep("mp").slice(0, 120));
ok("快照场景：日内参考位给出无分时降级提示", h3.deep("refs").includes("无分时数据"), h3.deep("refs").slice(0, 120));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
