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

function makeHarness(seedStore, payloadFor) {
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
    const code = decodeURIComponent(url.split("code=")[1] || "");
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

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
