window.__ModuleLoader__.load({ id: "@dsh-external/dsh-memory-manager", factory: (require) => {
"use strict";
var module = { exports: {} }; var exports = module.exports;

const React = require("react");
const { useState, useEffect, useRef } = React;
const h = React.createElement;

const API = "/_dsh/memory-manager/api";

// ================= 前端日志（→ 宿主落盘 ~/.dsh/memory-manager-client.log） =================
function log(level, tag, msg, extra) {
  try {
    const text = "[" + level + "][" + tag + "] " + msg;
    if (level === "error") console.error("[memory-manager]", text, extra || "");
    else console.log("[memory-manager]", text);
    const body = JSON.stringify({ op: "diag.log", args: { level, tag, msg: text, stack: (extra && extra.stack) || "" } });
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  } catch (e) { /* 日志本身失败绝不抛出 */ }
}
function installErrorCapture() {
  if (window.__memErrCapInstalled) return;
  window.__memErrCapInstalled = true;
  const isOurs = (stack) => !stack || /memory[-_]?(manager|panel)|@dsh-external/.test(String(stack));
  let last = 0, lastMsg = "";
  const send = (level, tag, msg, stack) => {
    try {
      if (!isOurs(stack)) return;
      const now = Date.now();
      if (msg === lastMsg && now - last < 3000) return;
      last = now; lastMsg = msg;
      log(level, tag, msg, stack ? { stack } : undefined);
    } catch { /* ignore */ }
  };
  window.addEventListener("error", (e) => {
    send("error", "window.error", (e && e.message) || String((e && e.error) || ""), e && e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    send("error", "unhandledrejection", (r && r.message) ? r.message : String(r), r && r.stack);
  });
  log("info", "boot", "client bundle loaded, error capture installed");
}

// ================= 模块级面板状态 =================
const panel = { open: false, sessionId: null, tab: "plan", crashed: false };
let overlayListeners = [];
const notifyOverlay = () => { for (const l of [...overlayListeners]) { try { l() } catch { /* ignore */ } } };

async function call(op, args = {}, sid) {
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, sessionId: sid !== undefined ? sid : panel.sessionId, args }),
    });
    const j = await r.json();
    if (j && j.ok === false && j.error) return { error: j.error };
    return (j && j.value && typeof j.value === "object") ? j.value : {};
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ================= 样式（DSH 设计系统：--dsw-alias-* token，深浅色自适应） =================
const CSS = [
  "/* ---- 记忆管理面板 ---- */",
  ".mem-wrap{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:96vw;background:var(--dsw-alias-bg-layer-1,#1e1f24);color:var(--dsw-alias-label-primary,#e8e8ea);border-left:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));z-index:1000;display:flex;flex-direction:column;font-family:var(--dsw-font-family,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:13px;box-shadow:-8px 0 28px rgba(0,0,0,.35)}",
  ".mem-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none;min-height:46px}",
  ".mem-title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}",
  ".mem-sid{font-size:11px;opacity:.5;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mem-tabs{display:flex;align-items:flex-end;gap:22px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none;padding:2px 16px 0}",
  ".mem-tab{position:relative;border:0;padding:7px 1px 9px;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(232,232,234,.55));font:inherit;font-size:13px;line-height:20px;cursor:pointer}",
  ".mem-tab:hover{color:var(--dsw-alias-label-primary,#e8e8ea)}",
  ".mem-tab.on{color:var(--dsw-alias-label-primary,#e8e8ea);font-weight:600}",
  ".mem-tab.on::after{position:absolute;right:0;bottom:-1px;left:0;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary,#e8e8ea);content:''}",
  ".mem-tab:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}",
  ".mem-body{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
  ".mem-body::-webkit-scrollbar,.mdlg::-webkit-scrollbar{width:8px}.mem-body::-webkit-scrollbar-thumb,.mdlg::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,rgba(128,128,128,.3));border-radius:4px}.mem-body::-webkit-scrollbar-thumb:hover,.mdlg::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,rgba(128,128,128,.5))}",
  "/* ---- 按钮（DSH Button：胶囊，h36/sm28） ---- */",
  ".mbtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;border:none;border-radius:18px;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#e8e8ea);background:transparent;padding:0 14px;height:36px;transition:background .15s,opacity .15s}",
  ".mbtn.sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:14px}",
  ".mbtn.primary{background:var(--dsw-alias-button-primary-fill,#15151d);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".mbtn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#43434a)}",
  ".mbtn.outline{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}",
  ".mbtn.outline:hover:not(:disabled),.mbtn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
  ".mbtn.danger{background:var(--dsw-alias-state-error-primary,#e31313);color:var(--dsw-alias-label-primary-inverted,#fff)}",
  ".mbtn.danger:hover:not(:disabled){filter:brightness(1.1)}",
  ".mbtn:disabled{opacity:.4;cursor:not-allowed}",
  ".mbtn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}",
  "/* ---- 开关（DSH Switch：track+thumb，开=品牌蓝） ---- */",
  ".msw{display:inline-flex;flex:none;padding:0;border:0;background:none;cursor:pointer}",
  ".msw:disabled{opacity:.4;cursor:not-allowed}",
  ".msw-track{position:relative;display:inline-block;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.3));transition:background-color 120ms var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}",
  ".msw-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-inverted,#fff);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform 120ms var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}",
  ".msw-track[data-on='true']{background:var(--dsw-alias-state-business-primary,#4176e6)}",
  ".msw-track[data-on='true'] .msw-thumb{transform:translateX(16px)}",
  "/* ---- 状态文字（代替胶囊徽标/圆点：纯文字+颜色，直观明确） ---- */",
  ".mstate{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);white-space:nowrap}",
  ".mstate.on{color:var(--dsw-alias-state-success-primary,#22c55e)}",
  ".mimpr{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa)}",
  "/* ---- 输入（DSH Input） ---- */",
  ".minput,.mtextarea{width:100%;box-sizing:border-box;height:32px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.25));color:var(--dsw-alias-label-primary,inherit);padding:0 9px;font-size:14px;font-family:inherit;transition:border-color .15s}",
  ".minput::placeholder,.mtextarea::placeholder{color:var(--dsw-alias-label-dimmed,rgba(232,232,234,.35))}",
  ".minput:focus,.mtextarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#8ab0ff)}",
  ".mtextarea{height:auto;min-height:72px;resize:vertical;padding:7px 9px;font-size:13px;line-height:1.5}",
  ".mfield{display:block;margin:6px 0}",
  ".mfield-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0aa);margin-bottom:4px}",
  "/* ---- 卡片 / 行 / 列表 ---- */",
  ".mcard{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05))}",
  ".mcard.bad{border-color:var(--dsw-alias-state-error-primary,rgba(255,120,120,.5));background:rgba(255,90,90,.08)}",
  ".mrow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.1))}",
  ".mrow:last-child{border-bottom:none}",
  ".mrow .grow{flex:1;min-width:0}",
  ".mtext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary,inherit);opacity:.85}",
  ".meta{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(232,232,234,.5))}",
  ".mtag{font-size:10px;opacity:.65;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.15));border-radius:4px;padding:1px 6px;flex:none;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0aa)}",
  "/* ---- 图标动作按钮（消息动作条，对齐系统 IconActions：28px 正圆 + 16px 图标） ---- */",
  ".mact{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;transition:color .15s,background .15s}",
  ".mact:hover:not(:disabled){color:var(--dsw-alias-label-secondary,#aab0ba);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
  ".mact[data-active='true']{color:var(--dsw-alias-state-business-primary,#4176e6)}",
  ".mact:disabled{opacity:.4;cursor:default}",
  ".mact:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}",
  ".mact svg{display:block}",
  "/* ---- 对话框（DSH Modal） ---- */",
  ".mdlayer{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.48));z-index:1100;display:flex;align-items:center;justify-content:center}",
  ".mdlg{width:480px;max-width:94vw;max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#26272d);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:8px;box-shadow:0 12px 40px rgba(0,0,0,.3)}",
  "/* ---- 状态 / 提示 ---- */",
  ".mstatus{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0aa);padding:2px 0;line-height:1.55}",
  ".mstatus.err{color:var(--dsw-alias-state-error-primary,#ff5f5f)}",
  ".mstatus.ok{color:var(--dsw-alias-state-success-primary,#22c55e)}",
  ".msep{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.6px}",
  ".mrow-excl{opacity:.55}",
  ".mrow-excl .mtext{text-decoration:line-through}",
  "/* ---- 消息页（轨迹风格：参考 DSH trajectory 的轮次头 + 步骤行） ---- */",
  ".mturn-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px;background:var(--dsw-alias-button-ghost-active-fill,rgba(128,128,128,.12));margin-bottom:8px}",
  ".mturn-title{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}",
  ".mturn-meta{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mturn-body{display:flex;flex-direction:column;gap:6px;padding:0 0 14px}",
  ".mcell{display:flex;align-items:center;gap:10px;height:38px;padding:0 10px 0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.07));min-width:0;box-sizing:border-box}",
  ".mcell.excl{opacity:.5}",
  ".mcell.excl .mcell-text{text-decoration:line-through}",
  ".mcell.sel{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);border-color:transparent}",
  ".mcell-index{flex:none;width:20px;font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0aa);text-align:right}",
  ".mcell-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}",
  ".mcell-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);white-space:nowrap}",
  ".mkind{display:inline-flex;align-items:center;flex:none;box-sizing:border-box;height:22px;padding:0 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap}",
  ".mkind.user{color:var(--dsw-alias-state-success-primary,#22c55e);background:var(--dsw-alias-state-success-tertiary,rgba(34,197,94,.12))}",
  ".mkind.assistant{color:#6d9bff;background:rgba(96,132,253,.13)}",
  ".mkind.tool{color:var(--dsw-alias-state-warn-label,#dd8629);background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.13))}",
  ".msettings{display:flex;flex-direction:column;gap:14px;padding:4px 0}",
  ".msetting-row{display:flex;align-items:center;gap:12px;min-height:36px}",
  ".msetting-row .grow{flex:1;min-width:0}",
  ".msetting-name{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".msetting-desc{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);margin-top:1px}",
  "/* ---- 错误卡片（Error Boundary） ---- */",
  ".mcrash{border:1px solid var(--dsw-alias-state-error-primary,rgba(255,120,120,.5));border-radius:10px;padding:12px 14px;background:rgba(255,90,90,.08);display:flex;flex-direction:column;gap:8px}",
  ".mcrash-title{color:var(--dsw-alias-state-error-primary,#ff8f8f);font-weight:600;font-size:13px}",
  ".mcrash pre{white-space:pre-wrap;word-break:break-all;font-size:11px;opacity:.85;max-height:160px;overflow:auto;margin:0;font-family:var(--ds-font-family-code,monospace)}",
  "/* ---- 加载中 ---- */",
  ".mspin{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-top-color:var(--dsw-alias-state-business-primary,#4176e6);border-radius:50%;animation:mspin .7s linear infinite;vertical-align:-2px}",
  "@keyframes mspin{to{transform:rotate(360deg)}}",
  "/* ---- 输入栏记忆按钮 ---- */",
  ".mem-input-btn{display:inline-flex;align-items:center;gap:5px;cursor:pointer;background:none;border:none;color:inherit;font-size:12px;padding:4px 8px;border-radius:14px;height:28px}",
  ".mem-input-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
  ".mem-input-btn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}",
].join("\n");

function installStyles() {
  const id = "@dsh-external/dsh-memory-manager/client";
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {};
  const style = document.createElement("style");
  style.dataset.plugin = "@dsh-external/dsh-memory-manager";
  style.dataset.pluginCss = id;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => { try { style.remove() } catch { /* ignore */ } };
}

// ================= 基础组件（DSH 风格） =================
const Btn = (props) => h("button", {
  type: "button",
  className: ["mbtn", props.kind || "", props.sm ? "sm" : ""].filter(Boolean).join(" "),
  onClick: props.onClick, disabled: props.disabled, title: props.title || "",
  style: props.style || undefined,
}, props.children);
/** DSH Switch：role=switch + track/thumb */
const Switch = (props) => h("button", {
  type: "button", role: "switch", "aria-checked": !!props.on,
  "aria-label": props.label || "", className: "msw",
  onClick: props.onChange, disabled: props.disabled, title: props.title || "",
}, h("span", { className: "msw-track", "data-on": props.on ? "true" : undefined }, h("span", { className: "msw-thumb" })));
/** 图标按钮（消息动作条） */
const IconBtn = (props) => h("button", {
  type: "button", className: "mact", title: props.title || "",
  "data-active": props.active ? "true" : undefined,
  onClick: props.onClick, disabled: props.disabled,
}, props.children);
const Field = (props) => h("label", { className: "mfield" },
  h("span", { className: "mfield-label" }, props.label),
  h("input", { className: "minput", value: props.value, onChange: (e) => props.onChange(e.target.value), placeholder: props.placeholder || "" }));
const Area = (props) => h("label", { className: "mfield" },
  h("span", { className: "mfield-label" }, props.label),
  h("textarea", { className: "mtextarea", value: props.value, onChange: (e) => props.onChange(e.target.value), placeholder: props.placeholder || "", rows: props.rows || 4 }));
const Empty = (text) => h("div", { className: "mstatus", style: { padding: "18px 0", textAlign: "center" } }, text);
const Spinner = (text) => h("div", { className: "mstatus", style: { padding: "16px 0", textAlign: "center" } },
  h("span", { className: "mspin" }), " " + (text || "加载中…"));
const IconSave = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" },
  h("path", { d: "M3 2.5h6.5L13 6v7.5H3z" }), h("path", { d: "M5 2.5V6h4.5V2.5M5.5 13.5v-4.5h5v4.5" }));
const IconPin = () => h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" },
  h("path", { d: "M9.2 1.6 14.4 6.8 11 7.6 13.4 10l-3.4 3.4-3-3-1.6 3.2L3.6 11.4l3-1.6-3-3L6 4.2z" }));

// ================= Error Boundary（崩溃兜底 + 日志 + 自愈） =================
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    try {
      log("error", this.props.tag || "boundary",
        (error && error.message) ? error.message : String(error),
        { stack: (error && error.stack) || "" });
    } catch { /* ignore */ }
    if (this.props.onCrash) { try { this.props.onCrash(error) } catch { /* ignore */ } }
  }
  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    return h("div", { className: "mcrash" },
      h("div", { className: "mcrash-title" }, "界面组件发生错误（已记录到日志）"),
      h("pre", null, String((err && err.message) || err) +
        (err && err.stack ? "\n" + String(err.stack).split("\n").slice(0, 6).join("\n") : "")),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        h(Btn, { sm: true, onClick: () => this.setState({ error: null }) }, "重试"),
        this.props.onReset ? h(Btn, { sm: true, kind: "primary", onClick: this.props.onReset }, "返回计划页") : null));
  }
}

// ================= 保存对话框（面板 / 消息动作条共用） =================
function SaveDialog(props) {
  const [title, setTitle] = useState("");
  const [imp, setImp] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const sid = props.sessionId;
  const linkIds = (props.planMemories || []).map((m) => m.id).join(", ");
  const save = async () => {
    setBusy(true); setErr("");
    const r = await call("session.saveAsMemory", {
      messageIds: props.messageIds, title, impressions: imp.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean),
      notes, links: linkIds ? linkIds.split(",").map((s) => s.trim()).filter(Boolean) : [],
    }, sid);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone(r);
  };
  const suggest = async () => {
    setSuggesting(true); setErr("");
    const r = await call("session.messages", { limit: 100 }, sid);
    setSuggesting(false);
    if (r.error) { setErr(r.error); return; }
    const ids = new Set(props.messageIds);
    let text = "";
    for (const t of r.turns || []) for (const n of t.nodes || []) if (ids.has(n.id)) text += n.preview + "\n";
    if (!text.trim()) { setErr("无法获取消息内容"); return; }
    const s = await call("memory.suggest", { content: text.slice(0, 4000) });
    if (s.error) { setErr(s.error); return; }
    setImp((s.impressions || []).join("、"));
  };
  return h("div", { className: "mdlayer", onClick: props.onClose },
    h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
      h("div", { style: { fontWeight: 600, fontSize: 14 } }, "保存为记忆"),
      h("div", { className: "mstatus" }, "已选 " + props.messageIds.length + " 条消息" + (linkIds ? " · 将自动关联计划中的记忆: " + linkIds : "")),
      Field({ label: "标题", value: title, onChange: setTitle, placeholder: "留空自动生成" }),
      Field({ label: "印象（逗号分隔，可随时修改）", value: imp, onChange: setImp, placeholder: "如: 架构, 决策" }),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
        h(Btn, { sm: true, kind: "outline", onClick: suggest, disabled: suggesting }, suggesting ? "生成中…" : "✨ 生成印象建议")),
      Area({ label: "标注（可选注释）", value: notes, onChange: setNotes, rows: 3 }),
      err ? h("div", { className: "mstatus err" }, err) : null,
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h(Btn, { onClick: props.onClose }, "取消"),
        h(Btn, { kind: "primary", onClick: save, disabled: busy }, busy ? "保存中…" : "保存"))));
}

// ---------------- 组合对话框 ----------------
function ComposeDialog(props) {
  const [mode, setMode] = useState("concat");
  const [title, setTitle] = useState("");
  const [imp, setImp] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const gen = async (llmMode) => {
    setBusy(true); setErr("");
    const r = await call("memory.compose", { ids: props.ids, mode: llmMode ? "llm" : "concat", title: title || "组合记忆", impressions: imp.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), body });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    if (llmMode) setBody("");
    props.onDone();
  };
  const saveManual = async () => {
    setBusy(true); setErr("");
    const r = await call("memory.compose", { ids: props.ids, mode: "manual", title: title || "组合记忆", impressions: imp.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), body });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone();
  };
  return h("div", { className: "mdlayer", onClick: props.onClose },
    h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
      h("div", { style: { fontWeight: 600, fontSize: 14 } }, "组合为新记忆（" + props.ids.length + " 条源记忆，源记忆保留）"),
      h("div", { className: "mstatus" }, "选择组合方式，源记忆不会被修改"),
      h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
        ["concat", "llm", "manual"].map((m) =>
          h("label", { key: m, style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
            h("input", { type: "radio", checked: mode === m, onChange: () => setMode(m) }),
            m === "concat" ? "原文拼接" : (m === "llm" ? "LLM 综合" : "手动编辑")))),
      Field({ label: "标题", value: title, onChange: setTitle, placeholder: "留空为「组合记忆」" }),
      Field({ label: "新印象（逗号分隔）", value: imp, onChange: setImp, placeholder: "组合后的简短总结" }),
      mode === "manual" ? Area({ label: "正文", value: body, onChange: setBody, rows: 6 }) : null,
      err ? h("div", { className: "mstatus err" }, err) : null,
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h(Btn, { onClick: props.onClose }, "取消"),
        mode === "manual"
          ? h(Btn, { kind: "primary", onClick: saveManual, disabled: busy }, busy ? "保存中…" : "保存")
          : h(Btn, { kind: "primary", onClick: () => gen(mode === "llm"), disabled: busy }, busy ? "处理中…" : (mode === "llm" ? "LLM 综合并保存" : "拼接并保存")))));
}

// ---------------- 编辑对话框 ----------------
function EditDialog(props) {
  const [title, setTitle] = useState(props.meta.title || "");
  const [imp, setImp] = useState((props.meta.impressions || []).join("、"));
  const [links, setLinks] = useState((props.meta.links || []).join(", "));
  const [notes, setNotes] = useState(props.notes || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [armDel, setArmDel] = useState(false);
  useEffect(() => {
    if (!armDel) return;
    const t = setTimeout(() => setArmDel(false), 4000);
    return () => clearTimeout(t);
  }, [armDel]);
  const save = async () => {
    setBusy(true); setErr("");
    const r = await call("memory.update", {
      id: props.meta.id,
      patch: { title, impressions: imp.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), links: links.split(",").map((s) => s.trim()).filter(Boolean), notes },
    });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone();
  };
  const del = async () => {
    if (!armDel) { setArmDel(true); return; }
    setBusy(true); setErr("");
    const r = await call("memory.delete", { id: props.meta.id });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone();
  };
  return h("div", { className: "mdlayer", onClick: props.onClose },
    h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
      h("div", { style: { fontWeight: 600, fontSize: 14 } }, "编辑记忆 · " + props.meta.id),
      h("div", { className: "mstatus" },
        "组合来源: " + ((props.meta.composedOf || []).join(", ") || "无") + " · 被引用: " + ((props.meta.backlinks || []).join(", ") || "无")),
      Field({ label: "标题", value: title, onChange: setTitle }),
      Field({ label: "印象", value: imp, onChange: setImp }),
      Field({ label: "关联记忆 id（逗号分隔）", value: links, onChange: setLinks }),
      Area({ label: "标注（可编辑注释层）", value: notes, onChange: setNotes, rows: 5 }),
      h("div", { className: "mcard", style: { maxHeight: 120, overflow: "auto" } },
        h("div", { className: "mfield-label" }, "快照（不可变，仅作查看）"),
        h("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: .8, margin: 0 } }, String(props.snapshot || "").slice(0, 2000) + (props.snapshot && props.snapshot.length > 2000 ? "…" : ""))),
      err ? h("div", { className: "mstatus err" }, err) : null,
      h("div", { style: { display: "flex", gap: 8, justifyContent: "space-between" } },
        h(Btn, { kind: "danger", sm: true, onClick: del, disabled: busy, title: "删除该记忆（快照不可恢复）" }, armDel ? "再次点击确认删除" : "删除"),
        h("div", { style: { display: "flex", gap: 8 } },
          h(Btn, { onClick: props.onClose }, "取消"),
          h(Btn, { kind: "primary", onClick: save, disabled: busy }, busy ? "保存中…" : "保存")))));
}

// ---------------- 计划页（开关化 + 明确状态） ----------------
function PlanTab(props) {
  const cfg = props.config, plan = props.plan;
  const setMode = async (mode) => { const r = await call("state.setMode", { mode }); if (!r.error) props.refresh(); };
  const injectOnce = async (v) => { const r = await call("plan.injectOnce", { v }); if (!r.error) props.refresh(); };
  const unpin = async (id) => { const r = await call("session.pin", { messageIds: [id], pin: false }); if (!r.error) props.refresh(); };
  const rmMem = async (id) => { const r = await call("plan.removeMemory", { id }); if (!r.error) props.refresh(); };
  const reincl = async (turnId) => { const r = await call("plan.excludeTurn", { turnId, exclude: false }); if (!r.error) props.refresh(); };
  const setView = async (v) => { const r = await call("state.setView", { view: v }); if (!r.error) props.refresh(); };
  const setModelTools = async (v) => { const r = await call("state.setModelTools", { v }); if (!r.error) props.refresh(); };
  return h("div", null, [
    h("div", { key: "mode", className: "mcard" },
      h("div", { className: "msetting-row" },
        h("div", { className: "grow" },
          h("div", { className: "msetting-name" }, "临时记忆模式"),
          h("div", { className: "msetting-desc" }, cfg.mode === "on" ? "已开启：每次发送自动注入固定消息与勾选记忆" : "已关闭：不自动注入，可单次注入")),
        Switch({ on: cfg.mode === "on", onChange: () => setMode(cfg.mode === "on" ? "off" : "on"), label: "临时记忆模式" })),
      h("div", { key: "once", className: "msetting-row", style: { marginTop: 8 } },
        h("div", { className: "grow" },
          h("div", { className: "msetting-name" }, "仅本次发送注入"),
          h("div", { className: "msetting-desc" }, (plan && plan.injectOnce) === true ? "已开启：下一次发送时注入一次，随后自动关闭" : (cfg.mode === "on" ? "临时记忆模式已开启，无需单独使用" : "开启后仅下一次发送注入固定消息与勾选记忆，随后自动关闭"))),
        Switch({ on: (plan && plan.injectOnce) === true, onChange: () => injectOnce(!((plan && plan.injectOnce) === true)), label: "仅本次发送注入", disabled: cfg.mode === "on" }))),
    h("div", { key: "view", className: "msetting-row" },
      h("div", { className: "grow" },
        h("div", { className: "msetting-name" }, "记忆注入视图（" + (cfg.view === "full" ? "全文" : "紧凑") + "）"),
        h("div", { className: "msetting-desc" }, "开启=注入完整快照；关闭=仅标题+印象+预览，模型需要细节时可用 memory_recall 读全文")),
      Switch({ on: cfg.view === "full", onChange: () => setView(cfg.view === "full" ? "compact" : "full"), label: "记忆注入视图（全文）" })),
    h("div", { key: "tools", className: "msetting-row" },
      h("div", { className: "grow" },
        h("div", { className: "msetting-name" }, "Agent 记忆工具"),
        h("div", { className: "msetting-desc" }, "允许模型直接调用 memory_search / recall / save / pin")),
      Switch({ on: !!cfg.modelTools, onChange: () => setModelTools(!cfg.modelTools), label: "Agent 记忆工具" })),
    h("div", { key: "pins", className: "msep" }, "固定消息（" + (plan.pinned || []).length + "）"),
    (plan.pinned || []).length === 0 ? Empty("暂无固定消息：在对话中点消息下方的 📌 图标即可固定") :
      (plan.pinned || []).map((p) => p ? h("div", { key: p.id, className: "mrow" },
        h("span", { className: "mtag" }, p.role || "msg"),
        h("span", { className: "grow mtext", title: p.text }, p.text),
        h(Btn, { sm: true, kind: "outline", onClick: () => unpin(p.id) }, "取消固定")) : null),
    h("div", { key: "mems", className: "msep" }, "勾选记忆（" + (plan.memories || []).length + "）"),
    (plan.memories || []).length === 0 ? Empty("暂无勾选记忆：到「记忆库」点「加入计划」") :
      (plan.memories || []).map((m) => m ? h("div", { key: m.id, className: "mrow" },
        h("span", { className: "grow mtext", title: m.title }, m.title),
        h("span", { className: "meta" }, (m.impressions || []).join("、")),
        h(Btn, { sm: true, kind: "outline", onClick: () => rmMem(m.id) }, "移除")) : null),
    h("div", { key: "excl", className: "msep" }, "已排除的轮次（" + (plan.excluded || []).length + "，点击恢复）"),
    (plan.excluded || []).length === 0 ? Empty("无排除：到「消息」页取消勾选轮次") :
      (plan.excluded || []).map((t) => t ? h("div", { key: t, className: "mrow mrow-excl" },
        h("span", { className: "grow mtext" }, String(t)),
        h(Btn, { sm: true, kind: "outline", onClick: () => reincl(t) }, "恢复")) : null),
  ]);
}

// ---------------- 记忆库页 ----------------
function LibraryTab(props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const [detail, setDetail] = useState(null);
  const [related, setRelated] = useState([]);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const mems = props.memories || [];
  const q = search.trim().toLowerCase();
  const shown = q ? mems.filter((m) => m && (
    (m.title || "").toLowerCase().includes(q) ||
    (m.impressions || []).some((i) => i && i.toLowerCase().includes(q)) ||
    (m.id || "").toLowerCase().includes(q))) : mems;
  const toggleSel = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const addPlan = async (id) => { const r = await call("plan.addMemory", { id }); if (!r.error) props.refresh(); };
  const openDetail = async (id) => {
    setBusy(true);
    const [r, rr] = await Promise.all([
      call("memory.read", { id }),
      call("memory.related", { id, depth: 2, limit: 20 }),
    ]);
    setBusy(false);
    if (r.error) return;
    setDetail(r);
    setRelated(rr.error ? [] : (rr.related || []));
    setFull(false);
  };
  const openEdit = async (id) => {
    setBusy(true);
    const r = await call("memory.read", { id });
    setBusy(false);
    if (r.error) return;
    setEdit({ meta: r.meta, notes: r.notes, snapshot: r.snapshot });
  };
  return h(Boundary, { tag: "library-tab" },
    h("div", null, [
      h("div", { key: "bar", style: { display: "flex", gap: 6 } },
        h("input", { className: "minput", placeholder: "按印象 / 标题 / id 搜索…", value: search, onChange: (e) => setSearch(e.target.value) }),
        h(Btn, { kind: "ghost", onClick: () => props.refresh(), title: "重新扫描记忆库" }, "刷新")),
      h("div", { key: "compose", style: { display: "flex", gap: 6, alignItems: "center", marginTop: 2 } },
        h("span", { className: "mstatus" }, selected.length ? "已选 " + selected.length + " 条" : "勾选多条记忆可组合为新记忆（源记忆保留）"),
        selected.length >= 2 ? h(Btn, { kind: "primary", sm: true, onClick: () => setComposeOpen(true) }, "组合为新记忆") : null,
        selected.length ? h(Btn, { sm: true, kind: "ghost", onClick: () => setSelected([]) }, "清空") : null),
      busy ? h("div", { key: "busy", className: "mstatus" }, h("span", { className: "mspin" }), " 读取中…") : null,
      shown.length === 0 ? Empty("记忆库为空：在对话中点消息下方的 💾 图标保存为记忆") :
        shown.map((m) => m ? h("div", { key: m.id, className: "mcard" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("input", { type: "checkbox", checked: selected.includes(m.id), onChange: () => toggleSel(m.id), title: "勾选用于组合" }),
            h("span", { style: { flex: 1, cursor: "pointer", fontWeight: 500, fontSize: 13 }, onClick: () => openDetail(m.id), title: "查看详情" }, m.title || m.id),
            h(Btn, { sm: true, kind: "outline", onClick: () => addPlan(m.id), title: "加入当前会话的注入计划" }, "加入计划"),
            h(Btn, { sm: true, kind: "ghost", onClick: () => openEdit(m.id) }, "编辑")),
          h("div", { className: "mimpr", style: { marginTop: 3 } }, "印象: " + ((m.impressions || []).join("、") || "—")),
          h("div", { className: "meta" },
            m.id + (m.composedOf && m.composedOf.length ? " · 组合自 " + m.composedOf.join(", ") : "") +
            (m.links && m.links.length ? " · 链接 " + m.links.join(", ") : "") +
            (m.backlinks && m.backlinks.length ? " · 被引用 " + m.backlinks.join(", ") : ""))) : null),
      composeOpen ? h(Boundary, { key: "compose", tag: "compose-dialog", onReset: () => setComposeOpen(false) },
        h(ComposeDialog, { ids: selected, onClose: () => setComposeOpen(false), onDone: () => { setComposeOpen(false); setSelected([]); props.refresh(); } })) : null,
      edit ? h(Boundary, { key: "edit", tag: "edit-dialog", onReset: () => setEdit(null) },
        h(EditDialog, { meta: edit.meta, notes: edit.notes || "", snapshot: edit.snapshot || "", onClose: () => setEdit(null), onDone: () => { setEdit(null); props.refresh(); } })) : null,
      detail ? h(Boundary, { key: "detail", tag: "detail-dialog", onReset: () => setDetail(null) },
        h("div", { className: "mdlayer", onClick: () => setDetail(null) },
          h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
            h("div", { style: { fontWeight: 600, fontSize: 14 } }, (detail.meta && detail.meta.title) || detail.meta.id),
            h("div", { className: "mstatus" }, "id: " + detail.meta.id + " · 来源会话: " + (detail.meta.sourceSession || "无")),
            h("div", { className: "mstatus" }, "印象: " + ((detail.meta.impressions || []).join("、") || "无") + " · 组合自: " + ((detail.meta.composedOf || []).join(", ") || "无")),
            h("div", { className: "mstatus" }, "链接: " + ((detail.meta.links || []).join(", ") || "无") + " · 被引用: " + ((detail.meta.backlinks || []).join(", ") || "无")),
            h("div", { style: { display: "flex", gap: 6, margin: "4px 0" } },
              h(Btn, { sm: true, kind: "outline", onClick: () => setFull(!full) }, full ? "收起快照" : "展开快照"),
              h(Btn, { sm: true, kind: "ghost", onClick: () => setEdit(detail.meta) }, "编辑")),
            full ? h("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: .85, maxHeight: 300, overflow: "auto", background: "var(--dsw-alias-bg-base,rgba(0,0,0,.2))", padding: 8, borderRadius: 6 } }, String(detail.snapshot || "")) : null,
            h("div", { className: "mfield-label" }, "标注"),
            h("pre", { style: { whiteSpace: "pre-wrap", fontSize: 12, opacity: .9, maxHeight: 160, overflow: "auto", margin: 0 } }, String(detail.notes || "（无）")),
            h("div", { className: "msep" }, "相关记忆（链式回忆 · 点击跳转）"),
            (related || []).length === 0 ? h("div", { className: "mstatus" }, "无关联记忆（可编辑时添加 links）") :
              (related || []).map((r) => r ? h("div", { key: r.id, className: "mrow" },
                h("span", { className: "mtag" }, "d" + r.distance),
                h("span", { className: "grow mtext", style: { cursor: "pointer" }, title: r.id, onClick: () => openDetail(r.id) }, r.title || r.id),
                h("span", { className: "meta" }, (r.impressions || []).join("、"))) : null)))) : null,
    ]));
}

// ---------------- 消息页（轨迹风格：sticky 轮次头 + 步骤行卡片，参考 DSH trajectory） ----------------
function MessagesTab(props) {
  const [sel, setSel] = useState([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [err, setErr] = useState("");
  const toggle = (id) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const excl = async (turnId, exclude) => {
    const r = await call("plan.excludeTurn", { turnId, exclude });
    if (r.error) { setErr(r.error); return; }
    setErr("");
    props.refresh();
  };
  const pin = async (ids, v) => { const r = await call("session.pin", { messageIds: ids, pin: v }); if (!r.error) props.refresh(); };
  const fmtTime = (t) => {
    if (!t) return "";
    try {
      const d = new Date(Number(t));
      return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
    } catch { return ""; }
  };
  const kindClass = (k) => (k === "user" ? "user" : (k === "tool" ? "tool" : "assistant"));
  const kindLabel = (k) => (k === "user" ? "用户" : (k === "tool" ? "工具" : "助手"));
  const turnStart = (t) => (t.nodes || []).find((n) => n && n.time);
  return h(Boundary, { tag: "messages-tab" },
    h("div", null, [
      h("div", { key: "bar", style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        h("span", { className: "mstatus" }, "勾选消息 → 保存为记忆 / 固定；轮次头右侧可排除（非破坏，随时恢复）"),
        h(Btn, { sm: true, kind: "ghost", onClick: () => props.refresh() }, "刷新")),
      h("div", { key: "acts", style: { display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap" } },
        sel.length ? [
          h(Btn, { key: "s", kind: "primary", sm: true, onClick: () => setSaveOpen(true) }, "保存为记忆（" + sel.length + "）"),
          h(Btn, { key: "p", sm: true, kind: "outline", onClick: () => pin(sel, true), title: "固定为临时记忆，模式开启时自动注入" }, "固定所选"),
          h(Btn, { key: "u", sm: true, kind: "ghost", onClick: () => pin(sel, false) }, "取消固定所选"),
          h(Btn, { key: "c", sm: true, kind: "ghost", onClick: () => setSel([]) }, "清空"),
        ] : h("span", { key: "hint", className: "mstatus" }, "（消息级勾选）")),
      err ? h("div", { key: "err", className: "mstatus err" }, err) : null,
      (props.turns || []).length === 0 ? Empty("暂无消息") :
        (props.turns || []).map((t, ti) => t ? h("div", { key: t.turnId, className: "mturn" },
          h("div", { className: "mturn-head", title: "轮次 id: " + String(t.turnId) },
            h("span", { className: "mturn-title" }, (t.marker ? "🚫 已排除 · " : "") + "轮次 " + (ti + 1)),
            h("span", { className: "mturn-meta" }, (t.nodes || []).length + " 条消息" + (turnStart(t) ? " · " + fmtTime(turnStart(t).time) : "")),
            t.excluded
              ? h(Btn, { sm: true, kind: "outline", onClick: () => excl(t.turnId, false), title: "恢复该轮次参与对话" }, "恢复")
              : h(Btn, { sm: true, kind: "ghost", onClick: () => excl(t.turnId, true), title: "排除该轮次（不删除，可随时恢复）" }, "排除")),
          h("div", { className: "mturn-body" },
            (t.nodes || []).map((n, ni) => n ? h("div", { key: n.seq, className: "mcell" + (t.excluded ? " excl" : "") + (sel.includes(n.id) ? " sel" : "") },
              h("input", { type: "checkbox", checked: sel.includes(n.id), onChange: () => toggle(n.id), title: "勾选此消息" }),
              h("span", { className: "mcell-index" }, String(ni + 1)),
              h("span", { className: "mkind " + kindClass(n.kind) }, kindLabel(n.kind)),
              h("span", { className: "mcell-text", title: n.preview || "" },
                n.preview || (n.kind === "tool" ? "（工具调用，无文本）" : (n.kind === "assistant" ? "（助手回复，无文本）" : "（无文本）"))),
              h("span", { className: "mcell-time" }, fmtTime(n.time)))
              : null))) : null),
      saveOpen ? h(Boundary, { key: "save", tag: "save-dialog", onReset: () => setSaveOpen(false) },
        h(SaveDialog, { messageIds: sel, planMemories: (props.planMemories || []), onClose: () => setSaveOpen(false), onDone: () => { setSaveOpen(false); setSel([]); props.refresh(); } })) : null,
    ]));
}

// ---------------- 图谱页（力导向 SVG） ----------------
function graphLayout(mems) {
  const nodes = (mems || []).filter(Boolean).slice(0, 60);
  const ids = new Set(nodes.map((m) => m.id));
  const edges = [];
  for (const m of nodes) {
    for (const lid of (m.links || [])) {
      if (ids.has(lid)) edges.push({ s: m.id, t: lid });
    }
  }
  const n = nodes.length;
  if (!n) return { nodes: [], edges };
  const pos = new Map();
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(nd.id, { x: Math.cos(a) * 180, y: Math.sin(a) * 120, vx: 0, vy: 0 });
  });
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) || 0) + 1);
    degree.set(e.t, (degree.get(e.t) || 0) + 1);
  }
  for (let iter = 0; iter < 160; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].id);
        const b = pos.get(nodes[j].id);
        if (!a || !b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = 9000 / d2;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.s);
      const b = pos.get(e.t);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = d * 0.03;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const nd of nodes) {
      const p = pos.get(nd.id);
      if (!p) continue;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x += p.vx;
      p.y += p.vy;
      p.x += -p.x * 0.012;
      p.y += -p.y * 0.012;
    }
  }
  const laid = nodes.map((nd) => {
    const p = pos.get(nd.id);
    return {
      id: nd.id,
      title: String(nd.title || nd.id),
      x: Math.round(p.x * 1.4 + 300),
      y: Math.round(p.y * 1.4 + 210),
      r: 6 + Math.min(10, (degree.get(nd.id) || 0) * 3),
    };
  });
  return { nodes: laid, edges };
}
function nodePos(g, id) { const nd = g.nodes.find((x) => x.id === id); return nd ? { x: nd.x, y: nd.y } : null; }

function GraphTab(props) {
  const [detail, setDetail] = useState(null);
  const [full, setFull] = useState(false);
  const [related, setRelated] = useState([]);
  const [busy, setBusy] = useState(false);
  const mems = props.memories || [];
  let g = null;
  try { g = graphLayout(mems); } catch (e) { log("error", "graph-layout", String((e && e.message) || e), { stack: e && e.stack }); g = { nodes: [], edges: [] }; }
  const openDetail = async (id) => {
    setBusy(true);
    const [r, rr] = await Promise.all([
      call("memory.read", { id }),
      call("memory.related", { id, depth: 2, limit: 20 }),
    ]);
    setBusy(false);
    if (r.error) return;
    setDetail(r);
    setRelated(rr.error ? [] : (rr.related || []));
    setFull(false);
  };
  return h(Boundary, { tag: "graph-tab" },
    h("div", null, [
      h("div", { key: "bar", style: { display: "flex", gap: 6, alignItems: "center" } },
        h("span", { className: "mstatus" }, mems.length + " 条记忆 · 点击节点查看详情（线条=链接，圆点大小=关联度）"),
        h(Btn, { sm: true, kind: "ghost", onClick: () => props.refresh() }, "刷新")),
      mems.length === 0 ? Empty("记忆库为空") :
        h("svg", { key: "svg", viewBox: "0 0 600 420", style: { width: "100%", background: "var(--dsw-alias-bg-base,rgba(0,0,0,.18))", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))" } },
          (g.edges || []).map((e) => { const p1 = nodePos(g, e.s), p2 = nodePos(g, e.t); return (p1 && p2) ? h("line", { key: e.s + "|" + e.t, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: "var(--dsw-alias-border-l2,rgba(128,128,128,.4))", strokeWidth: 1 }) : null; }),
          (g.nodes || []).map((nd) =>
            h("g", { key: nd.id, style: { cursor: "pointer" }, onClick: () => openDetail(nd.id) },
              h("circle", { cx: nd.x, cy: nd.y, r: nd.r, fill: "var(--dsw-alias-state-business-primary,#4176e6)", opacity: .85 }),
              h("text", { x: nd.x, y: nd.y - nd.r - 4, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary,#c8d2e8)", fontSize: 10 }, String(nd.title).slice(0, 14))))),
      busy ? h("div", { key: "busy", className: "mstatus" }, h("span", { className: "mspin" }), " 读取中…") : null,
      detail ? h(Boundary, { key: "detail", tag: "graph-detail", onReset: () => setDetail(null) },
        h("div", { className: "mdlayer", onClick: () => setDetail(null) },
          h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
            h("div", { style: { fontWeight: 600, fontSize: 14 } }, (detail.meta && detail.meta.title) || detail.meta.id),
            h("div", { className: "mstatus" }, "id: " + detail.meta.id + " · 印象: " + ((detail.meta.impressions || []).join("、") || "无")),
            h("div", { className: "mstatus" }, "链接: " + ((detail.meta.links || []).join(", ") || "无") + " · 被引用: " + ((detail.meta.backlinks || []).join(", ") || "无")),
            h("div", { style: { display: "flex", gap: 6, margin: "4px 0" } },
              h(Btn, { sm: true, kind: "outline", onClick: () => setFull(!full) }, full ? "收起快照" : "展开快照"),
              h(Btn, { sm: true, kind: "primary", onClick: async () => { const r = await call("plan.addMemory", { id: detail.meta.id }); if (!r.error) props.refresh(); } }, "加入计划")),
            full ? h("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: .85, maxHeight: 240, overflow: "auto", background: "var(--dsw-alias-bg-base,rgba(0,0,0,.2))", padding: 8, borderRadius: 6 } }, String(detail.snapshot || "")) : null,
            h("div", { className: "msep" }, "相关记忆（链式回忆 · 点击跳转）"),
            (related || []).length === 0 ? h("div", { className: "mstatus" }, "无关联记忆") :
              (related || []).map((r) => r ? h("div", { key: r.id, className: "mrow" },
                h("span", { className: "mtag" }, "d" + r.distance),
                h("span", { className: "grow mtext", style: { cursor: "pointer" }, title: r.id, onClick: () => openDetail(r.id) }, r.title || r.id),
                h("span", { className: "meta" }, (r.impressions || []).join("、"))) : null)))) : null,
    ]));
}

// ---------------- 主面板 ----------------
function Panel(props) {
  const [cfg, setCfg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [mems, setMems] = useState([]);
  const [turns, setTurns] = useState([]);
  const [tab, setTab] = useState(panel.tab);
  const [err, setErr] = useState("");
  const [libOpen, setLibOpen] = useState(false);
  const [libPath, setLibPath] = useState("");
  const seqRef = useRef(0);

  const refresh = async () => {
    const seq = ++seqRef.current;
    const st = await call("state.get", {}, panel.sessionId);
    if (seq !== seqRef.current) return;
    if (st.error) { setErr(st.error); return; }
    setErr("");
    setCfg(st.config);
    setPlan(st.plan);
    if (st.config && st.config.enabled) {
      const [ls, ms] = await Promise.all([
        call("library.scan", {}, panel.sessionId),
        call("session.messages", { limit: 40 }, panel.sessionId),
      ]);
      if (seq !== seqRef.current) return;
      if (!ls.error) setMems(ls.memories || []);
      if (!ms.error) setTurns(ms.turns || []);
      else if (tab === "messages") setErr(ms.error);
    }
  };
  useEffect(() => {
    log("info", "panel", "panel mounted, tab=" + tab + ", session=" + String(panel.sessionId).slice(-10));
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => { panel.open = false; props.onClose(); };
  const switchTab = (t) => {
    panel.tab = t;
    setTab(t);
    log("info", "panel", "switch tab -> " + t);
    if (t === "messages" || t === "library" || t === "graph") refresh();
  };
  const setLibrary = async () => {
    const r = await call("state.setLibrary", { path: libPath });
    if (r.error) { setErr(r.error); return; }
    setLibOpen(false); refresh();
  };
  const cfgMode = cfg ? cfg.mode : "off";
  const onCrash = () => {
    panel.crashed = true;
    log("error", "panel", "tab crashed, will fall back to plan on next open");
  };
  const resetToPlan = () => { panel.tab = "plan"; panel.crashed = false; setTab("plan"); };

  let content;
  if (!cfg) content = h("div", { className: "mstatus" }, h("span", { className: "mspin" }), " 加载中…");
  else if (cfg.enabled === false) content = h("div", { className: "mstatus" }, "记忆管理已禁用（设置 → 记忆管理 中开启）");
  else if (tab === "plan") content = h(Boundary, { tag: "plan-tab", onCrash, onReset: resetToPlan }, h(PlanTab, { config: cfg, plan, refresh }));
  else if (tab === "library") content = h(Boundary, { tag: "library-tab", onCrash, onReset: resetToPlan }, h(LibraryTab, { memories: mems, refresh }));
  else if (tab === "graph") content = h(Boundary, { tag: "graph-tab", onCrash, onReset: resetToPlan }, h(GraphTab, { memories: mems, refresh }));
  else content = h(Boundary, { tag: "messages-tab", onCrash, onReset: resetToPlan }, h(MessagesTab, { turns, planMemories: plan ? plan.memories : [], refresh }));

  return h("div", { className: "mem-wrap" },
    h("div", { className: "mem-head" },
      h("span", { className: "mem-title" }, "记忆管理"),
      h("span", { className: "mstate " + (cfgMode === "on" ? "on" : ""), title: cfgMode === "on" ? "临时记忆模式已开启，每次发送自动注入固定消息与勾选记忆" : "临时记忆模式已关闭，不自动注入" },
        cfgMode === "on" ? "模式：已开启" : "模式：已关闭"),
      h("span", { className: "mem-sid", title: panel.sessionId || "" }, panel.sessionId ? "#" + String(panel.sessionId).slice(-10) : ""),
      h(Btn, { sm: true, kind: "ghost", onClick: () => setLibOpen(!libOpen), title: "设置记忆库文件夹路径" }, "记忆库"),
      h(Btn, { sm: true, kind: "ghost", onClick: close, title: "关闭面板" }, "✕")),
    libOpen ? h("div", { key: "librow", style: { padding: "8px 16px", borderBottom: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))", display: "flex", gap: 6 } },
      h("input", { className: "minput", placeholder: cfg && cfg.libraryPath ? cfg.libraryPath : "输入记忆库文件夹绝对路径", value: libPath, onChange: (e) => setLibPath(e.target.value) }),
      h(Btn, { sm: true, kind: "primary", onClick: setLibrary }, "设为记忆库")) : null,
    h("div", { className: "mem-tabs" },
      ["plan", "library", "messages", "graph"].map((t) =>
        h("button", { key: t, className: "mem-tab" + (tab === t ? " on" : ""), onClick: () => switchTab(t) },
          t === "plan" ? "计划" : (t === "library" ? "记忆库" : (t === "messages" ? "消息" : "图谱"))))),
    h("div", { className: "mem-body" },
      err ? h("div", { className: "mstatus err" }, err) : null,
      h(Boundary, { tag: "panel-root", onCrash, onReset: resetToPlan }, content)));
}

// ---------------- 输入栏按钮（明确状态） ----------------
function InputButton(props) {
  const [mode, setMode] = useState("off");
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let alive = true;
    call("state.get", {}, props.sessionId).then((st) => {
      if (!alive) return;
      if (st.config) {
        setEnabled(st.config.enabled !== false);
        setMode(st.config.mode);
      }
    });
    return () => { alive = false; };
  }, [props.sessionId]);
  const onClick = () => {
    if (panel.crashed) {
      panel.crashed = false;
      panel.tab = "plan";
      log("warn", "input", "previous crash detected, reset tab to plan");
    }
    panel.sessionId = props.sessionId;
    panel.tab = panel.tab || "plan";
    panel.open = !panel.open;
    log("info", "input", "panel " + (panel.open ? "open" : "close"));
    notifyOverlay();
  };
  if (enabled === false) return null;
  return h("button", {
    className: "mem-input-btn",
    title: mode === "on" ? "记忆管理面板（临时记忆模式已开启，每次发送自动注入固定消息与勾选记忆）" : "记忆管理面板（临时记忆模式已关闭）",
    onClick,
  },
    "记忆 · " + (mode === "on" ? "已开启" : "已关闭"));
}

// ---------------- 消息动作条（对话界面直接操作） ----------------
function MessageActions(props) {
  const { messageId, sessionId } = props;
  const [saveOpen, setSaveOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 挂载时同步该消息的固定状态（已固定的消息显示激活态）
  useEffect(() => {
    let alive = true;
    call("state.get", {}, sessionId).then((st) => {
      if (!alive) return;
      const plan = st.plan;
      if (plan && Array.isArray(plan.pinned) && plan.pinned.some((p) => String(p.id) === String(messageId))) setPinned(true);
    });
    return () => { alive = false; };
  }, [messageId, sessionId]);
  const doPin = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    const r = await call("session.pin", { messageIds: [messageId], pin: !pinned }, sessionId);
    setBusy(false);
    if (r.error) { setErr(r.error); log("warn", "msg-actions", "pin failed: " + r.error); return; }
    setPinned(!pinned);
  };
  // 直接返回数组（带 key），间距由系统 IconActions 行统一管理（gap 10px）
  return [
    h(IconBtn, { key: "save", title: "将此消息保存为记忆", onClick: () => setSaveOpen(true) }, h(IconSave, {})),
    h(IconBtn, { key: "pin", title: pinned ? "取消固定（不再自动注入）" : "固定为临时记忆（模式开启时自动注入）", active: pinned, onClick: doPin, disabled: busy }, h(IconPin, {})),
    err ? h("span", { key: "err", className: "mstatus err", style: { fontSize: 10 } }, err) : null,
    saveOpen ? h(Boundary, { key: "dlg", tag: "msg-actions-save" },
      h(SaveDialog, { messageIds: [messageId], planMemories: [], sessionId, onClose: () => setSaveOpen(false), onDone: () => setSaveOpen(false) })) : null,
  ];
}

// ---------------- 设置页（明确开关 + 说明） ----------------
function SettingsSection(props) {
  const [cfg, setCfg] = useState(null);
  const [libPath, setLibPath] = useState("");
  const [caps, setCaps] = useState({ memoryChars: "", totalChars: "", pinChars: "" });
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const load = async () => {
    const st = await call("state.get");
    if (st.error) { setErr(st.error); return; }
    setErr("");
    setCfg(st.config);
    setLibPath(st.config ? st.config.libraryPath : "");
    setCaps(st.config ? { memoryChars: String(st.config.memoryChars), totalChars: String(st.config.totalChars), pinChars: String(st.config.pinChars) } : caps);
  };
  useEffect(() => { load(); }, []);
  const act = async (op, args, label) => {
    const r = await call(op, args);
    if (r.error) { setErr(r.error); return; }
    setErr(""); setOk(label || "已保存 ✓");
    setTimeout(() => setOk(""), 2000);
    load();
  };
  const Row = (name, desc, control) => h("div", { className: "msetting-row" },
    h("div", { className: "grow" },
      h("div", { className: "msetting-name" }, name),
      desc ? h("div", { className: "msetting-desc" }, desc) : null),
    control);
  if (!cfg) return h("div", { className: "msettings" }, h("div", { className: "mstatus" }, h("span", { className: "mspin" }), " 加载中…"));
  return h(Boundary, { tag: "settings-section" },
    h("div", { className: "msettings" },
      h("div", { className: "msep" }, "总开关"),
      Row("启用记忆管理", "全局开关：关闭后不注入、工具拒绝、仅保留设置入口",
        Switch({ on: !!cfg.enabled, onChange: () => act("state.setEnabled", { v: !cfg.enabled }), label: "启用记忆管理" })),
      h("div", { className: "msep" }, "注入与工具"),
      Row("临时记忆模式", "开启后每次发送自动注入固定消息与勾选记忆",
        Switch({ on: cfg.mode === "on", onChange: () => act("state.setMode", { mode: cfg.mode === "on" ? "off" : "on" }), label: "临时记忆模式" })),
      Row("记忆注入视图（" + (cfg.view === "full" ? "全文" : "紧凑") + "）", "开启=注入完整快照；关闭=仅标题+印象+预览（模型可 memory_recall 读全文）",
        Switch({ on: cfg.view === "full", onChange: () => act("state.setView", { view: cfg.view === "full" ? "compact" : "full" }), label: "记忆注入视图" })),
      Row("Agent 记忆工具", "允许模型直接调用 memory_search / recall / save / pin",
        Switch({ on: !!cfg.modelTools, onChange: () => act("state.setModelTools", { v: !cfg.modelTools }), label: "Agent 记忆工具" })),
      h("div", { className: "msep" }, "记忆库"),
      Row("记忆库文件夹", "Markdown 记忆存放目录（front-matter 格式，Obsidian 兼容）",
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", { className: "minput", style: { width: 260 }, value: libPath, onChange: (e) => setLibPath(e.target.value), placeholder: "绝对路径" }),
          h(Btn, { sm: true, kind: "primary", onClick: () => act("state.setLibrary", { path: libPath }, "已保存记忆库路径") }, "保存"))),
      h("div", { className: "msep" }, "注入上限（字符）"),
      Row("单条 / 计划总量 / 固定消息", "三个输入框依次对应：每条记忆 / 计划总量 / 固定消息合计 的注入字符上限",
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", { className: "minput", style: { width: 80 }, title: "单条记忆上限（字符）", value: caps.memoryChars, onChange: (e) => setCaps({ ...caps, memoryChars: e.target.value }) }),
          h("input", { className: "minput", style: { width: 80 }, title: "计划总量上限（字符）", value: caps.totalChars, onChange: (e) => setCaps({ ...caps, totalChars: e.target.value }) }),
          h("input", { className: "minput", style: { width: 80 }, title: "固定消息总量上限（字符）", value: caps.pinChars, onChange: (e) => setCaps({ ...caps, pinChars: e.target.value }) }),
          h(Btn, { sm: true, kind: "primary", onClick: () => act("state.setCaps", { memoryChars: Number(caps.memoryChars), totalChars: Number(caps.totalChars), pinChars: Number(caps.pinChars) }, "已保存注入上限") }, "保存"))),
      err ? h("div", { className: "mstatus err" }, err) : null,
      ok ? h("div", { className: "mstatus ok" }, ok) : null));
}

// ---------------- 插件入口 ----------------
exports.apply = function (ctx) {
  try {
    installErrorCapture();
    ctx.effect(installStyles, "memory-manager: styles");
    const slots = ctx.get("slots") || ctx.slots;
    if (!slots) { log("warn", "apply", "slots unavailable"); return () => {}; }
    log("info", "apply", "client apply: slots ok");
    slots.inject("conversation.input.left", () => slots.register(
      { name: "conversation.input.left", id: "memory-panel-toggle", order: 10 },
      (props) => {
        const sid = props.sessionId ? String(props.sessionId) : null;
        return h("div", { style: { display: "inline-flex" } }, h(InputButton, { sessionId: sid }));
      },
    ));
    slots.inject("shell.overlay", () => slots.register(
      { name: "shell.overlay", id: "memory-panel", order: 30 },
      (props) => {
        const [, force] = useState(0);
        const tick = () => force((n) => n + 1);
        useEffect(() => {
          overlayListeners.push(tick);
          return () => { overlayListeners = overlayListeners.filter((l) => l !== tick); };
        }, []);
        return panel.open
          ? h(Boundary, { tag: "overlay-root", onCrash: () => { panel.crashed = true; }, onReset: () => { panel.tab = "plan"; panel.crashed = false; } },
            h(Panel, { onClose: () => { panel.open = false; notifyOverlay(); } }))
          : null;
      },
    ));
    slots.inject("settings.section", () => slots.register(
      { name: "settings.section", id: "memory-manager", order: 30, label: () => "记忆管理" },
      (props) => h(SettingsSection, {}),
    ));
    // 消息动作条：每条助手消息直接保存为记忆 / 固定（对话界面直接操作）
    slots.inject("conversation.chat.assistant-actions", () => slots.register(
      { name: "conversation.chat.assistant-actions", id: "memory-manager-message-actions", order: 15 },
      (props) => h(MessageActions, { messageId: props.messageId, sessionId: props.sessionId }),
    ));
    log("info", "apply", "slots registered: input-left / overlay / settings / assistant-actions");
    return () => {};
  } catch (e) {
    log("error", "apply", "client register failed: " + String((e && e.message) || e), { stack: e && e.stack });
    return () => {};
  }
};

return module.exports; } });
