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
    if (o.hostFail) {
      // 模拟某条线路被限流：命中 hostFail 的返回 501，其余正常返回腾讯报文
      if (o.hostFail.some((h) => u.indexOf(h) >= 0)) {
        return { ok: false, status: 501, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
      }
      const payload = payloadFor(o.codeFor || "sh603083");
      if (!payload) return { ok: true, json: async () => ({ code: 0, data: {} }) };
      return { ok: true, json: async () => payload };
    }
    if (o.snapshotOnly) {
      if (u.indexOf("qt.gtimg.cn") >= 0) {
        return { ok: true, arrayBuffer: async () => o.snapshotBuffer, text: async () => "" };
      }
      return { ok: false, status: 501, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
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
sq2[0] = "100"; sq2[2] = "06166"; sq2[3] = "84.150"; sq2[4] = "81.600"; sq2[5] = "85.850"; sq2[6] = "9825285.0";
sq2[30] = "2026/10/16 16:08:22"; sq2[31] = "2.550"; sq2[32] = "3.13"; sq2[33] = "87.650"; sq2[34] = "82.750";
sq2[37] = "837019141.750"; sq2[39] = "111.55"; sq2[43] = "6.00"; sq2[48] = "172.900"; sq2[49] = "60.500"; sq2[59] = "50";
// 用真实 GBK 字节拼出快照响应（"剑桥科技" = BD A3 C7 C5 BF C6 BC BC）
const head = 'v_hk06166="' + sq2[0] + "~";
const tail = "~" + sq2.slice(2).join("~") + '";';
const asciiBytes = (s) => Array.from(s).map((c) => c.charCodeAt(0));
const nameGbk = [0xBD, 0xA3, 0xC7, 0xC5, 0xBF, 0xC6, 0xBC, 0xBC];
const gbkBytes = Uint8Array.from([].concat(asciiBytes(head), nameGbk, asciiBytes(tail)));
const h3 = makeHarness(
  { code: "hk06166", watch: ["hk06166"], sound: false, chartMode: "min",
    pos: { hk06166: { shares: 200, cost: 96.7, realized: 0 } }, plans: {}, trade: {}, lastFired: {} },
  () => null,
  { snapshotOnly: true, snapshotBuffer: gbkBytes.buffer });
let threw3 = null;
try { h3.run(coreSrc); h3.run(uiSrc); } catch (e) { threw3 = e; }
ok("快照场景：脚本执行无异常", !threw3, threw3 && threw3.message);
await new Promise((r) => setTimeout(r, 350));
ok("GBK 解码：字节 → 剑桥科技", C.decodeText(gbkBytes, "gbk").includes("剑桥科技"), C.decodeText(gbkBytes, "gbk").slice(0, 40));
ok("快照场景：仍能显示现价 84.15", h3.txt("px") === "84.15", h3.txt("px"));
ok("快照场景：中文名不乱码", h3.txt("name").includes("剑桥科技"), h3.txt("name"));
ok("快照场景：显示涨跌幅 +3.13%", h3.txt("chg").includes("+3.13"), h3.txt("chg"));
ok("快照场景：提示『快照模式』", h3.txt("snapHint").includes("快照模式"), h3.txt("snapHint"));
ok("快照场景：数据时间标『快照』", h3.txt("qtime").includes("快照"), h3.txt("qtime"));
ok("快照场景：回本价仍可算（需成本）", h3.txt("posInfo").includes("回本价 96.70"), h3.txt("posInfo"));
ok("快照场景：多周期显示数据不足而非报错", h3.deep("mp").includes("周期数据不足") || h3.deep("mp").includes("快照"), h3.deep("mp").slice(0, 120));
ok("快照场景：日内参考位给出无分时降级提示", h3.deep("refs").includes("无分时数据"), h3.deep("refs").slice(0, 120));


/* ---------- 9) 版本号与强制更新（家人自查是否最新） ---------- */
console.log("\n[版本号与强制更新]");
ok("页面包含版本号常量", /APP_VERSION\s*=\s*"v[\d.]+/.test(html), (html.match(/APP_VERSION\s*=\s*"[^"]*"/) || [])[0]);
ok("页脚有强制更新按钮", html.includes('id="btnForce"') && html.includes("强制更新"));
ok("页脚显示版本（场景一）", /版本\s*v\d/.test(h1.txt("footVer")), h1.txt("footVer"));
ok("强制更新按钮已注册点击", (h1.byId("btnForce").listeners.click || []).length > 0);


/* ---------- 10) 多线路兜底 ---------- */
console.log("\n[多线路兜底]");
const uu = C.quoteUrls("hk06166");
ok("PWA：腾讯 3 条 + 东财 3 条 + 快照 1 条",
  uu.tencent.length === 3 && uu.eastmoney.length === 3 && uu.snapshot.length === 1,
  [uu.tencent.length, uu.eastmoney.length, uu.snapshot.length]);
ok("PWA：3 个不同域名", new Set(uu.tencent.map((u) => u.split("/")[2])).size === 3, uu.tencent.map((u) => u.split("/")[2]));
ok("PWA：A股 secid 正确", C.quoteUrls("sh603083").eastmoney[0].indexOf("secid=1.603083") >= 0);
ok("PWA：美股无东财线路", C.quoteUrls("usAAPL").eastmoney.length === 0);


/* ---------- 11) 线路级故障切换：第一条被限流 → 自动用第二条 ---------- */
console.log("\n[线路级故障切换]");
const h4 = makeHarness(
  { code: "sh603083", watch: ["sh603083"], sound: false, chartMode: "min",
    pos: { sh603083: { shares: 100, cost: 175, realized: 0 } }, plans: {}, trade: {}, lastFired: {} },
  (code) => (code === "sh603083" ? aSharePayload() : null),
  { hostFail: ["web.ifzq.gtimg.cn"], codeFor: "sh603083" });
let threw4 = null;
try { h4.run(coreSrc); h4.run(uiSrc); } catch (e) { threw4 = e; }
ok("线路切换场景：脚本无异常", !threw4, threw4 && threw4.message);
await new Promise((r) => setTimeout(r, 400));
ok("线路切换：主线路 501 时仍显示现价 168.51", h4.txt("px") === "168.51", h4.txt("px"));
ok("线路切换：数据完整（均价 169.9）", h4.deep("grid").includes("169.90"), h4.deep("grid"));
ok("线路切换：未误报警告条（不是快照模式）", h4.txt("snapHint") === "", h4.txt("snapHint"));


/* ---------- 12) 源健康统计 ---------- */
console.log("\n[源健康统计]");
ok("页面含源健康行", html.includes("footHealth") && html.includes("源健康"));
const hh = C.bumpSrcHealth({}, "tencent", 1000);
C.bumpSrcHealth(hh, "fail", 5000);
C.bumpSrcHealth(hh, "eastmoney", 120000);
ok("统计：成功/失败计数正确", hh.tencent === 1 && hh.fail === 1 && hh.eastmoney === 1, hh);
ok("统计：恢复后累计不可用 115s", hh.downMs === 115000 && hh.downStart === 0, [hh.downMs, hh.downStart]);
ok("统计：文案含累计不可用", C.srcHealthText(hh).includes("累计不可用"), C.srcHealthText(hh));
ok("渲染：页脚显示源健康", h1.txt("footHealth").includes("源健康"), h1.txt("footHealth"));
ok("渲染：一次成功取数后腾讯计数 +1", /腾讯 1/.test(h1.txt("footHealth")), h1.txt("footHealth"));


/* ---------- 13) 加减仓数量按持仓比例 + 计划支持加仓 + 一键建议 ---------- */
console.log("\n[数量分配 / 加仓计划 / 一键建议]");
ok("核心导出 suggestQtys / suggestPlan", !!(C.suggestQtys && C.suggestPlan));

// 1000 股持仓：减仓应分 200/300/500，而不是一律 100
const q1000 = C.suggestQtys({ shares: 1000 }, null,
  { reduce: [{ price: 110 }, { price: 115 }, { price: 120 }], add: [{ price: 90 }, { price: 85 }] }, "sh603083");
ok("减仓数量按 25%/35%/剩余 分配（200/300/500）",
  q1000.reduce.map((x) => x.qty).join(",") === "200,300,500", q1000.reduce.map((x) => x.qty));
ok("加仓数量按容量 50%/剩余 分配（200/300）",
  q1000.add.map((x) => x.qty).join(",") === "200,300", q1000.add.map((x) => x.qty));
ok("加仓总量不超过容量（500）", q1000.add.reduce((a, b) => a + b.qty, 0) === 500);

// 有仓位上限时，可用容量 = 上限 − 持仓
const qCap = C.suggestQtys({ shares: 100 }, { maxShares: 500 },
  { reduce: [{ price: 110 }, { price: 120 }], add: [{ price: 90 }, { price: 85 }] }, "sh603083");
ok("减仓：只持 1 手时分完即止（100/0）", qCap.reduce.map((x) => x.qty).join(",") === "100,0", qCap.reduce.map((x) => x.qty));
ok("加仓：容量 400 分 200/200", qCap.add.map((x) => x.qty).join(",") === "200,200", qCap.add.map((x) => x.qty));

// suggestPlan：把触发价整理成计划
const refsForPlan = { ok: true,
  reduce: [{ price: 110, why: "均价 +1.2×", qty: 200 }, { price: 115, why: "枢轴 R1", qty: 300 }, { price: 120, why: "前高", qty: 500 }],
  add: [{ price: 90, why: "枢轴 S1", qty: 200 }, { price: 85, why: "前低", qty: 300 }] };
const spTest = C.suggestPlan({ price: 100, high: 105, low: 95, prevClose: 99, vwap: 100, vwapDevPct: 0, volRatio: 1 },
  refsForPlan, { keySup: [95, 90] }, { days: 3 }, { shares: 1000, cost: 96 }, "sh603083");
ok("建议计划：3 个减仓档", spTest.takes.length === 3, spTest.takes.length);
ok("建议计划：2 个加仓档（含股数）", spTest.buys.length === 2 && spTest.buys[0].shares > 0, spTest.buys);
ok("建议计划：1 条止损线且低于现价", spTest.reds.length === 1 && spTest.reds[0].at < 100, spTest.reds);
ok("建议计划：仓位上限按本金/价格取整", spTest.maxShares >= 100 && spTest.maxShares % 100 === 0, spTest.maxShares);
ok("建议计划：levels 汇总用于轮询加速", spTest.levels.length === 6, spTest.levels);

// 表单：加仓字段 + 保存后 plan.buys 有值
h2.byId("fB1lo").value = 90; h2.byId("fB1hi").value = 92;
h2.byId("fB2lo").value = 86; h2.byId("fB2hi").value = 88;
h2.byId("fMax").value = 500;
h2.byId("btnPlanSave").listeners.click[0]();
const savedB = h2.saved().plans.hk06166;
ok("保存后计划含 2 个加仓档", savedB && savedB.buys.length === 2, savedB && savedB.buys);
ok("加仓档带股数（容量 400 → 200/120 取整手）", savedB && savedB.buys[0].shares > 0, savedB && savedB.buys.map((b) => b.shares));
ok("计划摘要显示加仓", h2.txt("planSummary").includes("加仓 90–92"), h2.txt("planSummary"));

// 一键生成建议：点按钮后表单被填充
h2.byId("btnPlanSuggest").listeners.click[0]();
ok("一键建议：减仓1 下沿被填充", h2.byId("fT1lo").value !== "", h2.byId("fT1lo").value);
ok("一键建议：加仓1 下沿被填充", h2.byId("fB1lo").value !== "", h2.byId("fB1lo").value);
ok("一键建议：止损线被填充", h2.byId("fRwarn").value !== "", h2.byId("fRwarn").value);
ok("一键建议：提示文案出现", h2.txt("planSuggestTip").includes("已填入建议"), h2.txt("planSuggestTip"));


/* ---------- 14) 共识评分引擎 / 指标 / 台账 ---------- */
console.log("\n[共识评分引擎与台账]");
ok("核心导出指标与引擎", !!(C.macdCalc && C.kdjCalc && C.volumeState && C.regimeOf && C.scoreSetup && C.ledgerAdd && C.ledgerEval && C.ledgerStats));

// 合成数据：3 天 × 240 根 1 分钟
function synth(days, perDay, drift) {
  const pts = [];
  let price = 100;
  for (let d = 0; d < days; d++) {
    const date = "2026-10-" + String(15 + d).padStart(2, "0");
    for (let i = 0; i < perDay; i++) {
      price += drift + Math.sin(i / 7) * 0.05;
      pts.push({ date, slot: i, hhmm: String(9 + Math.floor(i / 60)).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0"), price, volInc: 100 * (1 + 0.3 * Math.sin(i / 11)), cumVol: 0 });
    }
  }
  return pts;
}
const upPts = synth(3, 240, 0.02);
const flatPts = synth(3, 240, 0.0);

// MACD：上升序列 → 多头且零轴上方
const macdUp = C.macdCalc(upPts.map((p) => p.price));
ok("MACD：上升序列 DIF>DEA 且在零轴上方", macdUp && macdUp.bull && macdUp.aboveZero, macdUp && { dif: macdUp.dif, dea: macdUp.dea });
ok("MACD：字段齐全", macdUp && typeof macdUp.hist === "number" && ["gold", "dead", null].includes(macdUp.cross));

// KDJ：上升序列 K>50
const barsUp = C.buildBars(upPts, 5);
const kdjUp = C.kdjCalc(barsUp);
ok("KDJ：上升序列 K>50 且 K>D", kdjUp && kdjUp.k > 50 && kdjUp.bull, kdjUp && { k: kdjUp.k, d: kdjUp.d, j: kdjUp.j });

// 量价状态
function mkBars(list) { return list.map((x) => ({ o: x[0], h: x[1], l: x[2], c: x[3], v: x[4] })); }
const flat19 = []; for (let i = 0; i < 19; i++) flat19.push([100, 100.5, 99.5, 100, 100]);
const vBreakout = mkBars(flat19.concat([[100, 101, 100, 101, 200]]));
ok("量价：放量突破", C.volumeState(vBreakout) === "breakout", C.volumeState(vBreakout));
const vShrink = mkBars(flat19.concat([[100, 101, 100, 101, 40]]));
ok("量价：缩量新高（警惕）", C.volumeState(vShrink) === "shrinkNewHigh", C.volumeState(vShrink));
const vStall = mkBars(flat19.concat([[100, 101, 99, 99, 300]]));
ok("量价：放量滞涨", C.volumeState(vStall) === "stallHighVol", C.volumeState(vStall));
const vHealthy = mkBars(flat19.concat([[100, 100.5, 99, 99, 40]]));
ok("量价：缩量回调（健康）", C.volumeState(vHealthy) === "healthyPullback", C.volumeState(vHealthy));

// 市场状态
ok("状态：4 周期 +3 → 趋势向上", C.regimeOf({ valid: 4, score: 3 }) === "trendUp", C.regimeOf({ valid: 4, score: 3 }));
ok("状态：方向分歧 → 震荡", C.regimeOf({ valid: 4, score: 1 }) === "chop", C.regimeOf({ valid: 4, score: 1 }));

// 共识评分：上升数据 → 偏多且给出可执行单子
const mpUp = C.multiPeriod(upPts);
const ctxUp = C.threeDayContext(upPts, 3);
const mUp = { price: upPts[upPts.length - 1].price, prevClose: 100, high: 105, low: 95, vwap: upPts[upPts.length - 1].price * 0.995, vwapDevPct: 0.5, volRatio: 1.2 };
const refsUp = C.intradayRefs(mUp, upPts, { shares: 0, cost: 0 }, { code: "sh603083", plan: null });
const spUp = C.scoreSetup(mUp, mpUp, ctxUp, refsUp, { shares: 0, cost: 0 }, null, { code: "sh603083", points: upPts });
ok("评分：上升数据 → ok 且有评分", spUp.ok && spUp.score >= 0 && spUp.score <= 100, spUp.score);
ok("评分：指标覆盖 5/15 分钟（30/60 需更长历史）", !!(spUp.indicators[5] && spUp.indicators[15]), Object.keys(spUp.indicators));
ok("评分：给出理由列表", spUp.reasons.length > 0, spUp.reasons.slice(0, 3));
ok("评分：方向为多或拒绝", spUp.side === "long" || spUp.grade === "noTrade", [spUp.side, spUp.grade]);
ok("评分：等级合法", ["A", "B", "C", "noTrade"].includes(spUp.grade), spUp.grade);
if (spUp.entry) {
  ok("评分：止损 < 入场 < 目标", spUp.stop < spUp.entry.lo && spUp.target > spUp.entry.hi, [spUp.stop, spUp.entry, spUp.target]);
  ok("评分：盈亏比 >= 2 才不否决", spUp.rr >= 2 || spUp.vetoes.some((v) => v.indexOf("盈亏比") >= 0), spUp.rr);
}

// 震荡 → 拒绝交易（直接构造 mp，避免合成数据的巧合）
const mChop = { price: 100, prevClose: 100, high: 101, low: 99, vwap: 100, vwapDevPct: 0, volRatio: 1 };
const spChop = C.scoreSetup(mChop, { valid: 4, score: 0, keyRes: [101], keySup: [99], byPeriod: {} },
  ctxUp, refsUp, { shares: 0, cost: 0 }, null, { code: "sh603083", points: upPts });
ok("评分：震荡区 → 拒绝交易", spChop.grade === "noTrade", spChop.grade);
ok("评分：震荡否决原因明确", spChop.vetoes.some((v) => v.indexOf("震荡") >= 0), spChop.vetoes);

// 追高 → 拒绝
const spChase = C.scoreSetup({ price: 100, prevClose: 99, high: 100, low: 98, vwap: 96.5, vwapDevPct: 3.6, volRatio: 1 },
  { valid: 4, score: 4, keyRes: [], keySup: [99], byPeriod: {} }, ctxUp, refsUp, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: upPts });
ok("评分：距均价过远 → 拒绝（追高）", spChase.grade === "noTrade" && spChase.vetoes.some((v) => v.indexOf("追高") >= 0), spChase.vetoes);

// 空仓时看空 → 拒绝（不做空）
const spNoPos = C.scoreSetup({ price: 100, prevClose: 101, high: 101, low: 99, vwap: 100.5, vwapDevPct: -0.5, volRatio: 1 },
  { valid: 4, score: -4, keyRes: [101], keySup: [95], byPeriod: {} }, ctxUp, refsUp, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: upPts });
ok("评分：空仓看空 → 拒绝（不做空）", spNoPos.grade === "noTrade" && spNoPos.vetoes.some((v) => v.indexOf("无持仓") >= 0), spNoPos.vetoes);

// 台账：记录 → 结算 → 统计
let lg = { records: [] };
const setupWin = { ok: true, grade: "B", side: "long", score: 72, entry: { lo: 100, hi: 100 }, stop: 98.5, target: 103, rr: 2, size: 100 };
C.ledgerAdd(lg, setupWin, "sh603083", 1000);
ok("台账：记录 1 条（open）", lg.records.length === 1 && lg.records[0].status === "open", lg.records[0]);
C.ledgerEval(lg, "sh603083", 103.2, 2000);
ok("台账：到目标 → result=target", lg.records[0].result === "target", lg.records[0].result);
ok("台账：收益 +3%", Math.abs(lg.records[0].retPct - 3) < 1e-6, lg.records[0].retPct);
C.ledgerAdd(lg, { ok: true, grade: "A", side: "long", score: 80, entry: { lo: 100, hi: 100 }, stop: 98, target: 104, rr: 2, size: 100 }, "sh603083", 3000);
C.ledgerEval(lg, "sh603083", 97.5, 4000);
ok("台账：打止损 → result=stop 且收益为负", lg.records[1].result === "stop" && lg.records[1].retPct < 0, [lg.records[1].result, lg.records[1].retPct]);
const stt = C.ledgerStats(lg);
ok("台账：统计 2 笔、胜 1 负 1、胜率 50%", stt.total === 2 && stt.target === 1 && stt.stop === 1 && Math.abs(stt.winRate - 50) < 1e-6, stt);
ok("台账：期望值可算", stt.expectancy != null && typeof stt.expectancy === "number", stt.expectancy);
ok("台账：noTrade 不记录", (function () { const l2 = { records: [] }; C.ledgerAdd(l2, { grade: "noTrade", side: "long" }, "x", 1); return l2.records.length === 0; })());

// 页面渲染：卡片存在且显示
ok("页面含智能信号卡片", html.includes("sigBox") && html.includes("智能信号"));
ok("页面含信号台账卡片", html.includes("ledgerBox") && html.includes("信号台账"));
ok("渲染：智能信号有内容", h1.deep("sigBox").length > 10, h1.deep("sigBox").slice(0, 60));
ok("渲染：台账有内容", h1.deep("ledgerBox").length > 5, h1.deep("ledgerBox").slice(0, 60));


/* ---------- 15) 涨跌停显式规则 ---------- */
console.log("\n[涨跌停规则]");
ok("涨停幅度：主板 10%", C.limitPctOf("sh600519") === 0.10, C.limitPctOf("sh600519"));
ok("涨停幅度：创业板 20%", C.limitPctOf("sz300750") === 0.20, C.limitPctOf("sz300750"));
ok("涨停幅度：科创板 20%", C.limitPctOf("sh688981") === 0.20, C.limitPctOf("sh688981"));
ok("涨停幅度：北交所 30%", C.limitPctOf("bj835185") === 0.30, C.limitPctOf("bj835185"));
ok("涨停幅度：港股/美股无涨跌停", C.limitPctOf("hk06166") === null && C.limitPctOf("usAAPL") === null);

const limUp = C.limitStateOf({ price: 67.22, prevClose: 61.11 }, "sz003021");
ok("封板判定：67.22 = 61.11×1.1 → 涨停", limUp && limUp.atUp && limUp.up === 67.22, limUp);
const limDown = C.limitStateOf({ price: 55.0, prevClose: 61.11 }, "sz003021");
ok("封板判定：55.00 = 61.11×0.9 → 跌停", limDown && limDown.atDown && limDown.down === 55.0, limDown);
ok("封板判定：未封板", C.limitStateOf({ price: 64.0, prevClose: 61.11 }, "sz003021").atUp === false);

// 用 003021 的真实行情结构跑一遍：涨停 + 强多头证据 → 仍然拒绝
const limPts = synth(1, 193, 0.04);
const limMp = C.multiPeriod(limPts);
const limM = { price: 67.22, prevClose: 61.11, high: 67.22, low: 59.52, vwap: 63.54, vwapDevPct: 5.79, volRatio: 0.26 };
const limRefs = C.intradayRefs(limM, limPts, { shares: 0, cost: 0 }, { code: "sz003021", plan: null });
const limMp2 = { valid: 4, score: 4, bias: "强多", keyRes: [68.5, 69.5], keySup: [64.4, 63.5], byPeriod: {} };
const limSp = C.scoreSetup(limM, limMp2, null, limRefs, { shares: 0, cost: 0 }, null, { code: "sz003021", points: limPts });
ok("涨停 + 多头：等级 = 不交易", limSp.grade === "noTrade", limSp.grade);
ok("涨停：否决原因出现『当日无上行空间』", limSp.vetoes.some((v) => v.indexOf("当日无上行空间") >= 0), limSp.vetoes);
ok("涨停：限价信息随信号返回", limSp.limit && limSp.limit.atUp === true, limSp.limit);


/* ---------- 16) 洗盘 / 出货证据检测 ---------- */
console.log("\n[洗盘/出货检测]");
ok("导出 washoutDetect", typeof C.washoutDetect === "function");
ok("数据不足 → ok=false", C.washoutDetect({ price: 100, prevClose: 100, vwap: 100 }, [], null, null, "sh600418", {}).ok === false);

// 出货样本：放量下跌、全天在均价下方、贴日内低、尾盘放量下杀
const distPts = [];
for (let i = 0; i < 100; i++) distPts.push({ date: "2026-10-16", slot: i, price: 100 + Math.sin(i) * 0.02, volInc: 300 });
for (let i = 0; i < 200; i++) distPts.push({ date: "2026-10-19", slot: i, price: 100 - i * 0.02, volInc: i >= 170 ? 600 : 400 });
const distM = { price: 96, prevClose: 100, high: 100.2, low: 96, vwap: 98.5, vwapDevPct: -2.5 };
const wDist = C.washoutDetect(distM, distPts, { valid: 3, score: -3, keySup: [95], keyRes: [97] }, null, "sh600418", {});
ok("出货样本 → 倾向出货", wDist.ok && wDist.verdict === "distribution", [wDist.verdict, wDist.summary]);
ok("出货样本：出货特征计数 > 洗盘特征", wDist.dist > wDist.wash, [wDist.wash, wDist.dist]);
ok("出货样本：关键位返回支撑/压力", wDist.support != null && wDist.resistance != null, [wDist.support, wDist.resistance]);

// 洗盘样本：缩量下探后放量收回、多数时间在均价上方、尾盘回拉
const washPts = [];
for (let i = 0; i < 200; i++) washPts.push({ date: "2026-10-16", slot: i, price: 100, volInc: 400 });
for (let i = 0; i < 40; i++) washPts.push({ date: "2026-10-19", slot: i, price: 100 - i * 0.02, volInc: 60 });
for (let i = 40; i < 200; i++) {
  const t = (i - 40) / 159;
  washPts.push({ date: "2026-10-19", slot: i, price: 99.2 + t * 1.1, volInc: i >= 170 ? 350 : 250 });
}
const washM = { price: 100.3, prevClose: 100, high: 100.3, low: 99.2, vwap: 99.5, vwapDevPct: 0.8 };
const wWash = C.washoutDetect(washM, washPts, { valid: 3, score: 2, keySup: [99.4], keyRes: [100.6] }, null, "sh600418", {});
ok("洗盘样本 → 倾向洗盘", wWash.ok && wWash.verdict === "washout", [wWash.verdict, wWash.summary]);
ok("洗盘样本：洗盘特征计数 > 出货特征", wWash.wash > wWash.dist, [wWash.wash, wWash.dist]);

// 接入共识评分：出货特征明显 → 否决做多
const washRefs = C.intradayRefs(distM, distPts, { shares: 0, cost: 0 }, { code: "sh600418", plan: null });
const spDist = C.scoreSetup(distM, { valid: 4, score: 4, bias: "强多", keyRes: [97], keySup: [95], byPeriod: {} }, null,
  washRefs, { shares: 0, cost: 0 }, null, { code: "sh600418", points: distPts });
ok("评分：出货特征 → 一票否决『不做多』", spDist.vetoes.some((v) => v.indexOf("出货特征明显") >= 0), spDist.vetoes);
ok("评分：返回 wash 检测结果", !!spDist.wash && spDist.wash.verdict === "distribution", spDist.wash && spDist.wash.verdict);

// 页面渲染
ok("页面含洗盘/出货检测卡片", html.includes("washBox") && html.includes("洗盘 / 出货检测"));
ok("渲染：洗盘/出货卡片有内容", h1.deep("washBox").length > 10, h1.deep("washBox").slice(0, 60));


/* ---------- 17) 日线 / 盘口 / ATR / 大盘 RS ---------- */
console.log("\n[日线/盘口/ATR/大盘]");
ok("导出四个新函数", !!(C.parseTencentKline && C.dailyTrend && C.atrCalc && C.orderBookStats));

const kjson = { data: { sh600418: { day: [
  ["2026-10-15", "22.00", "21.50", "22.10", "21.40", "1000"],
  ["2026-10-16", "21.60", "22.37", "22.50", "21.55", "1200"],
  ["2026-10-19", "23.00", "21.98", "23.60", "21.90", "1884514"]
] } } };
const kl = C.parseTencentKline(kjson, "sh600418");
ok("日K解析：3 根，字段对（收/高/低/量）", kl.ok && kl.bars.length === 3 &&
  kl.bars[2].c === 21.98 && kl.bars[2].h === 23.6 && kl.bars[2].l === 21.9 && kl.bars[2].v === 1884514, kl.bars[2]);

function mkDaily(n, step) {
  const arr = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += step;
    arr.push({ date: "2026-01-" + String((i % 28) + 1).padStart(2, "0"), o: p, c: p, h: p + 0.5, l: p - 0.5, v: 1000 });
  }
  return arr;
}
const dyUp = C.dailyTrend(mkDaily(80, 0.2));
ok("日线：上升 → 趋势向上", dyUp.ok && dyUp.trend === "up", [dyUp.trend, dyUp.ma20 && dyUp.ma20.toFixed(2)]);
const dyDown = C.dailyTrend(mkDaily(80, -0.2));
ok("日线：下跌 → 趋势向下", dyDown.ok && dyDown.trend === "down", dyDown.trend);
ok("日线：返回 20/60 日高低与 MACD/KDJ", dyUp.high20 != null && dyUp.high60 != null && !!dyUp.macd && !!dyUp.kdj);

const atrBars = [];
for (let i = 0; i < 20; i++) atrBars.push({ o: 100, c: 100, h: 101, l: 99, v: 100 });
ok("ATR：区间 2 的横盘 → ATR=2", Math.abs(C.atrCalc(atrBars, 14) - 2) < 1e-9, C.atrCalc(atrBars, 14));

const obQuote = {
  outer: 1200, inner: 1000,
  bids: [{ p: 21.97, v: 300 }, { p: 21.96, v: 200 }, { p: 21.95, v: 100 }, { p: 21.94, v: 100 }, { p: 21.93, v: 100 }],
  asks: [{ p: 21.98, v: 100 }, { p: 21.99, v: 100 }, { p: 22.0, v: 200 }, { p: 22.01, v: 100 }, { p: 22.02, v: 100 }],
  turnoverRate: 8.36, limitUp: 24.61, limitDown: 20.13
};
const ob = C.orderBookStats(obQuote);
ok("盘口：委比计算（买 800 vs 卖 600 → +14.3%）", ob.ok && Math.abs(ob.imbalance - 14.2857) < 0.01, ob.imbalance);
ok("盘口：外/内盘比 1.2", Math.abs(ob.buySellRatio - 1.2) < 1e-9, ob.buySellRatio);
ok("盘口：换手率与涨跌停价", ob.turnoverRate === 8.36 && ob.limitUp === 24.61 && ob.limitDown === 20.13, ob);

// 集成：日线向下 → 否决做多
const bullPts = synth(3, 240, 0.03);
const bullM = { price: bullPts[bullPts.length - 1].price, prevClose: 100, high: 110, low: 95, vwap: 105, vwapDevPct: 0.5, volRatio: 1.1 };
const bullRefs = C.intradayRefs(bullM, bullPts, { shares: 0, cost: 0 }, { code: "sh603083", plan: null });
const bullMp = C.multiPeriod(bullPts);
const spDailyDown = C.scoreSetup(bullM, bullMp, null, bullRefs, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: bullPts, daily: dyDown });
ok("集成：日线向下 → 否决『不逆势做多』", spDailyDown.vetoes.some((v) => v.indexOf("不逆势做多") >= 0), spDailyDown.vetoes);
const spDailyUp = C.scoreSetup(bullM, bullMp, null, bullRefs, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: bullPts, daily: dyUp });
ok("集成：日线向上 → 理由含『日线趋势向上』", spDailyUp.reasons.some((r) => r.indexOf("日线趋势向上") >= 0), spDailyUp.reasons.slice(0, 6));

// ATR 止损模式
ok("集成：ATR 止损模式生效", spDailyUp.stopMode === "15分ATR×1.5" || spDailyUp.stopMode === "5分ATR×2.5", spDailyUp.stopMode);
ok("集成：ATR 数值返回", spDailyUp.atr && spDailyUp.atr.atr > 0, spDailyUp.atr);
if (spDailyUp.entry && spDailyUp.stop != null) {
  const mid = (spDailyUp.entry.lo + spDailyUp.entry.hi) / 2;
  const d = Math.abs(spDailyUp.stop / mid - 1) * 100;
  ok("集成：止损距离被限制在 0.8%–6%", d >= 0.79 && d <= 6.01, d.toFixed(2) + "%");
}

// 盘口与大权重接入：委比强 + 大盘弱
const spBook = C.scoreSetup(bullM, bullMp, null, bullRefs, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: bullPts, order: ob, stockPct: 1.2, indexPct: -0.5 });
ok("集成：委比/大盘 RS 进入理由", spBook.reasons.some((r) => r.indexOf("委比") >= 0) || spBook.reasons.some((r) => r.indexOf("强于大盘") >= 0), spBook.reasons.slice(0, 8));

ok("页面含日线/盘口/大盘卡片", html.includes("macroBox") && html.includes("日线 / 盘口 / 大盘"));


/* ---------- 18) 14:57 尾盘观察池（今日特征，非预测） ---------- */
console.log("\n[尾盘观察池]");
ok("导出观察池函数", !!(C.poolWindow && C.rankPoolCandidates && C.parseBatchSnapshot && C.poolHitStats));
const pwin = C.poolWindow(new Date(2026, 9, 19, 14, 57, 0));
ok("时间窗口：14:57 在窗口内", pwin.inWindow === true, pwin);
ok("时间窗口：10:00 不在窗口内", C.poolWindow(new Date(2026, 9, 19, 10, 0, 0)).inWindow === false);

const mk = (code, name, price, chg, hi, lo, vr, to, flow, fp) => ({ code, name, price, chgPct: chg, high: hi, low: lo, volRatio: vr, turnover: to, flowAmt: flow, flowPct: fp });
const lists = {
  up: [mk("sz301119", "A股一号", 34.31, 20.01, 34.31, 26.86, 1.37, 6.47, 36709191, 15.57)],
  vr: [mk("sz002889", "量比王", 12.0, 4.0, 12.1, 11.0, 11.45, 20.45, 28223738, 3.1)],
  turn: [mk("sh600825", "换手王", 8.0, 1.85, 8.5, 7.6, 10.98, 25.26, -1374617184, -8.0)],
  flow: [
    mk("sh600487", "资金王", 22.0, 5.0, 22.2, 20.5, 2.0, 8.18, 1968815728, 12.0),
    mk("sz300502", "资金次", 95.0, 3.0, 96.0, 92.0, 1.5, 2.59, 841737536, 9.0)
  ]
};
const ranked = C.rankPoolCandidates(lists, { limit: 10 });
ok("观察池：涨停被剔除、偏离目标过远也剔除", ranked.ok && ranked.picks.length === 3, ranked.picks.length);
ok("观察池：按分数降序", ranked.picks.every((p, i, arr) => i === 0 || arr[i - 1].score >= p.score), ranked.picks.map((p) => p.score));
const first = ranked.picks[0];
ok("观察池：+5.0% 主板超上限被剔除，300502 排第一", first.code === "sz300502", first.code + " " + first.score);
ok("观察池：超上限（主板≥5%）不进池", !ranked.picks.some((p) => p.code === "sh600487"), ranked.picks.map((p) => [p.code, p.chgPct]));
ok("观察池：涨停股被直接剔除", !ranked.picks.some((p) => p.code === "sz301119"), ranked.picks.map((p) => p.code));
ok("观察池：目标区间随板块（主板5/创业8）", ranked.picks.every((p) => p.targetBand === 5 || p.targetBand === 8), ranked.picks.map((p) => [p.code, p.targetBand]));
ok("观察池：主力净流出带风险标注", ranked.picks.some((p) => p.code === "sh600825" && p.risks.some((r) => r.indexOf("净流出") >= 0)));
ok("观察池：空数据 → ok=false", C.rankPoolCandidates({}, {}).ok === false);
ok("新浪榜单解析", (function () {
  const txt = JSON.stringify([{ symbol: "sz301119", code: "301119", name: "正强股份", trade: "34.310", changepercent: 20.01, high: "34.310", low: "26.860", turnoverratio: 6.47 },
    { symbol: "sh600183", code: "600183", name: "生益科技", trade: "42.10", changepercent: 5.12, high: "42.50", low: "39.80", turnoverratio: 3.2 }]);
  const r = C.parseSinaRank(txt);
  return r.length === 2 && r[1].code === "sh600183" && Math.abs(r[1].chgPct - 5.12) < 1e-9 && r[1].volRatio === null;
})());

// 目标涨跌幅：主板 ±5%、双创 ±8%、ST ±2.5%
ok("目标：主板 5%", C.poolTargetOf("sh600519", "贵州茅台").target === 5, C.poolTargetOf("sh600519", "贵州茅台"));
ok("目标：创业板 8%", C.poolTargetOf("sz300750", "宁德时代").target === 8, C.poolTargetOf("sz300750", "宁德时代"));
ok("目标：科创板 8%", C.poolTargetOf("sh688981", "中芯国际").target === 8);
ok("目标：ST 股 2.5%", C.poolTargetOf("sh600xxx", "*ST某某").target === 2.5, C.poolTargetOf("sh600xxx", "*ST某某"));

// 跌停/涨停剔除 + 跌幅入选
const mkP = (code, name, chg, price, hi, lo, vr, to, flow, fp) => ({ code, name, price, chgPct: chg, high: hi, low: lo, volRatio: vr, turnover: to, flowAmt: flow, flowPct: fp });
const edge = C.rankPoolCandidates({
  up: [mkP("sh600001", "涨停股", 10.0, 20, 20, 18, 2, 5, 1e8, 8), mkP("sh600002", "跌停股", -10.0, 16, 18, 16, 2, 5, 1e8, 8),
       mkP("sh600004", "超上限", 5.1, 20, 20.5, 19, 2, 5, 1e8, 8)],
  down: [mkP("sh600003", "回调股", -4.5, 19, 21, 18.5, 1.8, 4, 8e7, 7)]
}, { limit: 10 });
ok("剔除：涨停/跌停/超上限都不进池", edge.picks.length === 1 && edge.picks[0].code === "sh600003", edge.picks.map((p) => p.code));
ok("双创 +7.9% 在 8% 上限内可入选", (function () { const r = C.rankPoolCandidates({ up: [mkP("sz300001", "双创内", 7.9, 20, 20.2, 18, 2, 5, 9e7, 8)] }, { limit: 5 }); return r.picks.length === 1 && r.picks[0].capPct === 8; })());
ok("双创 +8.1% 超上限被剔除", C.rankPoolCandidates({ up: [mkP("sz300002", "双创超", 8.1, 20, 20.2, 18, 2, 5, 9e7, 8)] }, { limit: 5 }).picks.length === 0);
ok("跌幅 -4.5%：标记为回调型", edge.picks[0].dir === "down" && edge.picks[0].reasons.some((r) => r.indexOf("回调型") >= 0), edge.picks[0].reasons);

const batch = 'v_sh600487="1~\u8d44\u91d1\u738b~600487~22.00~21.00~21.50~1.0~0~0~21.99~100~21.98~100~0~0~0~0~0~0~22.01~100~22.02~100~0~0~0~0~0~0~20261019150000~1.00~5.00~22.20~20.50~22.00/1/2~1~2~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0";\nv_sz300502="1~\u8d44\u91d1\u6b21~300502~94.00~95.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0";';
const quotes = C.parseBatchSnapshot(batch);
ok("批量快照：解析出 2 只", Object.keys(quotes).length === 2, Object.keys(quotes));
ok("批量快照：涨跌计算（21→22 = +4.76%）", Math.abs(quotes.sh600487.chgPct - 4.7619) < 0.01, quotes.sh600487.chgPct);
const recs = [{ code: "600487", fullCode: "sh600487", name: "资金王" }, { code: "300502", fullCode: "sz300502", name: "资金次" }];
const hits = C.poolHitStats(recs, quotes);
ok("命中统计：1 涨 1 跌 → 命中率 50%", hits.n === 2 && Math.abs(hits.hitRate - 50) < 1e-9 && hits.up === 1 && hits.down === 1, hits);
ok("页面含观察池卡片", html.includes("poolBox") && html.includes("尾盘观察池"));


/* ---------- 19) 观察池历史列表 ---------- */
console.log("\n[观察池历史列表]");
ok("导出 poolHistoryLines", typeof C.poolHistoryLines === "function");
const histPools = [
  { date: "2026-10-17", picks: [{ code: "sh600183", name: "生益科技", chgPct: 2.64, volRatio: 1.2, turnover: 2.4, flowAmt: 645000000, score: 14, reasons: ["温和上涨"], risks: [] }, { code: "sh600522", name: "中天科技", chgPct: 5.41, volRatio: 1.6, turnover: 4.8, flowAmt: 445000000, score: 14, reasons: ["主力净流入"], risks: [] }],
    verify: { stats: { n: 2, up: 1, down: 1, avgPct: 0.5, hitRate: 50, rows: [{ code: "sh600183", name: "生益科技", chgPct: 2.1 }, { code: "sh600522", name: "中天科技", chgPct: -1.1 }] } } },
  { date: "2026-10-19", picks: [{ code: "sh603019", name: "中科曙光", chgPct: 4.94, volRatio: 1.5, turnover: 2.8, flowAmt: 174000000, score: 17, reasons: ["收在日内高位"], risks: [] }] }
];
const histLines = C.poolHistoryLines(histPools, 10);
ok("历史：2 天且按日期倒序", histLines.length === 2 && histLines[0].date === "2026-10-19", histLines.map((x) => x.date));
ok("历史：已验证行含次日统计", histLines[1].verified && histLines[1].text.indexOf("次日 1/2 上涨") >= 0 && histLines[1].text.indexOf("+0.50%") >= 0, histLines[1].text);
ok("历史：已验证行含个股明细", histLines[1].per.indexOf("生益科技 +2.1%") >= 0, histLines[1].per);
ok("历史：待验证行标注", histLines[0].verified === false && histLines[0].text.indexOf("待次日验证") >= 0, histLines[0].text);
ok("页面含清空历史按钮", html.includes("btnPoolClear") && html.includes("观察池历史"));

// 渲染：带历史的池子
const h5 = makeHarness(
  { code: "sh600418", watch: ["sh600418"], sound: false, chartMode: "min", pos: {}, plans: {}, trade: {}, lastFired: {},
    ledger: { records: [] }, pools: histPools },
  () => null, { snapshotOnly: false });
let threw5 = null;
try { h5.run(coreSrc); h5.run(uiSrc); } catch (e) { threw5 = e; }
ok("渲染：历史场景无异常", !threw5, threw5 && threw5.message);
await new Promise((r) => setTimeout(r, 200));
ok("渲染：出现『观察池历史』", h5.deep("poolBox").indexOf("观察池历史") >= 0, h5.deep("poolBox").slice(0, 120));
ok("渲染：历史含次日统计文案", h5.deep("poolBox").indexOf("次日 1/2 上涨") >= 0, h5.deep("poolBox").slice(0, 300));


/* ---------- 20) 台账分股标识 ---------- */
console.log("\n[台账分股标识]");
const lg2 = { records: [] };
C.ledgerAdd(lg2, { ok: true, grade: "B", side: "long", score: 70, entry: { lo: 100, hi: 100 }, stop: 98, target: 103, rr: 2.5, size: 100 }, "sh603083", 1000, "剑桥科技");
ok("台账：记录带股票名", lg2.records[0].name === "剑桥科技", lg2.records[0].name);
C.ledgerAdd(lg2, { ok: true, grade: "A", side: "long", score: 80, entry: { lo: 84, hi: 84 }, stop: 83, target: 86, rr: 2, size: 200 }, "hk06166", 2000, "腾讯控股");
C.ledgerEval(lg2, "sh603083", 103.5, 3000);
C.ledgerEval(lg2, "hk06166", 82.5, 4000);
const stt2 = C.ledgerStats(lg2);
ok("台账：byCode 按股票分组", Object.keys(stt2.byCode).length === 2 && stt2.byCode.sh603083.name === "剑桥科技" && stt2.byCode.hk06166.n === 1, Object.keys(stt2.byCode));
ok("台账：分股统计累计为负（06166 亏）", stt2.byCode.hk06166.exp < 0, stt2.byCode.hk06166);

// 渲染：两笔不同股票的记录
const h6 = makeHarness(
  { code: "sz300607", watch: ["sz300607"], sound: false, chartMode: "min", pos: {}, plans: {}, trade: {}, lastFired: {},
    pools: [], srcStats: null,
    ledger: { records: [
      { id: "1", ts: 1760920000000, code: "hk06166", name: "腾讯控股", side: "long", grade: "B", score: 70,
        entry: 84.47, stop: 83.44, target: 87.42, rr: 1.9, size: 50, status: "closed", result: "stop", retPct: -1.23 },
      { id: "2", ts: 1760921000000, code: "sz300607", name: "拓斯达", side: "long", grade: "A", score: 82,
        entry: 27.5, stop: 27.1, target: 28.4, rr: 2.2, size: 300, status: "open", result: null, retPct: null }
    ] } },
  () => null, { snapshotOnly: false });
let threw6 = null;
try { h6.run(coreSrc); h6.run(uiSrc); } catch (e) { threw6 = e; }
ok("渲染：台账场景无异常", !threw6, threw6 && threw6.message);
await new Promise((r) => setTimeout(r, 250));
const ledTxt = h6.deep("ledgerBox");
ok("渲染：台账显示股票代码（06166.HK）", ledTxt.indexOf("06166.HK") >= 0, ledTxt.slice(0, 160));
ok("渲染：台账显示股票名（腾讯控股/拓斯达）", ledTxt.indexOf("腾讯控股") >= 0 && ledTxt.indexOf("拓斯达") >= 0, ledTxt.slice(0, 200));
ok("渲染：多股票时出现分股统计", ledTxt.indexOf("分股统计") >= 0, ledTxt.slice(0, 300));


/* ---------- 21) 计划生成升级：ATR 止损 / 日线关键位 / 风险预算 / 本金 ---------- */
console.log("\n[计划生成升级]");
const planPts = synth(3, 240, 0.02);
const planM = { price: 100, prevClose: 100, high: 103, low: 98, vwap: 100.5, vwapDevPct: 0.5, volRatio: 1.1 };
const planRefs = C.intradayRefs(planM, planPts, { shares: 0, cost: 0 }, { code: "sh603083", plan: null });
const planMp = C.multiPeriod(planPts);

const spBase = C.suggestPlan(planM, planRefs, planMp, null, { shares: 0, cost: 0 }, "sh603083", { points: planPts });
ok("计划：ATR 止损模式生效", (spBase.stopMode || "").indexOf("ATR") >= 0 && spBase.atr > 0, [spBase.stopMode, spBase.atr]);
ok("计划：止损低于现价", spBase.reds[0].at < 100, spBase.reds[0].at);
ok("计划：返回满仓与预算两个上限", spBase.fullPos > 0 && spBase.riskCap >= 0, [spBase.fullPos, spBase.riskCap]);
ok("计划：仓位上限 = min(满仓, 预算)", spBase.maxShares === Math.min(spBase.fullPos, spBase.riskCap), [spBase.maxShares, spBase.fullPos, spBase.riskCap]);

// 本金参数
const spCap = C.suggestPlan(planM, planRefs, planMp, null, { shares: 0, cost: 0 }, "sh603083", { points: planPts, capital: 50000 });
ok("计划：本金 5 万时满仓上限 = 500 股", spCap.fullPos === 500, spCap.fullPos);
ok("计划：本金变大 → 满仓上限变大", spCap.fullPos > spBase.fullPos, [spCap.fullPos, spBase.fullPos]);

// 预算反推
const spTiny = C.suggestPlan(planM, planRefs, planMp, null, { shares: 0, cost: 0 }, "sh603083", { points: planPts, budget: 100 });
ok("计划：预算 100 元 → 允许仓位 0 股", spTiny.riskCap === 0 && spTiny.maxShares === 0, [spTiny.riskCap, spTiny.maxShares]);

// 日线关键位并入减仓档
const dyPlan = { ok: true, ma20: 105, ma60: 108, high20: 106, high60: 112, low20: 95, low60: 90, trend: "flat" };
const spDaily = C.suggestPlan(planM, planRefs, planMp, null, { shares: 0, cost: 0 }, "sh603083", { points: planPts, daily: dyPlan });
const whys = spDaily.takes.map((t) => t.why).join(",");
ok("计划：日线关键位进入减仓档", whys.indexOf("日线") >= 0 || whys.indexOf("20日") >= 0 || whys.indexOf("60日") >= 0, whys);

// scoreSetup 使用本金参数
const tinyCapSp = C.scoreSetup(planM, planMp, null, planRefs, { shares: 0, cost: 0 }, null,
  { code: "sh603083", points: planPts, capital: 1000 });
ok("评分：本金过小 → 仓位 0 且否决", tinyCapSp.size === 0 && tinyCapSp.vetoes.some((v) => v.indexOf("仓位不足") >= 0 || v.indexOf("1 手") >= 0), [tinyCapSp.size, tinyCapSp.vetoes]);


/* ---------- 22) 每日简报（盘前 / 午间 / 盘后） ---------- */
console.log("\n[每日简报]");
ok("导出简报函数", !!(C.buildBrief && C.sessionPhase && C.briefDeadlines && C.segmentStats && C.prevDailyBar));
const phPre = C.sessionPhase(new Date(2026, 9, 20, 8, 0, 0), "sz300607");
const phSes = C.sessionPhase(new Date(2026, 9, 20, 10, 0, 0), "sz300607");
const phMid = C.sessionPhase(new Date(2026, 9, 20, 11, 32, 0), "sz300607");
const phPost = C.sessionPhase(new Date(2026, 9, 20, 15, 5, 0), "sz300607");
ok("阶段：08:00 → 开盘前", phPre.phase === "preopen", phPre.phase);
ok("阶段：10:00 → 盘中", phSes.phase === "session", phSes.phase);
ok("阶段：11:32 → 午间", phMid.phase === "midday", phMid.phase);
ok("阶段：15:05 → 盘后", phPost.phase === "postclose", phPost.phase);
ok("阶段：港股 12:30 → 午间", C.sessionPhase(new Date(2026, 9, 20, 12, 30, 0), "hk06166").phase === "midday");
ok("阶段：美股不支持", C.sessionPhase(new Date(2026, 9, 20, 10, 0, 0), "usAAPL").ok === false);

// 分钟点构造：上午 120 点，价格从 100 涨到 104
const bPts = [];
for (let i = 0; i < 240; i++) bPts.push({ date: C.todayStr(), slot: i, price: 100 + i * 0.0167, volInc: 100 + (i % 3) * 20 });
const segM = C.segmentStats(bPts, 0, 119);
ok("区间统计：上午高低/均价/量", segM.n === 120 && segM.hi > 101.5 && segM.lo >= 99.9 && segM.vwap > 100.5, [segM.n, segM.hi, segM.lo, segM.vwap]);

const today = C.todayStr();
const yBar = { date: "2026-10-19", o: 100, h: 105, l: 98, c: 102, v: 1000 };
const tBar = { date: today, o: 102, h: 104, l: 101, c: 103, v: 800 };
const dailyB = { ok: true, trend: "down", ma20: 95, ma60: 100, low20: 80, high20: 110, low60: 70, high60: 120,
  macd: { cross: "dead", bull: false }, kdj: { zone: "mid" }, lastBars: [yBar, tBar], note: "" };
ok("昨日日线：取今天之前最后一根", (function () { const b = C.prevDailyBar(dailyB, today); return b && b.date === "2026-10-19" && b.c === 102; })());

const preB = C.buildBrief("preopen", { code: "sz300607", daily: dailyB, points: bPts, m: { price: 103, changePct: 1.0 } });
ok("盘前简报：生成成功且有内容", preB.ok && preB.summary.length > 5 && preB.lines.length >= 2, preB.summary);
ok("盘前简报：给出支撑与压力", preB.levels.sup.length > 0 && preB.levels.res.length > 0, [preB.levels.sup, preB.levels.res]);
ok("盘前简报：有条件化动作", preB.actions.length >= 3 && preB.actions.every((a) => a.cond && a.act), preB.actions.length);
ok("盘前简报：空头趋势提示反弹减仓", preB.actions.some((a) => a.act.indexOf("减仓") >= 0), preB.actions);

const midB = C.buildBrief("midday", { code: "sz300607", m: { price: 103.9, changePct: 3.9, prevClose: 100, turnover: 5e8 }, points: bPts, indexPct: 0.3 });
ok("午间简报：含上午涨跌与位置", midB.ok && midB.summary.indexOf("上午") >= 0, midB.summary);
ok("午间简报：含下午方向动作", midB.actions.length >= 2 && midB.actions.some((a) => a.cond.indexOf("13:00") >= 0 || a.cond.indexOf("14:30") >= 0), midB.actions);

const postB = C.buildBrief("postclose", { code: "sz300607", m: { price: 103.9, changePct: 3.9, prevClose: 100, turnover: 9e8 },
  daily: dailyB, points: bPts,
  wash: { ok: true, summary: "洗盘特征 3/5 · 出货特征 1/5 → 倾向洗盘" },
  setup: { ok: true, grade: "noTrade", score: 48, vetoes: ["震荡区：不交易"] },
  atr: 0.5, ledger: { today: "今日信号 1 条" } });
ok("盘后简报：含今日涨跌与收盘位置", postB.ok && postB.summary.indexOf("今日") >= 0, postB.summary);
ok("盘后简报：含系统评分/洗盘结论", postB.lines.some((l) => l.v.indexOf("倾向洗盘") >= 0) && postB.lines.some((l) => l.k === "系统评分"), postB.lines);
ok("盘后简报：给出明日动作", postB.actions.length >= 3 && postB.actions.some((a) => a.act.indexOf("减仓") >= 0 || a.act.indexOf("低吸") >= 0), postB.actions);
ok("盘后简报：带风险管理提示", postB.risks.length > 0, postB.risks);
ok("页面含每日简报卡片", html.includes("briefBox") && html.includes("每日简报"));


/* ---------- 23) 简报按股票隔离 ---------- */
console.log("\n[简报按股票隔离]");
ok("导出 briefKey", typeof C.briefKey === "function");
ok("briefKey = 日期 + 代码", C.briefKey("2026-10-20", "sz300607") === "2026-10-20 sz300607", C.briefKey("2026-10-20", "sz300607"));

const todayK = C.todayStr();
const briefA = { ok: true, kind: "preopen", title: "盘前", summary: "AA股数据", lines: [], levels: { sup: [], res: [] }, actions: [], risks: [] };
const briefB = { ok: true, kind: "preopen", title: "盘前", summary: "BB股数据", lines: [], levels: { sup: [], res: [] }, actions: [], risks: [] };
const seededBriefs = {};
seededBriefs[C.briefKey(todayK, "sz300607")] = { preopen: { at: Date.now(), brief: briefA } };
seededBriefs[C.briefKey(todayK, "sh600418")] = { preopen: { at: Date.now(), brief: briefB } };
seededBriefs[todayK] = { preopen: { at: Date.now(), brief: briefB } };   // 旧格式（应被清理/忽略）

const h7 = makeHarness(
  { code: "sz300607", watch: ["sz300607", "sh600418"], sound: false, chartMode: "min", pos: {}, plans: {}, trade: {}, lastFired: {},
    pools: [], srcStats: null, ledger: { records: [] }, capital: {}, briefs: seededBriefs },
  () => null, { snapshotOnly: false });
let threw7 = null;
try { h7.run(coreSrc); h7.run(uiSrc); } catch (e) { threw7 = e; }
ok("渲染：简报隔离场景无异常", !threw7, threw7 && threw7.message);
await new Promise((r) => setTimeout(r, 250));
const bt = h7.deep("briefBox");
ok("渲染：只显示当前股票的简报（AA股数据）", bt.indexOf("AA股数据") >= 0, bt.slice(0, 200));
ok("渲染：不显示其它股票的简报（BB股数据）", bt.indexOf("BB股数据") < 0, bt.slice(0, 200));
ok("渲染：标题带股票代码", bt.indexOf("300607") >= 0, bt.slice(0, 120));
ok("渲染：旧格式键被清理", (function () { const saved = h7.saved(); const keys = Object.keys(saved.briefs || {}); return keys.indexOf(todayK) < 0; })());


/* ---------- 24) 简报时间点：按市场（开市前5分钟 / 收市后2分钟） ---------- */
console.log("\n[简报时间点]");
const dlCn = C.briefDeadlines("sz300607");
ok("A股：盘前 09:25 / 午间 11:32 / 盘后 15:02",
  dlCn.preopen === 9 * 60 + 25 && dlCn.midday === 11 * 60 + 32 && dlCn.postclose === 15 * 60 + 2, dlCn);
const dlHk = C.briefDeadlines("hk06166");
ok("港股：盘前 09:25 / 午间 12:02 / 盘后 16:02",
  dlHk.preopen === 9 * 60 + 25 && dlHk.midday === 12 * 60 + 2 && dlHk.postclose === 16 * 60 + 2, dlHk);
ok("A股 11:31 仍在盘中（未到午间）", C.sessionPhase(new Date(2026, 9, 20, 11, 31), "sz300607").phase === "session");
ok("A股 11:32 → 午间", C.sessionPhase(new Date(2026, 9, 20, 11, 32), "sz300607").phase === "midday");
ok("港股 12:01 仍在盘中", C.sessionPhase(new Date(2026, 9, 20, 12, 1), "hk06166").phase === "session");
ok("港股 12:03 → 午间", C.sessionPhase(new Date(2026, 9, 20, 12, 3), "hk06166").phase === "midday");
ok("港股 16:03 → 盘后", C.sessionPhase(new Date(2026, 9, 20, 16, 3), "hk06166").phase === "postclose");
ok("A股 15:03 → 盘后", C.sessionPhase(new Date(2026, 9, 20, 15, 3), "sz300607").phase === "postclose");

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
