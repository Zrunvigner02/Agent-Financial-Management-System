/**
 * reports —— 三大报表（资产负债表 / 利润表 / 现金流量表）本地计算引擎
 *
 * 设计要点：
 * 1. 模板与公式全部落库（report_templates / report_settings），可编辑、可重置；
 *    未自定义时回落到内置默认模板（DEFAULTS）。
 * 2. 公式是自研的安全表达式（递归下降解析），**不使用 eval / Function**，
 *    只允许 数字、四则运算、括号、以及 7 个取值函数：
 *      QC(code) 年初余额    QM(code) 期末余额   QY(code) 本年年初余额（同 QC）
 *      JE(code) 本期借方发生 DE(code) 本期贷方发生
 *      JEL(code) 本年累计借  DEL(code) 本年累计贷
 *    函数参数必须是 4~10 位科目编码；非法公式保存时即被拒绝，计算时也不会执行。
 * 3. 科目金额按「科目编码前缀」汇总，父科目自动包含下级明细。
 * 4. 金额单位：元，四舍五入保留两位小数。
 */
import { DatabaseSync } from 'node:sqlite';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TYPES = new Set(['balance', 'income', 'cash']);
const TITLES = { balance: '资产负债表', income: '利润表', cash: '现金流量表' };
const MAX_ITEMS = 200;
const MAX_FORMULA = 300;

const num = (v) => {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

/* ---------------- 默认模板 ---------------- */

const CASH_CODES = ['1001', '1002', '1012'];

function c(expr) {
  return { code: '', name: '', kind: 'item', side: 'left', level: 1, formula: expr };
}

export function defaultTemplates(type) {
  if (type === 'balance') {
    return [
      { code: 'A', name: '流动资产：', kind: 'head', side: 'left', level: 1, formula: '' },
      { code: 'A01', name: '货币资金', kind: 'item', side: 'left', level: 2, formula: 'QM(1001)+QM(1002)+QM(1012)' },
      { code: 'A02', name: '交易性金融资产', kind: 'item', side: 'left', level: 2, formula: 'QM(1101)' },
      { code: 'A03', name: '应收票据', kind: 'item', side: 'left', level: 2, formula: 'QM(1121)' },
      { code: 'A04', name: '应收账款', kind: 'item', side: 'left', level: 2, formula: 'QM(1122)-QM(1231)' },
      { code: 'A05', name: '预付账款', kind: 'item', side: 'left', level: 2, formula: 'QM(1123)' },
      { code: 'A06', name: '其他应收款', kind: 'item', side: 'left', level: 2, formula: 'QM(1221)' },
      { code: 'A07', name: '存货', kind: 'item', side: 'left', level: 2, formula: 'QM(1401)+QM(1402)+QM(1403)+QM(1405)+QM(1408)' },
      { code: 'A08', name: '其他流动资产', kind: 'item', side: 'left', level: 2, formula: 'QM(1901)' },
      { code: 'A09', name: '流动资产合计', kind: 'subtotal', side: 'left', level: 1, formula: 'SUM(A01:A08)' },
      { code: 'B', name: '非流动资产：', kind: 'head', side: 'left', level: 1, formula: '' },
      { code: 'B01', name: '固定资产', kind: 'item', side: 'left', level: 2, formula: 'QM(1601)-QM(1602)-QM(1603)' },
      { code: 'B02', name: '在建工程', kind: 'item', side: 'left', level: 2, formula: 'QM(1604)' },
      { code: 'B03', name: '无形资产', kind: 'item', side: 'left', level: 2, formula: 'QM(1701)-QM(1702)' },
      { code: 'B04', name: '长期待摊费用', kind: 'item', side: 'left', level: 2, formula: 'QM(1801)' },
      { code: 'B05', name: '非流动资产合计', kind: 'subtotal', side: 'left', level: 1, formula: 'SUM(B01:B04)' },
      { code: 'Z1', name: '资产总计', kind: 'total', side: 'left', level: 1, formula: 'A09+B05' },

      { code: 'L', name: '流动负债：', kind: 'head', side: 'right', level: 1, formula: '' },
      { code: 'L01', name: '短期借款', kind: 'item', side: 'right', level: 2, formula: 'QM(2001)' },
      { code: 'L02', name: '应付票据', kind: 'item', side: 'right', level: 2, formula: 'QM(2201)' },
      { code: 'L03', name: '应付账款', kind: 'item', side: 'right', level: 2, formula: 'QM(2202)' },
      { code: 'L04', name: '预收账款', kind: 'item', side: 'right', level: 2, formula: 'QM(2203)' },
      { code: 'L05', name: '应付职工薪酬', kind: 'item', side: 'right', level: 2, formula: 'QM(2211)' },
      { code: 'L06', name: '应交税费', kind: 'item', side: 'right', level: 2, formula: 'QM(2221)' },
      { code: 'L07', name: '其他应付款', kind: 'item', side: 'right', level: 2, formula: 'QM(2241)' },
      { code: 'L08', name: '流动负债合计', kind: 'subtotal', side: 'right', level: 1, formula: 'SUM(L01:L07)' },
      { code: 'N', name: '非流动负债：', kind: 'head', side: 'right', level: 1, formula: '' },
      { code: 'N01', name: '长期借款', kind: 'item', side: 'right', level: 2, formula: 'QM(2501)' },
      { code: 'N02', name: '非流动负债合计', kind: 'subtotal', side: 'right', level: 1, formula: 'N01' },
      { code: 'L09', name: '负债合计', kind: 'subtotal', side: 'right', level: 1, formula: 'L08+N02' },
      { code: 'E', name: '所有者权益：', kind: 'head', side: 'right', level: 1, formula: '' },
      { code: 'E01', name: '实收资本', kind: 'item', side: 'right', level: 2, formula: 'QM(4001)' },
      { code: 'E02', name: '资本公积', kind: 'item', side: 'right', level: 2, formula: 'QM(4002)' },
      { code: 'E03', name: '盈余公积', kind: 'item', side: 'right', level: 2, formula: 'QM(4101)' },
      { code: 'E04', name: '未分配利润', kind: 'item', side: 'right', level: 2, formula: 'QM(4103)+QM(4104)+DEL(6001)+DEL(6051)+DEL(6117)+DEL(6301)-JEL(6401)-JEL(6403)-JEL(6601)-JEL(6602)-JEL(6603)-JEL(6711)-JEL(6801)', formula2: 'QC(4103)+QC(4104)' },
      { code: 'E05', name: '所有者权益合计', kind: 'subtotal', side: 'right', level: 1, formula: 'SUM(E01:E04)' },
      { code: 'Z2', name: '负债和所有者权益总计', kind: 'total', side: 'right', level: 1, formula: 'L09+E05' },
    ];
  }
  if (type === 'income') {
    return [
      { code: 'I01', name: '一、营业收入', kind: 'item', side: 'left', level: 1, formula: 'DE(6001)+DE(6051)' },
      { code: 'I02', name: '减：营业成本', kind: 'item', side: 'left', level: 2, formula: 'JE(6401)' },
      { code: 'I03', name: '　　税金及附加', kind: 'item', side: 'left', level: 2, formula: 'JE(6403)' },
      { code: 'I04', name: '　　销售费用', kind: 'item', side: 'left', level: 2, formula: 'JE(6601)' },
      { code: 'I05', name: '　　管理费用', kind: 'item', side: 'left', level: 2, formula: 'JE(6602)' },
      { code: 'I06', name: '　　财务费用', kind: 'item', side: 'left', level: 2, formula: 'JE(6603)' },
      { code: 'I07', name: '加：其他收益', kind: 'item', side: 'left', level: 2, formula: 'DE(6117)' },
      { code: 'I08', name: '二、营业利润', kind: 'subtotal', side: 'left', level: 1, formula: 'I01-I02-I03-I04-I05-I06+I07' },
      { code: 'I09', name: '加：营业外收入', kind: 'item', side: 'left', level: 2, formula: 'DE(6301)' },
      { code: 'I10', name: '减：营业外支出', kind: 'item', side: 'left', level: 2, formula: 'JE(6711)' },
      { code: 'I11', name: '三、利润总额', kind: 'subtotal', side: 'left', level: 1, formula: 'I08+I09-I10' },
      { code: 'I12', name: '减：所得税费用', kind: 'item', side: 'left', level: 2, formula: 'JE(6801)' },
      { code: 'I13', name: '四、净利润', kind: 'total', side: 'left', level: 1, formula: 'I11-I12' },
    ];
  }
  const cashBase = CASH_CODES.map((x) => `QM(${x})`).join('+');
  const cashOpen = CASH_CODES.map((x) => `QC(${x})`).join('+');
  return [
    { code: 'C01', name: '经营活动产生的现金流量净额', kind: 'item', side: 'left', level: 1, formula: `${cashBase}-(${cashOpen})`, formula2: `${cashBase}-(${cashOpen})` },
    { code: 'C02', name: '投资活动产生的现金流量净额', kind: 'item', side: 'left', level: 1, formula: '0' },
    { code: 'C03', name: '筹资活动产生的现金流量净额', kind: 'item', side: 'left', level: 1, formula: '0' },
    { code: 'C04', name: '现金及现金等价物净增加额', kind: 'total', side: 'left', level: 1, formula: 'SUM(C01:C03)' },
    { code: 'C05', name: '加：期初现金及现金等价物余额', kind: 'item', side: 'left', level: 2, formula: cashOpen },
    { code: 'C06', name: '期末现金及现金等价物余额', kind: 'total', side: 'left', level: 1, formula: 'C04+C05' },
  ];
}

const FORMULA2_MAP = [['QM(', 'QC('], ['JE(', 'JEL('], ['DE(', 'DEL(']];
const deriveFormula2 = (f) => FORMULA2_MAP.reduce((acc, [a, b]) => acc.split(a).join(b), String(f || ''));

/* ---------------- 安全公式解析 ---------------- */

const FUNCS = new Set(['QC', 'QM', 'QY', 'JE', 'DE', 'JEL', 'DEL']);

function tokenize(src) {
  const s = String(src || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if ('+-*/()'.includes(ch)) { out.push({ t: ch }); i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
      const raw = s.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`数字不合法：${raw}`);
      out.push({ t: 'num', v: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z]/.test(s[j])) j += 1;
      const name = s.slice(i, j).toUpperCase();
      if (!FUNCS.has(name)) throw new Error(`未知函数：${name}`);
      while (j < s.length && /\s/.test(s[j])) j += 1;
      if (s[j] !== '(') throw new Error(`函数 ${name} 缺少括号`);
      let k = j + 1;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      const m = /^(\d{4,10})/.exec(s.slice(k));
      if (!m) throw new Error(`函数 ${name} 需要科目编码参数`);
      k += m[1].length;
      while (k < s.length && /\s/.test(s[k])) k += 1;
      if (s[k] !== ')') throw new Error(`函数 ${name} 括号未闭合`);
      out.push({ t: 'fn', name, code: m[1] });
      i = k + 1;
      continue;
    }
    throw new Error(`非法字符：${ch}`);
  }
  return out;
}

/**
 * 解析并执行公式。ctx 提供取值：{ pick(name, code) -> number }
 * 只允许四则运算，除零返回 0，任何异常都抛出由调用方降级。
 */
export function evalFormula(src, ctx) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    const tk = tokens[pos];
    if (!tk || (t && tk.t !== t)) throw new Error(`公式语法错误：期望 ${t || '表达式'}`);
    pos += 1;
    return tk;
  };
  function expr() {
    let v = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = eat().t;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = eat().t;
      const r = factor();
      if (op === '*') v *= r;
      else v = r === 0 ? 0 : v / r;
    }
    return v;
  }
  function factor() {
    if (peek() && peek().t === '-') { eat('-'); return -factor(); }
    if (peek() && peek().t === '+') { eat('+'); return factor(); }
    return primary();
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new Error('公式不完整');
    if (tk.t === 'num') { eat(); return tk.v; }
    if (tk.t === 'fn') { eat(); return num(ctx.pick(tk.name, tk.code)); }
    if (tk.t === '(') { eat('('); const v = expr(); eat(')'); return v; }
    throw new Error('公式语法错误');
  }
  const value = expr();
  if (pos !== tokens.length) throw new Error('公式存在多余内容');
  if (!Number.isFinite(value)) throw new Error('公式结果不是有限数字');
  return value;
}

/** 保存前校验：能解析、长度与科目编码合法。返回错误信息或空字符串 */
export function validateFormula(src) {
  const f = String(src || '').trim();
  if (!f) return '';
  if (f.length > MAX_FORMULA) return `公式过长（上限 ${MAX_FORMULA} 字符）`;
  try {
    const tokens = tokenize(f);
    if (!tokens.length) return '公式为空';
    evalFormula(f, { pick: () => 0 });
    return '';
  } catch (e) {
    return e.message;
  }
}

/* ---------------- 取数 ---------------- */

function yearOf(period) { return `${period.slice(0, 4)}-01`; }

/** 汇总科目发生额：返回 Map<prefix, {qd,qc,je,de,jel,del}> */
function collectFigures(db, setId, period) {
  const rows = db.prepare(`
    SELECT e.subject_code AS code, v.period AS period,
           SUM(e.debit) AS d, SUM(e.credit) AS c
    FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.set_id = ? AND v.status IN ('reviewed','posted') AND v.period <= ?
    GROUP BY e.subject_code, v.period
  `).all(Number(setId) || 85, period);

  const yStart = yearOf(period);
  const map = new Map();
  const bucket = (code) => {
    if (!map.has(code)) map.set(code, { qy: 0, qd: 0, je: 0, de: 0, jel: 0, del: 0 });
    return map.get(code);
  };
  for (const r of rows) {
    const code = String(r.code || '');
    const d = num(r.d);
    const c = num(r.c);
    for (const len of [4, 6, 8, 10]) {
      if (code.length < len) continue;
      const b = bucket(code.slice(0, len));
      if (r.period < yStart) {
        // 以前年度累计 → 年初余额
        b.qy += d - c;
        b.qd += d - c;
      } else if (r.period < period) {
        // 本年已过期间 → 本期初余额 + 本年累计发生额
        b.qd += d - c;
        b.jel += d;
        b.del += c;
      } else if (r.period === period) {
        // 本期发生额
        b.je += d;
        b.de += c;
        b.jel += d;
        b.del += c;
      }
    }
  }
  return map;
}

function directionMap(db, setId) {
  const rows = db.prepare('SELECT code, direction FROM subjects WHERE set_id = ?').all(Number(setId) || 85);
  const m = new Map();
  for (const r of rows) m.set(String(r.code), r.direction === '贷' ? -1 : 1);
  return m;
}

function pickMetric(figures, dirs, name, code) {
  const f = figures.get(String(code)) || { qy: 0, qd: 0, je: 0, de: 0, jel: 0, del: 0 };
  const sign = dirs.get(String(code)) || 1;
  switch (name) {
    case 'QC': case 'QY': return (f.qy) * sign;
    case 'QM': return (f.qd + f.je - f.de) * sign;
    case 'JE': return f.je;
    case 'DE': return f.de;
    case 'JEL': return f.jel;
    case 'DEL': return f.del;
    default: return 0;
  }
}

/* ---------------- 模板读写 ---------------- */

function rowKey(r) { return `${r.side || 'left'}|${r.code || ''}|${r.name || ''}`; }

export function loadTemplates(db, setId, type) {
  const rows = db.prepare(`
    SELECT side, code, name, kind, level, formula, formula2, sort
    FROM report_templates WHERE set_id = ? AND type = ? ORDER BY side, sort, id
  `).all(Number(setId) || 85, type);
  if (rows.length) return rows;
  return defaultTemplates(type).map((r, i) => ({ ...r, formula2: '', sort: i * 10 }));
}

export function saveTemplates(db, setId, type, items) {
  if (!TYPES.has(type)) throw new Error('不支持的报表类型');
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new Error(`行的数量需在 1~${MAX_ITEMS} 之间`);
  const clean = [];
  const seen = new Set();
  for (const raw of items) {
    const name = String(raw.name || '').trim();
    if (!name) throw new Error('行名称不能为空');
    if (name.length > 60) throw new Error(`行名称过长：${name.slice(0, 12)}…`);
    const kind = ['head', 'item', 'subtotal', 'total'].includes(raw.kind) ? raw.kind : 'item';
    const side = raw.side === 'right' ? 'right' : 'left';
    const code = String(raw.code || '').trim().slice(0, 20);
    const formula = String(raw.formula || '').trim();
    const formula2 = String(raw.formula2 || '').trim();
    for (const f of [formula, formula2]) {
      const err = validateFormula(f);
      if (err) throw new Error(`${name}：${err}`);
    }
    const key = rowKey({ side, code, name });
    if (seen.has(key)) throw new Error(`存在重复行：${name}`);
    seen.add(key);
    clean.push({
      side, code, name, kind,
      level: Math.min(Math.max(Number(raw.level) || 1, 1), 3),
      formula, formula2,
      sort: Number(raw.sort) || clean.length * 10,
    });
  }
  const ins = db.prepare(`INSERT INTO report_templates
    (set_id, type, side, code, name, kind, level, formula, formula2, sort, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM report_templates WHERE set_id = ? AND type = ?').run(Number(setId) || 85, type);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    for (const r of clean) {
      ins.run(Number(setId) || 85, type, r.side, r.code, r.name, r.kind, r.level, r.formula, r.formula2, r.sort, ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return clean.length;
}

export function resetTemplates(db, setId, type) {
  if (!TYPES.has(type)) throw new Error('不支持的报表类型');
  const info = db.prepare('DELETE FROM report_templates WHERE set_id = ? AND type = ?').run(Number(setId) || 85, type);
  return num(info.changes);
}

/* ---------------- 重分类设置 ---------------- */

export function getReclass(db, setId) {
  const row = db.prepare("SELECT value FROM report_settings WHERE set_id = ? AND key = 'balance_reclass'").get(Number(setId) || 85);
  return row ? row.value === '1' : false;
}

export function setReclass(db, setId, on) {
  db.prepare(`INSERT INTO report_settings (set_id, key, value, updated_at) VALUES (?, 'balance_reclass', ?, ?)
    ON CONFLICT(set_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(Number(setId) || 85, on ? '1' : '0', new Date().toISOString().replace('T', ' ').slice(0, 19));
  return Boolean(on);
}

/* ---------------- 计算主流程 ---------------- */

/**
 * 生成报表。返回 { title, type, period, rows:[{code,name,kind,side,level,v1,v2}], warnings }
 * 单行公式出错不会让整张表失败：该行记 0 并写入 warnings。
 */
export function computeReport(db, setId, type, period) {
  if (!TYPES.has(type)) throw new Error('不支持的报表类型');
  if (!PERIOD_RE.test(String(period || ''))) throw new Error('期间格式应为 YYYY-MM');
  const sid = Number(setId) || 85;
  const figures = collectFigures(db, sid, period);
  const dirs = directionMap(db, sid);
  const ctx = { pick: (name, code) => pickMetric(figures, dirs, name, code) };
  const templates = loadTemplates(db, sid, type);
  const byCode = new Map();
  const warnings = [];
  // 行间引用（SUM(A01:A08) / A09+B05）先不算，留给第二遍；避免重复报警
  const REF_RE = /(?<![A-Za-z0-9_])(?:SUM\([A-Z]\d{1,3}:[A-Z]\d{1,3}\)|[A-Z]\d{1,3})(?![A-Za-z0-9_])/;

  const rows = templates.map((t) => {
    const formula = String(t.formula || '').trim();
    const formula2 = String(t.formula2 || '').trim() || deriveFormula2(formula);
    let v1 = 0;
    let v2 = 0;
    if (formula && !REF_RE.test(formula)) {
      try { v1 = round2(evalFormula(formula, ctx)); } catch (e) { warnings.push(`${t.name}：${e.message}`); }
    }
    if (formula2 && !REF_RE.test(formula2)) {
      try { v2 = round2(evalFormula(formula2, ctx)); } catch (e) { warnings.push(`${t.name}（对比列）：${e.message}`); }
    }
    const row = {
      code: t.code || '', name: t.name, kind: t.kind || 'item',
      side: t.side === 'right' ? 'right' : 'left', level: Number(t.level) || 1,
      v1, v2, formula, formula2,
    };
    if (row.code) byCode.set(row.code, row);
    return row;
  });

  // 第二遍：解析行间引用
  const resolveRefs = (expr, key) => {
    const withSums = String(expr).replace(/SUM\(([A-Z])(\d{1,3}):([A-Z])(\d{1,3})\)/g, (_, l1, n1, l2, n2) => {
      if (l1 !== l2) throw new Error('SUM 区间需使用同一行前缀');
      const width = Math.max(n1.length, n2.length);
      const lo = Math.min(Number(n1), Number(n2));
      const hi = Math.max(Number(n1), Number(n2));
      let sum = 0;
      for (let i = lo; i <= hi; i += 1) {
        const r = byCode.get(`${l1}${String(i).padStart(width, '0')}`);
        if (r) sum += num(r[key]);
      }
      return String(sum);
    });
    const replaced = withSums.replace(/(?<![A-Za-z0-9_])([A-Z]\d{1,3})(?![A-Za-z0-9_])/g, (m0) => {
      const r = byCode.get(m0);
      return String(r ? num(r[key]) : 0);
    });
    if (/[A-Za-z]/.test(replaced)) throw new Error('引用了不存在的行');
    return evalFormula(replaced, { pick: () => 0 });
  };
  for (const row of rows) {
    for (const key of ['v1', 'v2']) {
      const f = key === 'v1' ? row.formula : row.formula2;
      if (!f || !REF_RE.test(f)) continue;
      try {
        row[key] = round2(resolveRefs(f, key));
      } catch (e) {
        row[key] = 0;
        warnings.push(`${row.name}（行间引用）：${e.message}`);
      }
    }
  }

  let out = rows;
  if (type === 'balance' && getReclass(db, sid)) out = applyReclass(out);

  return { title: TITLES[type], type, period, rows: out, warnings };
}


/** 重分类：应收类贷方余额→预收，应付类借方余额→预付，避免红字挂账 */
function applyReclass(rows) {
  const find = (name) => rows.find((r) => r.name === name);
  const ar = find('应收账款');
  const ap = find('应付账款');
  const pre = find('预收账款');
  const prepay = find('预付账款');
  const move = (from, to) => {
    if (!from || !to) return;
    for (const k of ['v1', 'v2']) {
      if (Number(from[k]) < 0) {
        const amount = Math.abs(Number(from[k]));
        from[k] = 0;
        to[k] = round2(Number(to[k]) + amount);
      }
    }
  };
  move(ar, pre);
  move(ap, prepay);
  return rows;
}

/** 供导出模块复用的平铺表（左侧资产 + 右侧负债权益合并成两列） */
export function reportTable(db, setId, type, period) {
  const { title, rows } = computeReport(db, setId, type, period);
  const col = (key, label, t = 'text') => ({ key, label, type: t });
  if (type === 'balance') {
    const left = rows.filter((r) => r.side === 'left');
    const right = rows.filter((r) => r.side === 'right');
    const n = Math.max(left.length, right.length);
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const l = left[i] || {};
      const r = right[i] || {};
      out.push({
        asset: l.name || '', asset_end: l.name ? num(l.v1) : '', asset_begin: l.name ? num(l.v2) : '',
        liab: r.name || '', liab_end: r.name ? num(r.v1) : '', liab_begin: r.name ? num(r.v2) : '',
      });
    }
    return {
      title,
      columns: [
        col('asset', '资产项目'), col('asset_end', '期末余额', 'number'), col('asset_begin', '年初余额', 'number'),
        col('liab', '负债和所有者权益项目'), col('liab_end', '期末余额', 'number'), col('liab_begin', '年初余额', 'number'),
      ],
      rows: out,
    };
  }
  return {
    title,
    columns: [col('item', '项目'), col('current', '本期金额', 'number'), col('ytd', '本年累计', 'number')],
    rows: rows.map((r) => ({ item: r.name, current: num(r.v1), ytd: num(r.v2) })),
  };
}

export { TYPES, TITLES, PERIOD_RE };
export const _internal = { tokenize, collectFigures, applyReclass };
