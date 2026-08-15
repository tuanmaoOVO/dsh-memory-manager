window.__ModuleLoader__.load({ id: "@dsh-external/dsh-memory-manager", factory: (require) => {
"use strict";
var module = { exports: {} }; var exports = module.exports;

const React = require("react");
const { useState, useEffect, useRef, useCallback } = React;
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
// 当前所在的（正在对话的）会话 id：由 JumpReceiver（挂在当前显示会话的 header 动作位）渲染期同步。
// 「注入一次」等需要"所在会话"而非"打开面板时的会话"的操作使用它。
let currentSessionId = null;
let overlayListeners = [];
const notifyOverlay = () => { for (const l of [...overlayListeners]) { try { l() } catch { /* ignore */ } } };
// 左侧记忆图谱浮层：独立于右侧面板的开关状态（可两者并存、互不干扰）
const graph = { open: false };
let graphListeners = [];
const notifyGraph = () => { for (const l of [...graphListeners]) { try { l() } catch { /* ignore */ } } };

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
  ".mtag.conv{opacity:1;background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".mtag.auto{opacity:1;background:var(--dsw-alias-state-success-secondary,rgba(34,197,94,.16));color:var(--dsw-alias-state-success-primary,#22c55e)}",
  ".mtagrow{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}",
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
  ".mdlg>*{flex-shrink:0}",
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
  ".mcell.exp{height:auto;min-height:38px;align-items:flex-start;padding-top:8px;padding-bottom:8px;cursor:default}",
  ".mcell.exp .mcell-index{padding-top:2px}",
  ".mcell.exp .mcell-time{margin-top:2px}",
  ".mcell-more{flex:none;font-size:11px;color:var(--dsw-alias-state-business-primary,#4176e6);cursor:pointer;white-space:nowrap;user-select:none}",
  ".mcell.exp .mcell-more{align-self:center}",
  ".mcell-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}",
  ".mcell-text.clk{cursor:pointer}",
  ".mcell-text.wrap{white-space:pre-wrap;overflow:visible;text-overflow:clip;line-height:1.5;max-height:260px;overflow-y:auto}",
  ".mcell-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0aa);white-space:nowrap}",
  "/* ---- 对话定位高亮（由 JumpReceiver 添加/移除） ---- */",
  ".mem-jump-hl{outline:2px solid var(--dsw-alias-state-business-primary,rgba(65,118,230,.9));outline-offset:-2px;border-radius:8px;transition:outline-color .2s}",
  ".mkind{display:inline-flex;align-items:center;flex:none;box-sizing:border-box;height:22px;padding:0 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap}",
  ".mkind.user{color:var(--dsw-alias-state-success-primary,#22c55e);background:var(--dsw-alias-state-success-tertiary,rgba(34,197,94,.12))}",
  ".mkind.assistant{color:#6d9bff;background:rgba(96,132,253,.13)}",
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
  "/* ---- 消息页会话选择器（跨工作区分组） ---- */",
  ".msess-selector{display:flex;flex-direction:column;gap:6px;padding:2px 0 6px}",
  ".msess-row{display:flex;gap:8px;align-items:center}",
  ".msess-sel{width:100%;box-sizing:border-box;height:34px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.25));color:var(--dsw-alias-label-primary,inherit);padding:0 8px;font-size:13px;font-family:inherit}",
  ".msess-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#8ab0ff)}",
  ".msess-opt-group{font-weight:600;color:var(--dsw-alias-label-secondary,#9aa0aa);font-size:12px}",
  ".msess-arch{color:var(--dsw-alias-state-warn-label,#dd8629);font-size:11px;flex:none;white-space:nowrap}",
  "/* ---- 输入栏记忆按钮 ---- */",
  ".mem-input-btn{display:inline-flex;align-items:center;gap:5px;cursor:pointer;background:none;border:none;color:inherit;font-size:12px;padding:4px 8px;border-radius:14px;height:28px}",
  ".mem-input-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
  ".mem-input-btn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}",
  "/* ---- 左侧记忆图谱浮层（镜像右侧 .mem-wrap 到 left，可与之并存） ---- */",
  ".mem-wrap-left{position:fixed;left:0;top:0;bottom:0;width:560px;max-width:92vw;background:var(--dsw-alias-bg-layer-1,#1e1f24);color:var(--dsw-alias-label-primary,#e8e8ea);border-right:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));z-index:1001;display:flex;flex-direction:column;font-family:var(--dsw-font-family,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:13px;box-shadow:8px 0 28px rgba(0,0,0,.35)}",
  ".mem-wrap-left .mem-head{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}",
  ".mg-toolbar{display:flex;gap:6px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none;flex-wrap:wrap}",
  ".mg-search{flex:1;min-width:140px}",
  ".mg-modes{display:flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:14px;padding:2px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18))}",
  ".mg-mode{border:0;padding:4px 10px;border-radius:11px;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(232,232,234,.6));font-size:12px;cursor:pointer;line-height:16px;font-family:inherit}",
  ".mg-mode:hover{color:var(--dsw-alias-label-primary,#e8e8ea)}",
  ".mg-mode.on{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
  ".mg-canvas{flex:1;min-height:0;position:relative;overflow:hidden}",
  ".mg-canvas svg{display:block;width:100%;height:100%}",
  ".mg-node{cursor:pointer}",
  ".mg-node.focus{cursor:pointer}",
  ".mg-edge.links{stroke:var(--dsw-alias-border-l2,rgba(232,232,234,.45))}",
  ".mg-edge.composedOf{stroke:var(--dsw-alias-state-business-primary,#6d9bff);stroke-dasharray:6 4;stroke-width:2}",
  ".mg-edge.backlinks{stroke:var(--dsw-alias-border-l1,rgba(232,232,234,.22));stroke-width:1}",
  ".mg-tooltip{position:fixed;pointer-events:none;z-index:1200;max-width:260px;background:var(--dsw-alias-bg-layer-2,#26272d);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;padding:8px 10px;box-shadow:0 6px 20px rgba(0,0,0,.35);font-size:12px;line-height:1.5;white-space:normal}",
  ".mg-tooltip .t{font-weight:600;margin-bottom:3px;word-break:break-all}",
  ".mg-tooltip .imp{color:var(--dsw-alias-label-secondary,#9aa0aa);word-break:break-all}",
  ".mg-legend{display:flex;flex-direction:column;gap:4px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa)}",
  ".mg-legend-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}",
  ".mg-legend .lg-item{display:inline-flex;align-items:center;gap:5px;margin-right:10px;white-space:nowrap}",
  ".mg-legend .lg-dot{width:10px;height:10px;border-radius:50%;flex:none}",
  ".mg-legend .lg-line{display:inline-block;width:16px;height:0;flex:none;border-top-width:2px;border-top-style:solid}",
  ".mg-hit-hint{font-size:11px;color:var(--dsw-alias-state-warn-label,#dd8629);padding:2px 0}",
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

/** 记忆 tags 徽标集合：convention 用蓝色「规约」，其余标签普通样式；自动换行不撑破卡片布局 */
const TagBadges = (tags) => (tags || [])
  .filter((t) => t && String(t).trim() !== "")
  .map((t, i) => t === "convention"
    ? h("span", { key: "c" + i, className: "mtag conv", title: "规约记忆：新会话默认自动注入（启用状态下）" }, "规约")
    : h("span", { key: i, className: "mtag", title: "标签: " + String(t) }, String(t)));
const tagList = (tags) => (tags || []).filter((t) => t && String(t).trim() !== "");

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
  const [tags, setTags] = useState("");
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
      tags: tags.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), notes, links: linkIds ? linkIds.split(",").map((s) => s.trim()).filter(Boolean) : [],
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
      Field({ label: "标签（可选，逗号分隔；convention=规约记忆）", value: tags, onChange: setTags, placeholder: "如: convention, 架构" }),
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

// ---------------- 会话总结对话框（消息页「会话总结」入口） ----------------
// 选择会话 → 范围（全部 / 最近 N 轮）→ 智能合并开关 → 生成（调用 session.summarize）→ 预览 → 自动入库。
// 生成总是自动保存到记忆库（内部逐条 memory_save），本对话框负责预览与完成确认。
function SummarizeDialog(props) {
  const [sessId, setSessId] = useState(props.defaultSessionId || panel.sessionId || "");
  const [workspaces, setWorkspaces] = useState([]);
  const [range, setRange] = useState("all");
  const [recentN, setRecentN] = useState("20");
  const [merge, setMerge] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | generating | preview
  const [list, setList] = useState([]);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  useEffect(() => {
    let alive = true;
    loadWorkspaces().then((d) => { if (alive) setWorkspaces(d || []); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const gen = async () => {
    if (!sessId) { setErr("请先选择会话"); return; }
    setPhase("generating"); setErr(""); setOk("");
    const recent = range === "recent" ? (Number(recentN) || 20) : 0;
    const r = await call("session.summarize", { sessionId: sessId, recent, merge }, sessId);
    setPhase("preview");
    if (r.error) { setErr(r.error); setList([]); setOk(""); return; }
    const items = r.summaries || [];
    setList(items);
    setOk("已生成 " + items.length + " 条会话总结并自动保存到记忆库（tags 含「会话总结」，新会话默认自动注入最近 N 条）");
  };
  const sessSel = h("select", { className: "msess-sel", value: sessId || "", onChange: (e) => setSessId(e.target.value) },
    h("option", { key: "__none", value: "" }, "— 选择会话 —"),
    (workspaces || []).map((w) => w ? h("optgroup", { key: w.id || "w" + Math.random(), label: w.title || "(未命名工作区)" },
      (w.sessions || []).map((s) => s ? h("option", { key: s.id, value: s.id },
        String(s.title || s.id) + (s.archived ? "（已归档）" : "")) : null)) : null));
  return h("div", { className: "mdlayer", onClick: props.onClose },
    h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
      h("div", { style: { fontWeight: 600, fontSize: 14 } }, "会话总结"),
      h("div", { className: "mstatus" }, "把所选会话的对话轮次交给 LLM 提炼为「会话id / 轮次 / 用户请求 / 思考链 / 处理链 / 结果」六要素记忆；生成即自动存入记忆库，并默认参与新会话自动注入（按更新时间最近 8 条）。生成失败（如 LLM 不可用）会在此明确提示，不会写入记忆。"),
      h("label", { className: "mfield" },
        h("span", { className: "mfield-label" }, "目标会话"),
        sessSel),
      h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
        ["all", "recent"].map((m) => h("label", { key: m, style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
          h("input", { type: "radio", checked: range === m, onChange: () => setRange(m) }),
          m === "all" ? "全部轮次" : "最近 N 轮"))),
      range === "recent" ? h("label", { className: "mfield", key: "n" },
        h("span", { className: "mfield-label" }, "最近轮数 N"),
        h("input", { className: "minput", value: recentN, onChange: (e) => setRecentN(e.target.value), placeholder: "如 20" })) : null,
      h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "4px 0" } },
        h("span", { className: "mstatus", style: { flex: 1 } }, "智能合并：LLM 判断哪些连续轮次处理同一事务，同类合并为一条总结（其余仍每轮一条）"),
        Switch({ on: merge, onChange: () => setMerge(!merge), label: "智能合并" })),
      err ? h("div", { className: "mstatus err" }, err) : null,
      ok ? h("div", { className: "mstatus ok" }, ok) : null,
      phase === "generating" ? h("div", { className: "mstatus" }, h("span", { className: "mspin" }), " 正在总结（LLM 处理中，轮次较多时可能较慢）…") : null,
      phase === "preview" ? [
        h("div", { key: "sep", className: "msep" }, "生成结果（已自动保存到记忆库）"),
        list.length === 0 ? h("div", { key: "e", className: "mstatus" }, "未生成任何总结") :
          list.map((s, i) => s ? h("div", { key: s.id || i, className: "mcard", style: { marginBottom: 6 } },
            h("div", { className: "mstatus" }, "#" + (i + 1) + " · " + (s.title || s.id) + (s.sourceSeqs && s.sourceSeqs.length ? " · 源消息 " + s.sourceSeqs.length + " 处" : "") + " · " + (s.tags || []).join("、")),
            h("div", { className: "mtext", style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: .85 } }, String(s.snapshot || "").slice(0, 400)),
            s.notes ? h("div", { className: "meta", title: String(s.notes) }, String(s.notes).slice(0, 220)) : null
          ) : null)
      ] : null,
      h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
        h(Btn, { onClick: props.onClose }, "完成"),
        h(Btn, { kind: "primary", onClick: gen, disabled: phase === "generating" }, phase === "generating" ? "生成中…" : "生成并保存"))));
}

// ---------------- 编辑对话框 ----------------
function EditDialog(props) {
  const meta = props.meta || {}; // 容错：调用方可能传不完整对象
  const [title, setTitle] = useState(meta.title || "");
  const [imp, setImp] = useState((meta.impressions || []).join("、"));
  const [tags, setTags] = useState((meta.tags || []).join("、"));
  const [enabled, setEnabled] = useState(meta.enabled !== false);
  const [links, setLinks] = useState((meta.links || []).join(", "));
  const [notes, setNotes] = useState(props.notes || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [armDel, setArmDel] = useState(false);
  const tagsRef = useRef(null);
  useEffect(() => {
    if (props.focusTags && tagsRef.current) { try { tagsRef.current.focus(); tagsRef.current.select(); } catch { /* ignore */ } }
  }, []);
  useEffect(() => {
    if (!armDel) return;
    const t = setTimeout(() => setArmDel(false), 4000);
    return () => clearTimeout(t);
  }, [armDel]);
  const save = async () => {
    setBusy(true); setErr("");
    const r = await call("memory.update", {
      id: meta.id,
      patch: { title, impressions: imp.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), tags: tags.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean), enabled, links: links.split(",").map((s) => s.trim()).filter(Boolean), notes },
    });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone();
  };
  const del = async () => {
    if (!armDel) { setArmDel(true); return; }
    setBusy(true); setErr("");
    const r = await call("memory.delete", { id: meta.id });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    props.onDone();
  };
  return h("div", { className: "mdlayer", onClick: props.onClose },
    h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
      h("div", { style: { fontWeight: 600, fontSize: 14 } }, "编辑记忆 · " + meta.id),
      h("div", { className: "mstatus" },
        "组合来源: " + ((meta.composedOf || []).join(", ") || "无") + " · 被引用: " + ((meta.backlinks || []).join(", ") || "无")),
      Field({ label: "标题", value: title, onChange: setTitle }),
      Field({ label: "印象", value: imp, onChange: setImp }),
      h("label", { className: "mfield" },
        h("span", { className: "mfield-label" }, "标签（逗号分隔，convention=规约记忆，新会话默认自动注入）"),
        h("input", { ref: tagsRef, className: "minput", value: tags, onChange: (e) => setTags(e.target.value), placeholder: "如: convention" })),
      h("div", { className: "mfield" },
        h("span", { className: "mfield-label" }, "启用注入（禁用后不参与自动注入、不能加入计划）"),
        Switch({ on: enabled, onChange: () => setEnabled(!enabled), label: "启用注入" })),
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
    h("div", { key: "intro", className: "mcard" },
      h("div", { className: "msetting-name" }, "注入计划"),
      h("div", { className: "msetting-desc" }, "全局注入计划 = 下方「固定消息」+「勾选记忆」，所有会话共享同一份计划。开启「临时记忆模式」后，每次发送都会把它们注入模型上下文（" + (cfg.mode === "on" ? "当前已开启" : "当前未开启") + "）；本页可随时查看、添加与移除。")),
    h("div", { key: "mode", className: "mcard" },
      h("div", { className: "msetting-row" },
        h("div", { className: "grow" },
          h("div", { className: "msetting-name" }, "临时记忆模式"),
          h("div", { className: "msetting-desc" }, cfg.mode === "on" ? "已开启：每轮发送自动注入下方固定消息与勾选记忆" : "已关闭：不自动注入；需要时可临时用「仅本次发送注入」")),
        Switch({ on: cfg.mode === "on", onChange: () => setMode(cfg.mode === "on" ? "off" : "on"), label: "临时记忆模式" })),
      h("div", { key: "once", className: "msetting-row", style: { marginTop: 8 } },
        h("div", { className: "grow" },
          h("div", { className: "msetting-name" }, "仅本次发送注入"),
          h("div", { className: "msetting-desc" }, (plan && plan.injectOnce) === true ? "已开启：下一次发送时注入一次固定消息+勾选记忆，随后自动关闭" : (cfg.mode === "on" ? "临时记忆模式已开启，无需单独使用" : "开启后仅下一次发送注入固定消息+勾选记忆，随后自动关闭"))),
        Switch({ on: (plan && plan.injectOnce) === true, onChange: () => injectOnce(!((plan && plan.injectOnce) === true)), label: "仅本次发送注入", disabled: cfg.mode === "on" }))),
    h("div", { key: "view", className: "msetting-row" },
      h("div", { className: "grow" },
        h("div", { className: "msetting-name" }, "勾选记忆注入格式（" + (cfg.view === "full" ? "全文" : "紧凑") + "）"),
        h("div", { className: "msetting-desc" }, "控制下方「勾选记忆」注入模型时的格式：开启=完整快照（信息全、占字符多）；关闭=仅标题+印象+300字预览（省上下文，需要细节时模型可调 memory_recall 读全文）")),
      Switch({ on: cfg.view === "full", onChange: () => setView(cfg.view === "full" ? "compact" : "full"), label: "勾选记忆注入格式" })),
    h("div", { key: "tools", className: "msetting-row" },
      h("div", { className: "grow" },
        h("div", { className: "msetting-name" }, "Agent 记忆工具"),
        h("div", { className: "msetting-desc" }, "允许模型直接调用 memory_search / recall / save / pin")),
      Switch({ on: !!cfg.modelTools, onChange: () => setModelTools(!cfg.modelTools), label: "Agent 记忆工具" })),
    h("div", { key: "pins", className: "msep" }, "固定消息（" + (plan.pinned || []).length + " · 每轮注入）"),
    (plan.pinned || []).length === 0 ? Empty("暂无固定消息：在对话中点击消息下方的 📌 图标即可固定") :
      (plan.pinned || []).map((p) => p ? h("div", { key: p.id, className: "mrow" },
        h("span", { className: "mtag" }, p.role || "msg"),
        h("span", { className: "grow mtext", title: p.text }, p.text),
        h(Btn, { sm: true, kind: "outline", onClick: () => unpin(p.id) }, "取消固定")) : null),
    h("div", { key: "mems", className: "msep" }, "勾选记忆（" + (plan.memories || []).length + " · 每轮注入）"),
    (plan.memories || []).length === 0 ? Empty("暂无勾选记忆：到「记忆库」点「加入计划」，或由新会话自动注入规约记忆") :
      (plan.memories || []).map((m) => m ? h("div", { key: m.id, className: "mrow" },
        (m.tags || []).includes("convention") ? h("span", { className: "mtag conv", title: "规约记忆：新会话默认自动注入（启用状态下）" }, "规约") : null,
        (m.tags || []).includes("会话总结") ? h("span", { className: "mtag auto", title: "会话总结记忆：新会话默认自动注入（按更新时间最近 8 条；可随时手动移除或重新加入）" }, "自动") : null,
        h("span", { className: "grow mtext", title: m.title }, m.title),
        h("span", { className: "meta" }, (m.impressions || []).join("、")),
        h(Btn, { sm: true, kind: "outline", onClick: () => rmMem(m.id) }, "移除")) : null),
    h("div", { key: "excl", className: "msep" }, "已排除的轮次（" + (plan.excluded || []).length + " · 不注入模型，点击恢复）"),
    (plan.excluded || []).length === 0 ? Empty("无排除：到「消息」页点轮次头的「排除」按钮（不删除消息，随时可恢复）") :
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
  const [traceMsg, setTraceMsg] = useState("");
  const [onceTip, setOnceTip] = useState("");
  const mems = props.memories || [];
  const planMemIds = new Set((props.planMemories || []).map((m) => String(m.id)));
  const q = search.trim().toLowerCase();
  const shown = q ? mems.filter((m) => m && (
    (m.title || "").toLowerCase().includes(q) ||
    (m.impressions || []).some((i) => i && i.toLowerCase().includes(q)) ||
    (m.id || "").toLowerCase().includes(q))) : mems;
  const toggleSel = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const addPlan = async (id) => { const r = await call("plan.addMemory", { id }); if (!r.error) props.refresh(); };
  const setEnabled = async (id, v) => { const r = await call("memory.setEnabled", { id, enabled: v }); if (!r.error) props.refresh(); };
  // 一次性注入：当前所在会话的下一次请求注入该记忆（不入全局计划），注入后自动清除
  const injectOnce = async (id, title) => {
    const sid = currentSessionId || panel.sessionId;
    if (!sid) {
      setOnceTip("无法确定当前会话：请先打开任意会话对话页再点击「注入一次」");
      setTimeout(() => setOnceTip(""), 5000);
      return;
    }
    const r = await call("plan.injectOnceMemory", { id }, sid);
    setOnceTip(r.error ? ("注入失败: " + r.error) : ("已加入一次性注入：当前会话下一次发送时注入「" + (title || id) + "」（不入计划）"));
    setTimeout(() => setOnceTip(""), 4000);
  };
  // 直接注入：立即把记忆插入当前所在会话的对话流（模型下一次响应必然基于它，无需等待新消息）
  const injectNow = async (id, title) => {
    const sid = currentSessionId || panel.sessionId;
    if (!sid) {
      setOnceTip("无法确定当前会话：请先打开任意会话对话页再点击「直接注入」");
      setTimeout(() => setOnceTip(""), 5000);
      return;
    }
    const r = await call("session.injectNow", { id }, sid);
    setOnceTip(r.error ? ("直接注入失败: " + r.error) : ("已直接注入当前会话：记忆「" + (title || id) + "」已进入对话上下文"));
    setTimeout(() => setOnceTip(""), 5000);
  };
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
  const openEdit = async (id, focusTags) => {
    setBusy(true);
    const r = await call("memory.read", { id });
    setBusy(false);
    if (r.error) return;
    setEdit({ meta: r.meta, notes: r.notes, snapshot: r.snapshot, focusTags: !!focusTags });
  };
  // 记忆级追溯：把源会话与其消息 seq 交给消息页（切页 + 选中源会话 + 滚动到该行）
  // 工作区可达性提醒：跨工作区会话可正常打开（DSH 客户端会话列表含全部工作区），
  // 但左侧分组高亮不自动切换，故给出明确提示；归档会话无取消归档界面，同样提示。
  const doTrace = async (meta) => {
    const src = meta && meta.sourceSession;
    const seqs = (meta && Array.isArray(meta.sourceSeqs)) ? meta.sourceSeqs : [];
    if (!src) { setTraceMsg("该记忆无来源会话，无法定位到消息"); return; }
    if (!seqs.length) { setTraceMsg("该记忆未保存源消息位置（旧记忆可能缺少 sourceSeqs）"); return; }
    setTraceMsg("");
    let hint = "";
    try {
      const ws = await loadWorkspaces(true);
      const w = workspaceOfSession(ws || [], src);
      const curW = workspaceOfSession(ws || [], panel.sessionId);
      if (w) {
        const sp = (w.sessions || []).find((s) => s && String(s.id) === String(src));
        if (sp && sp.archived) hint = "该会话已归档：仍可在对话中定位，但不会出现在左侧工作区分组中";
        else if (!curW || String(curW.id) !== String(w.id)) hint = "该会话属于工作区「" + (w.title || "(未命名)") + "」，将在对话中打开该会话（左侧工作区高亮不会自动切换）";
      } else {
        hint = "目标会话不在当前可列举工作区中，将尽力在对话中定位";
      }
    } catch (e) { hint = ""; }
    if (props.onTraceToMsg) props.onTraceToMsg({ sessionId: src, seq: seqs[0], hint });
  };
  return h(Boundary, { tag: "library-tab" },
    h("div", null, [
      h("div", { key: "bar", style: { display: "flex", gap: 6 } },
        h("input", { className: "minput", placeholder: "按印象 / 标题 / id 搜索…", value: search, onChange: (e) => setSearch(e.target.value) }),
        h(Btn, { kind: "ghost", onClick: () => props.refresh(), title: "重新扫描记忆库" }, "刷新")),
      h("div", { key: "compose", style: { display: "flex", gap: 6, alignItems: "center", marginTop: 2 } },
        h("span", { className: "mstatus" }, selected.length ? "已选 " + selected.length + " 条" : "「加入计划」= 加入全局注入计划（开启临时记忆模式后每轮注入，可在「计划」页管理）；勾选多条可组合为新记忆（源记忆保留）"),
        selected.length >= 2 ? h(Btn, { kind: "primary", sm: true, onClick: () => setComposeOpen(true) }, "组合为新记忆") : null,
        selected.length ? h(Btn, { sm: true, kind: "ghost", onClick: () => setSelected([]) }, "清空") : null),
      busy ? h("div", { key: "busy", className: "mstatus" }, h("span", { className: "mspin" }), " 读取中…") : null,
      onceTip ? h("div", { key: "once", className: "mstatus ok" }, onceTip) : null,
      shown.length === 0 ? Empty("记忆库为空：在对话中点消息下方的 💾 图标保存为记忆") :
        shown.map((m) => m ? h("div", { key: m.id, className: "mcard" },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("input", { type: "checkbox", checked: selected.includes(m.id), onChange: () => toggleSel(m.id), title: "勾选用于组合" }),
            h("span", { style: { flex: 1, cursor: "pointer", fontWeight: 500, fontSize: 13 }, onClick: () => openDetail(m.id), title: "查看详情" }, m.title || m.id),
            (() => {
              const inPlan = planMemIds.has(String(m.id));
              const disabled = m.enabled === false || inPlan;
              const title = m.enabled === false ? "该记忆已禁用，先启用再加入计划" :
                (inPlan ? "已加入全局注入计划：开启「临时记忆模式」后每轮注入模型上下文；可在「计划」页移除" :
                  "加入全局注入计划：开启「临时记忆模式」后每轮自动注入模型上下文，可在「计划」页管理");
              return h(Btn, { sm: true, kind: inPlan ? "ghost" : "outline", onClick: () => addPlan(m.id), disabled, title },
                inPlan ? "✓ 已在计划中" : "加入计划");
            })(),
            h(Btn, { sm: true, kind: "ghost", onClick: () => openEdit(m.id, true), title: "快捷编辑标签(逗号分隔)" }, "打标签"),
            h(Btn, { sm: true, kind: "ghost", onClick: () => openEdit(m.id) }, "编辑"),
            h(Btn, { sm: true, kind: "ghost", onClick: () => injectOnce(m.id, m.title), title: "注入一次：下一次请求在当前会话注入该记忆（不入计划）" }, "注入一次"),
            h(Btn, { sm: true, kind: "ghost", onClick: () => injectNow(m.id, m.title), title: "直接注入：立即把记忆插入当前会话对话流（无需等待新消息）" }, "直接注入"),
            Switch({ on: m.enabled !== false, onChange: () => setEnabled(m.id, m.enabled === false), label: "启用注入" })),
          tagList(m.tags).length ? h("div", { className: "mtagrow" }, TagBadges(tagList(m.tags))) : null,
          h("div", { className: "mimpr", style: { marginTop: 3 } }, "印象: " + ((m.impressions || []).join("、") || "—") + (m.enabled === false ? " · 已禁用" : "")),
          h("div", { className: "meta" },
            m.id + (m.composedOf && m.composedOf.length ? " · 组合自 " + m.composedOf.join(", ") : "") +
            (m.links && m.links.length ? " · 链接 " + m.links.join(", ") : "") +
            (m.backlinks && m.backlinks.length ? " · 被引用 " + m.backlinks.join(", ") : ""))) : null),
      composeOpen ? h(Boundary, { key: "compose", tag: "compose-dialog", onReset: () => setComposeOpen(false) },
        h(ComposeDialog, { ids: selected, onClose: () => setComposeOpen(false), onDone: () => { setComposeOpen(false); setSelected([]); props.refresh(); } })) : null,
      edit ? h(Boundary, { key: "edit", tag: "edit-dialog", onReset: () => setEdit(null) },
        h(EditDialog, { meta: edit.meta, notes: edit.notes || "", snapshot: edit.snapshot || "", focusTags: edit.focusTags, onClose: () => setEdit(null), onDone: () => { setEdit(null); props.refresh(); } })) : null,
      detail ? h(Boundary, { key: "detail", tag: "detail-dialog", onReset: () => setDetail(null) },
        h("div", { className: "mdlayer", onClick: () => setDetail(null) },
          h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
            h("div", { style: { fontWeight: 600, fontSize: 14 } }, (detail.meta && (detail.meta.title || detail.meta.id)) || ""),
            h("div", { className: "mstatus" }, "id: " + detail.meta.id + " · 来源会话: " + (detail.meta.sourceSession || "无")),
            h("div", { className: "mstatus" }, "印象: " + ((detail.meta.impressions || []).join("、") || "无")),
            h("div", { className: "mstatus", style: { display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" } },
              "组合自: " + (((detail.meta.composedOf || []).length === 0) ? "无" :
                (detail.meta.composedOf || []).map((cid) =>
                  h("span", { key: cid, className: "mtag", style: { cursor: "pointer" }, title: "查看源记忆 " + cid,
                    onClick: (e) => { e.stopPropagation(); openDetail(cid); } }, cid)))),
            h("div", { className: "mstatus" }, "链接: " + ((detail.meta.links || []).join(", ") || "无") + " · 被引用: " + ((detail.meta.backlinks || []).join(", ") || "无")),
            h("div", { style: { display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap" } },
              h(Btn, { sm: true, kind: "outline", onClick: () => setFull(!full) }, full ? "收起快照" : "展开快照"),
              (detail.meta && detail.meta.sourceSession && Array.isArray(detail.meta.sourceSeqs) && detail.meta.sourceSeqs.length)
                ? h(Btn, { sm: true, kind: "primary", onClick: () => doTrace(detail.meta), title: "切换到消息页，选中源会话并定位到对应消息" }, "消息位置")
                : null,
              h(Btn, { sm: true, kind: "ghost", onClick: () => { setDetail(null); setEdit({ meta: detail.meta, notes: detail.notes, snapshot: detail.snapshot }); } }, "编辑")),
            traceMsg ? h("div", { className: "mstatus" }, traceMsg) : null,
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

// ---------------- 消息行（memo 化：展开/收起只重渲染受影响的行，避免长列表全量重渲染卡顿） ----------------
// 纯函数与辅助组件提升到模块级，保证 props 引用稳定使 React.memo 生效
const fmtTime = (t) => {
  if (!t) return "";
  try {
    const d = new Date(Number(t));
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
    if (sameDay) return hms;
    const md = [d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, "0")).join("-");
    if (d.getFullYear() === now.getFullYear()) return md + " " + hms;
    return String(d.getFullYear()) + "-" + md + " " + hms;
  } catch { return ""; }
};
const kindClass = (k) => (k === "user" ? "user" : (k === "tool" ? "tool" : "assistant"));
const kindLabel = (k) => (k === "user" ? "用户" : (k === "tool" ? "工具" : "助手"));
const MCell = React.memo(function MCell(props) {
  const { n, ni, turnId, excluded, selected, onToggleSel, onShowFull, sessId } = props;
  return h("div", { "data-mem-seq": String(n.seq), className: "mcell" + (excluded ? " excl" : "") + (selected ? " sel" : "") },
    h("input", { type: "checkbox", checked: selected, onChange: () => onToggleSel(n.id), title: "勾选此消息" }),
    h("span", { className: "mcell-index" }, String(ni + 1)),
    h("span", { className: "mkind " + kindClass(n.kind) }, kindLabel(n.kind)),
    h("span", { className: "mcell-text clk", title: n.preview || "", onClick: () => { onShowFull(n); } },
      n.preview || (n.kind === "tool" ? "（工具调用，无文本）" : (n.kind === "assistant" ? "（助手回复，无文本）" : "（无文本）"))),
    h(IconBtn, { key: "jump", title: "在对话中定位此消息", onClick: () => jumpTo(sessId || panel.sessionId, turnId, n.seq) }, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M6 3.5 11.5 8 6 12.5" }))),
    h("span", { className: "mcell-time" }, fmtTime(n.time)));
});

// ---------------- 消息页（轨迹风格：sticky 轮次头 + 步骤行卡片，参考 DSH trajectory） ----------------
function MessagesTab(props) {
  // ---- 会话选择：自身管理选中会话并独立加载（跨工作区）----
  const [sessId, setSessId] = useState(panel.sessionId || "");
  const [turns, setTurns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [wsErr, setWsErr] = useState("");
  const [sel, setSel] = useState([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const okTimer = useRef(0);
  // 会话选择器数据（sessions.list 跨工作区）；仅在消息页可见时会话渲染后拉取
  useEffect(() => {
    let alive = true;
    loadWorkspaces().then((d) => { if (alive) setWorkspaces(d || []); }).catch(() => { if (alive) setWsErr("会话列表加载失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 选中会话变化 → 加载该会话轮次；未选择（空串）不加载任何数据
  useEffect(() => {
    setSel([]);
    if (!sessId) { setTurns([]); setLoading(false); return; }
    setLoading(true); setErr("");
    let alive = true;
    call("session.messages", { limit: 80 }, sessId).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.error) { setErr(r.error); setTurns([]); }
      else { setErr(""); setTurns(r.turns || []); }
    }).catch(() => { if (alive) { setLoading(false); setErr("加载失败"); } });
    return () => { alive = false; };
  }, [sessId]);
  // 记忆库追溯导航：选中目标会话 → 加载后滚动到对应 seq 行（含工作区提醒）
  useEffect(() => {
    const nav = props.navTarget;
    if (!nav) return;
    const { sessionId: nid, seq, hint } = nav;
    if (String(nid) !== String(sessId)) {
      // 目标会话与当前选择不同：先切选择器（其自身 effect 会加载目标会话），
      // 待 sessId 变化后本 effect 重跑进入同会话分支完成滚动
      setSessId(String(nid));
      return;
    }
    if (hint) { setOk(hint); clearTimeout(okTimer.current); okTimer.current = setTimeout(() => setOk(""), 4000); }
    if (seq != null) {
      const el = document.querySelector('[data-mem-seq="' + Number(seq) + '"]');
      if (el instanceof HTMLElement) {
        try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* ignore */ }
        el.classList.add("mem-jump-hl");
        setTimeout(() => { try { el.classList.remove("mem-jump-hl"); } catch { /* ignore */ } }, 2600);
      } else if (!loading) {
        setOk("未能定位到消息行（消息可能较旧或被压缩），已展示该会话消息");
        clearTimeout(okTimer.current);
        okTimer.current = setTimeout(() => setOk(""), 4000);
      }
    }
    if (props.clearNav) props.clearNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.navTarget, sessId, turns, loading]);
  const toggle = (id) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const reload = () => { if (sessId) { setLoading(true); setErr(""); call("session.messages", { limit: 80 }, sessId).then((r) => { setLoading(false); if (r.error) { setErr(r.error); setTurns([]); } else { setErr(""); setTurns(r.turns || []); } }); } };
  const excl = async (turnId, exclude) => {
    const r = await call("plan.excludeTurn", { turnId, exclude }, sessId);
    if (r.error) { setOk(""); setErr(r.error); return; }
    setErr("");
    setOk(exclude ? "已排除该轮：不再注入模型，点「恢复」可随时还原" : "已恢复该轮：重新参与对话并注入模型上下文");
    clearTimeout(okTimer.current);
    okTimer.current = setTimeout(() => setOk(""), 3000);
    reload();
  };
  const pin = async (ids, v) => { const r = await call("session.pin", { messageIds: ids, pin: v }, sessId); if (!r.error) reload(); };
  const turnStart = (t) => (t.nodes || []).find((n) => n && n.time);
  // 完整消息查看（弹窗展示，避免就地展开造成列表高度重排）
  const [fullMsg, setFullMsg] = useState(null);
  const wsOpts = h("select", {
    key: "sel", className: "msess-sel", value: sessId || "", onChange: (e) => setSessId(e.target.value),
    disabled: loading,
  },
    h("option", { key: "__none", value: "" }, "— 选择会话（未选择不加载）—"),
    (workspaces || []).map((w) => w ? h("optgroup", { key: w.id || "w" + Math.random(), label: (w.title || "(未命名工作区)") }, [
      (w.sessions || []).map((s) => s ? h("option", { key: s.id, value: s.id },
        String(s.title || s.id) + (s.archived ? "（已归档）" : "")) : null),
    ].filter(Boolean)) : null).filter(Boolean));
  return h(Boundary, { tag: "messages-tab" },
    h("div", null, [
      h("div", { key: "bar", style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
        h("span", { className: "mstatus" }, "勾选消息 → 保存为记忆 / 固定；轮次头右侧「排除」= 该轮不再注入模型（不删除消息，可随时恢复）"),
        h(Btn, { sm: true, kind: "outline", onClick: () => setSumOpen(true), title: "把会话的对话轮次交给 LLM 总结为「会话总结」记忆（可智能合并同一事务的连续轮次；生成即自动入库）" }, "会话总结"),
        h(Btn, { sm: true, kind: "ghost", onClick: reload, disabled: loading }, "刷新")),
      h("div", { key: "sess", className: "msess-selector" },
        h("div", { className: "msess-row" },
          wsOpts,
          wsErr ? h("span", { className: "msess-arch" }, wsErr) : null)),
      h("div", { key: "acts", style: { display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap", minHeight: 34, alignItems: "center" } },
        sel.length ? [
          h(Btn, { key: "s", kind: "primary", sm: true, onClick: () => setSaveOpen(true) }, "保存为记忆（" + sel.length + "）"),
          h(Btn, { key: "p", sm: true, kind: "outline", onClick: () => pin(sel, true), title: "固定为临时记忆，模式开启时自动注入" }, "固定所选"),
          h(Btn, { key: "u", sm: true, kind: "ghost", onClick: () => pin(sel, false) }, "取消固定所选"),
          h(Btn, { key: "c", sm: true, kind: "ghost", onClick: () => setSel([]) }, "清空"),
        ] : h("span", { key: "hint", className: "mstatus" }, "（消息级勾选）")),
      err ? h("div", { key: "err", className: "mstatus err" }, err) : null,
      ok ? h("div", { key: "ok", className: "mstatus ok" }, ok) : null,
      loading ? h("div", { key: "load", className: "mstatus" }, h("span", { className: "mspin" }), " 加载会话消息…") : null,
      !sessId ? Empty("选择上方会话以查看其消息（未选择时不会加载数据）") :
        (turns.length === 0 && !loading ? Empty("暂无消息") : null),
      (turns || []).map((t, ti) => t ? h("div", { key: t.turnId, className: "mturn" },
        h("div", { className: "mturn-head", title: "轮次 id: " + String(t.turnId) },
          h("span", { className: "mturn-title" }, (t.marker ? "🚫 已排除 · " : "") + "轮次 " + (ti + 1)),
          h("span", { className: "mturn-meta" }, (t.nodes || []).length + " 条消息" + (turnStart(t) ? " · " + fmtTime(turnStart(t).time) : "")),
          h(IconBtn, { key: "jump", title: "在对话中定位该轮首条消息", onClick: () => jumpTo(sessId || panel.sessionId, t.turnId, turnStart(t) ? turnStart(t).seq : null) }, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M6 3.5 11.5 8 6 12.5" }))),
          t.excluded
            ? h(Btn, { sm: true, kind: "outline", onClick: () => excl(t.turnId, false), title: "恢复该轮：重新参与对话并注入模型上下文" }, "恢复")
            : (ti === (turns || []).length - 1
                ? h("span", { title: "最新一轮不能排除：其后需要保留至少一条真实用户消息作为对话锚点" },
                    h(Btn, { sm: true, kind: "ghost", disabled: true }, "排除"))
                : h(Btn, { sm: true, kind: "ghost", onClick: () => excl(t.turnId, true), title: "排除该轮：不再注入模型（不删除消息，可随时恢复）" }, "排除"))),
        h("div", { className: "mturn-body" },
          (t.nodes || []).map((n, ni) => n ? h(MCell, { key: n.seq, n, ni, turnId: t.turnId, excluded: t.excluded, selected: sel.includes(n.id), onToggleSel: toggle, onShowFull: setFullMsg, sessId: sessId || panel.sessionId }) : null))) : null),
      saveOpen ? h(Boundary, { key: "save", tag: "save-dialog", onReset: () => setSaveOpen(false) },
        h(SaveDialog, { sessionId: sessId || panel.sessionId, messageIds: sel, planMemories: (props.planMemories || []), onClose: () => setSaveOpen(false), onDone: () => { setSaveOpen(false); setSel([]); reload(); } })) : null,
      sumOpen ? h(Boundary, { key: "sum", tag: "summarize-dialog", onReset: () => setSumOpen(false) },
        h(SummarizeDialog, { defaultSessionId: sessId, onClose: () => setSumOpen(false), onDone: () => { setSumOpen(false); props.refresh(); } })) : null,
      fullMsg ? h(Boundary, { key: "full", tag: "full-msg-dialog", onReset: () => setFullMsg(null) },
        h("div", { className: "mdlayer", onClick: () => setFullMsg(null) },
          h("div", { className: "mdlg", onClick: (e) => e.stopPropagation(), style: { width: 560, maxWidth: "94vw" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("span", { className: "mkind " + kindClass(fullMsg.kind) }, kindLabel(fullMsg.kind)),
              h("span", { className: "mstatus", style: { flex: 1 } }, "消息 #" + String(fullMsg.seq) + " · " + fmtTime(fullMsg.time)),
              h(Btn, { sm: true, kind: "ghost", onClick: () => setFullMsg(null) }, "关闭")),
            h("pre", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "62vh", overflow: "auto", fontSize: 12, lineHeight: 1.6, background: "var(--dsw-alias-bg-base,rgba(0,0,0,.2))", padding: 10, borderRadius: 8, margin: "10px 0 0", userSelect: "text" } },
              (fullMsg.text || fullMsg.preview || "（无文本内容）").slice(0, 50000) + ((fullMsg.text || "").length > 50000 ? "\n…（内容过长已截断，完整内容请到源会话查看）" : ""))))) : null,
    ]));
}

// ---------------- 记忆图谱（独立左侧浮层面板：语义分层全景 + 焦点探索） ----------------
// 节点类型与颜色（沿用 .mtag 的 --dsw-alias 色系）：convention=蓝、会话总结=绿、复盘=橙、其他=灰
function memType(m) {
  const tags = m && Array.isArray(m.tags) ? m.tags : [];
  if (tags.indexOf("convention") !== -1) return "convention";
  if (tags.indexOf("会话总结") !== -1) return "sum";
  if (tags.indexOf("复盘") !== -1) return "review";
  return "other";
}
const memTypeColor = {
  convention: "var(--dsw-alias-state-business-primary,#4176e6)",
  sum: "var(--dsw-alias-state-success-primary,#22c55e)",
  review: "var(--dsw-alias-state-warn-label,#dd8629)",
  other: "var(--dsw-alias-border-l2,rgba(232,232,234,.5))",
};
const memTypeName = { convention: "规约", sum: "会话总结", review: "复盘", other: "其他" };

// 焦点邻域：以 focusId 为中心做 1-2 跳遍历（links + composedOf + backlinks），返回去重列表
function graphNeighborhood(mems, focusId) {
  const byId = new Map();
  for (const m of (mems || [])) if (m && m.id) byId.set(String(m.id), m);
  const nbr = (m) => {
    const out = new Set();
    for (const k of ["links", "composedOf"]) {
      const arr = m[k];
      if (Array.isArray(arr)) for (const lid of arr) { const t = byId.get(String(lid)); if (t) out.add(t); }
    }
    if (Array.isArray(m.backlinks)) for (const bid of m.backlinks) { const t = byId.get(String(bid)); if (t) out.add(t); }
    return out;
  };
  const focus = byId.get(String(focusId));
  const result = new Map();
  if (focus) {
    result.set(focus.id, focus);
    const h1 = nbr(focus);
    for (const nb of h1) result.set(nb.id, nb);
    for (const nb of h1) for (const nb2 of nbr(nb)) result.set(nb2.id, nb2);
  }
  return Array.from(result.values());
}

// 收集节点间的三类边：links=主动关联、composedOf=组合来源、backlinks=被引用
function graphEdges(nodes, ids) {
  const edges = [];
  for (const m of nodes) {
    if (!m) continue;
    if (Array.isArray(m.links)) for (const lid of m.links) if (ids.has(String(lid))) edges.push({ s: m.id, t: String(lid), k: "links" });
    if (Array.isArray(m.composedOf)) for (const cid of m.composedOf) if (ids.has(String(cid))) edges.push({ s: m.id, t: String(cid), k: "composedOf" });
    if (Array.isArray(m.backlinks)) for (const bid of m.backlinks) if (ids.has(String(bid))) edges.push({ s: m.id, t: String(bid), k: "backlinks" });
  }
  return edges;
}

// 焦点模式径向确定性布局：焦点居中、1 跳内圈、2 跳外圈（位置可复现，切换焦点画面不乱动）
function radialLayout(mems, focusId, W, H, o) {
  const byId = new Map();
  for (const m of (mems || [])) if (m && m.id) byId.set(String(m.id), m);
  const focus = byId.get(String(focusId));
  if (!focus) return null;
  const nbr = (m) => {
    const out = new Set();
    for (const k of ["links", "composedOf"]) {
      const arr = m[k];
      if (Array.isArray(arr)) for (const lid of arr) { const t = byId.get(String(lid)); if (t) out.add(t); }
    }
    if (Array.isArray(m.backlinks)) for (const bid of m.backlinks) { const t = byId.get(String(bid)); if (t) out.add(t); }
    return out;
  };
  const h1 = Array.from(nbr(focus));
  const h1set = new Set(h1.map((m) => String(m.id)));
  const h2set = new Set();
  const h2 = [];
  for (const m of h1) for (const nb of nbr(m)) {
    const id = String(nb.id);
    if (id === String(focus.id) || h1set.has(id) || h2set.has(id)) continue;
    h2set.add(id); h2.push(nb);
  }
  const R1 = Math.min(W, H) * 0.28, R2 = Math.min(W, H) * 0.52;
  const mk = (m, x, y, r, isFocus) => ({
    id: String(m.id), mem: m, title: String(m.title || m.id), type: memType(m),
    x: Math.round(x + W / 2), y: Math.round(y + H / 2), r, isFocus,
    degree: (Array.isArray(m.links) ? m.links.length : 0) + (Array.isArray(m.backlinks) ? m.backlinks.length : 0),
    hit: !!(o.hitIds && o.hitIds.has(String(m.id))),
  });
  const nodes = [mk(focus, 0, 0, 16, true)];
  h1.forEach((m, i) => { const a = (2 * Math.PI * i) / Math.max(1, h1.length); nodes.push(mk(m, Math.cos(a) * R1, Math.sin(a) * R1, 10, false)); });
  h2.forEach((m, i) => { const a = (2 * Math.PI * i) / Math.max(1, h2.length); nodes.push(mk(m, Math.cos(a) * R2, Math.sin(a) * R2, 8, false)); });
  const ids = new Set(nodes.map((nd) => nd.id));
  return { nodes, edges: graphEdges(nodes.map((nd) => nd.mem), ids) };
}

// 力导向布局（复用原 graphLayout 思路，扩展三类边；视图尺寸自适应传入 W/H）
function graphLayout(mems, opt) {
  const o = opt || {};
  const W = o.width || 820, H = o.height || 560;
  const maxNodes = (typeof o.maxNodes === "number") ? o.maxNodes : 60;
  // 焦点模式：径向确定性布局（焦点在中心、1-2 跳同心圆），直接返回带坐标结果
  if (o.focusId) {
    const rl = radialLayout(mems, o.focusId, W, H, o);
    if (rl) return rl;
  }
  // 全景：memory 已按 updatedAt 降序，取最新 N 条
  let nodes = (mems || []).filter(Boolean);
  // 检索命中优先：即使命中节点超出 N 条上限也纳入布局（保证“定位”能找到）
  if (o.hitIds && o.hitIds.size) {
    const inList = nodes.filter((m) => m && o.hitIds.has(String(m.id)));
    nodes = nodes.slice(0, maxNodes);
    const have = new Set(nodes.map((m) => m.id));
    for (const h of inList) if (!have.has(h.id)) nodes.push(h);
  } else {
    nodes = nodes.slice(0, maxNodes);
  }
  const ids = new Set(nodes.map((m) => m.id));
  const edges = graphEdges(nodes, ids);
  const n = nodes.length;
  if (!n) return { nodes: [], edges };
  const pos = new Map();
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(nd.id, { x: Math.cos(a) * (W * 0.28), y: Math.sin(a) * (H * 0.3), vx: 0, vy: 0 });
  });
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) || 0) + 1);
    degree.set(e.t, (degree.get(e.t) || 0) + 1);
  }
  // 组合边视作结构约束（当弹簧更紧，让组合来源更靠近）
  const springOf = (k) => (k === "composedOf" ? 0.05 : 0.03);
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
      const f = d * springOf(e.k);
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
    const isFocus = !!o.focusId && String(nd.id) === String(o.focusId);
    return {
      id: nd.id,
      mem: nd,
      title: String(nd.title || nd.id),
      type: memType(nd),
      x: Math.round(p.x + W / 2),
      y: Math.round(p.y + H / 2),
      r: isFocus ? 16 : 6 + Math.min(10, (degree.get(nd.id) || 0) * 3),
      degree: degree.get(nd.id) || 0,
      isFocus,
      hit: !!o.hitIds && o.hitIds.has(String(nd.id)),
    };
  });
  // 检索定位居中：命中仅 1 条时把该节点平移到画布中央（配合高亮/淡化给出明确“定位”反馈）
  if (o.centerOn) {
    const c = laid.find((nd) => String(nd.id) === String(o.centerOn));
    if (c) {
      const dx = W / 2 - c.x, dy = H / 2 - c.y;
      for (const nd of laid) { nd.x += dx; nd.y += dy; }
    }
  }
  return { nodes: laid, edges };
}
function nodePos(g, id) { const nd = g.nodes.find((x) => x.id === id); return nd ? { x: nd.x, y: nd.y } : null; }

// 记忆详情弹窗（从原 GraphTab 迁移；含快照/相关记忆/加入计划）
function GraphDetail(props) {
  const { detail, related, full, planMemIds, onClose, onToggleFull, onOpen, onRefresh } = props;
  if (!detail) return null;
  return h(Boundary, { tag: "graph-detail", onReset: onClose },
    h("div", { className: "mdlayer", onClick: onClose },
      h("div", { className: "mdlg", onClick: (e) => e.stopPropagation() },
        h("div", { style: { fontWeight: 600, fontSize: 14 } }, (detail.meta && (detail.meta.title || detail.meta.id)) || ""),
        h("div", { className: "mstatus" }, "id: " + detail.meta.id + " · 印象: " + ((detail.meta.impressions || []).join("、") || "无")),
        h("div", { className: "mstatus" }, "链接: " + ((detail.meta.links || []).join(", ") || "无") + " · 被引用: " + ((detail.meta.backlinks || []).join(", ") || "无")),
        h("div", { style: { display: "flex", gap: 6, margin: "4px 0" } },
          h(Btn, { sm: true, kind: "outline", onClick: onToggleFull }, full ? "收起快照" : "展开快照"),
          planMemIds.has(String(detail.meta.id))
            ? h(Btn, { sm: true, kind: "ghost", disabled: true, title: "已加入全局注入计划：开启「临时记忆模式」后每轮注入模型上下文；可在「计划」页移除" }, "✓ 已在计划中")
            : h(Btn, { sm: true, kind: "primary", onClick: async () => { const r = await call("plan.addMemory", { id: detail.meta.id }); if (!r.error) onRefresh(); }, title: "加入全局注入计划：开启「临时记忆模式」后每轮自动注入模型上下文" }, "加入计划")),
        full ? h("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11, opacity: .85, maxHeight: 240, overflow: "auto", background: "var(--dsw-alias-bg-base,rgba(0,0,0,.2))", padding: 8, borderRadius: 6 } }, String(detail.snapshot || "")) : null,
        h("div", { className: "msep" }, "相关记忆（链式回忆 · 点击跳转）"),
        (related || []).length === 0 ? h("div", { className: "mstatus" }, "无关联记忆") :
          (related || []).map((r) => r ? h("div", { key: r.id, className: "mrow" },
            h("span", { className: "mtag" }, "d" + r.distance),
            h("span", { className: "grow mtext", style: { cursor: "pointer" }, title: r.id, onClick: () => onOpen(r.id) }, r.title || r.id),
            h("span", { className: "meta" }, (r.impressions || []).join("、"))) : null))));
}

// 左侧记忆图谱浮层主组件（独立加载 memory 数据，不依赖右侧面板状态）
function GraphPanel(props) {
  const [mode, setMode] = useState("full");          // full=语义分层全景 / focus=焦点探索
  const [focusId, setFocusId] = useState(null);
  const [search, setSearch] = useState("");
  const [mems, setMems] = useState([]);
  const [planMemIds, setPlanMemIds] = useState(new Set());
  const [detail, setDetail] = useState(null);
  const [related, setRelated] = useState([]);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tip, setTip] = useState(null);              // { x, y, mem } 悬浮 tooltip（屏幕坐标）
  const [hitIds, setHitIds] = useState(null);        // 搜索命中集合（null=未搜索）
  const [hitHint, setHitHint] = useState("");        // 检索反馈（未命中提示）
  const [vp, setVp] = useState({ s: 1, x: 0, y: 0 }); // 视口：scale + 平移（滚轮缩放、空白拖拽）
  const dragRef = useRef(null);                      // { startX, startY, vpX, vpY, moved }
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setBusy(true); setErr("");
    const [st, lr] = await Promise.all([
      call("library.scan", {}, panel.sessionId),
      call("state.get", {}, panel.sessionId),
    ]);
    if (seq !== seqRef.current) return;
    setBusy(false);
    if (lr.error) setErr(lr.error);
    setPlanMemIds(new Set((lr.plan && Array.isArray(lr.plan.memories) ? lr.plan.memories : []).map((m) => String(m.id))));
    if (st.error) { setErr(st.error); return; }
    setMems(st.memories || []);
  }, []);

  useEffect(() => { refresh(); return () => { seqRef.current++; }; }, [refresh]);

  const openDetail = async (id) => {
    setBusy(true);
    const [r, rr] = await Promise.all([
      call("memory.read", { id }),
      call("memory.related", { id, depth: 2, limit: 20 }),
    ]);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setDetail(r);
    setRelated(rr.error ? [] : (rr.related || []));
    setFull(false);
    setTip(null);
  };

  const q = search.trim().toLowerCase();
  const doSearch = () => {
    if (!q) { setHitIds(null); setHitHint(""); return; }
    const hs = new Set();
    for (const m of (mems || [])) {
      if (!m) continue;
      if ((m.title || "").toLowerCase().includes(q) ||
          (m.impressions || []).some((i) => i && i.toLowerCase().includes(q)) ||
          (m.id || "").toLowerCase().includes(q)) hs.add(String(m.id));
    }
    setHitIds(hs);
    setHitHint(hs.size === 0 ? "未命中任何记忆，试试其他关键词" : "命中 " + hs.size + " 条，已在画布高亮并居中");
    // 命中时重置视口，确保命中节点（布局居中）回到可视区
    if (hs.size > 0) setVp({ s: 1, x: 0, y: 0 });
  };

  // 画布视口：用容器实际像素采样（渲染后测量一次写入 state，SVG 视口随容器自适应）
  const layRef = useRef(null);
  const [vw, setVw] = useState(820);
  const [vh, setVh] = useState(560);
  useEffect(() => {
    const el = layRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r && r.width > 80 && r.height > 80) { setVw(r.width); setVh(r.height); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitIds, mode, focusId]);

  // 滚轮缩放（围绕鼠标位置；原生监听保证 preventDefault 有效）
  useEffect(() => {
    const el = layRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      setVp((v) => {
        const ns = Math.max(0.3, Math.min(4, v.s * (e.deltaY < 0 ? 1.12 : 0.89)));
        return { s: ns, x: px - (px - v.x) * (ns / v.s), y: py - (py - v.y) * (ns / v.s) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 空白区拖拽平移（节点上按下不启动拖拽，保留点击）
  const onPointerDown = (e) => {
    if (e.target && e.target.closest && e.target.closest(".mg-node")) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, vpX: vp.x, vpY: vp.y, moved: false };
    if (e.currentTarget.setPointerCapture) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setVp((v) => ({ ...v, x: d.vpX + dx, y: d.vpY + dy }));
  };
  const onPointerUp = () => { dragRef.current = null; };

  let g = null;
  try {
    g = graphLayout(mems, {
      width: vw, height: vh, focusId: (mode === "focus" ? focusId : null),
      hitIds: hitIds || undefined,
      centerOn: (hitIds && hitIds.size === 1) ? Array.from(hitIds)[0] : undefined,
      maxNodes: mode === "focus" ? 200 : 60, // 焦点邻域通常小；全景保留 60 节点上限（最新 N 条，library.scan 已按 updatedAt 降序）
    });
  } catch (e) { log("error", "graph-layout", String((e && e.message) || e), { stack: e && e.stack }); g = { nodes: [], edges: [] }; }

  const onNodeClick = (nd) => {
    if (dragRef.current && dragRef.current.moved) return; // 拖拽结束不误触节点点击
    if (mode === "focus") {
      if (nd.isFocus) { openDetail(nd.id); return; } // 点焦点本身 → 看详情
      setFocusId(nd.id); setHitIds(null); setHitHint(""); return; // 点邻域 → 切换焦点
    }
    openDetail(nd.id);
  };

  const showTip = (nd, e) => {
    if (dragRef.current && dragRef.current.moved) return; // 拖拽中不弹 tooltip
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top - 8, mem: nd.mem || { id: nd.id, title: nd.title } });
  };

  return h(Boundary, { tag: "graph-panel", onCrash: props.onCrash, onReset: props.onCrash },
    h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
      h("div", { className: "mem-head" },
        h("span", { className: "mem-title" }, "记忆图谱"),
        h("span", { className: "mstate" }, (mode === "focus" ? "焦点：" + (focusId ? String(focusId).slice(-8) : "未选择") : "全景 · " + mems.length + " 条记忆")),
        h(Btn, { sm: true, kind: "ghost", onClick: refresh, title: "重新扫描记忆库" }, "刷新"),
        h(Btn, { sm: true, kind: "ghost", onClick: () => { graph.open = false; notifyGraph(); }, title: "关闭图谱浮层" }, "✕")),
      h("div", { className: "mg-toolbar" },
        h("input", { className: "minput mg-search", placeholder: "按标题 / 印象 / id 搜索定位…", value: search, onChange: (e) => setSearch(e.target.value) }),
        h(Btn, { sm: true, kind: "outline", onClick: doSearch }, "定位"),
        h(Btn, { sm: true, kind: "ghost", onClick: () => setVp({ s: 1, x: 0, y: 0 }), title: "重置缩放与位置（滚轮缩放，拖拽空白区平移）" }, "重置视图"),
        h("div", { className: "mg-modes" },
          h("button", { type: "button", className: "mg-mode" + (mode === "full" ? " on" : ""), onClick: () => setMode("full") }, "全景"),
          h("button", { type: "button", className: "mg-mode" + (mode === "focus" ? " on" : ""), onClick: () => setMode("focus") }, "焦点"))),
      (hitHint ? h("div", { className: "mg-hit-hint", style: { padding: "2px 14px" } }, hitHint) : null),
      err ? h("div", { className: "mstatus err", style: { padding: "2px 14px" } }, err) : null,
      busy ? h("div", { className: "mstatus", style: { padding: "2px 14px" } }, h("span", { className: "mspin" }), " 读取中…") : null,
      h("div", { className: "mg-canvas", ref: layRef, onPointerDown, onPointerMove, onPointerUp, style: { cursor: "grab", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" } },
        mems.length === 0 ? Empty("记忆库为空：在对话中点消息下方的 💾 图标保存为记忆") :
          h("svg", { key: "gcanvas", viewBox: "-40 -40 " + (vw + 80) + " " + (vh + 80), preserveAspectRatio: "xMidYMid meet", style: { width: "100%", height: "100%", background: "var(--dsw-alias-bg-base,rgba(0,0,0,.18))" } },
            h("rect", { x: -40, y: -40, width: vw + 80, height: vh + 80, fill: "transparent" }),
            h("g", { transform: "translate(" + vp.x + "," + vp.y + ") scale(" + vp.s + ")" },
              (g.edges || []).map((e) => {
                const p1 = nodePos(g, e.s), p2 = nodePos(g, e.t);
                return (p1 && p2) ? h("line", { key: e.s + "|" + e.t + "|" + e.k, className: "mg-edge " + e.k, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, strokeWidth: e.k === "composedOf" ? 2 : (e.k === "links" ? 1.5 : 1) }) : null;
              }),
              (g.nodes || []).map((nd) =>
                h("g", { key: nd.id, className: "mg-node" + (nd.isFocus ? " focus" : ""), transform: "translate(" + nd.x + "," + nd.y + ")", opacity: (nd.hit || !hitIds) ? 1 : 0.35, onClick: () => onNodeClick(nd), onMouseMove: (e) => showTip(nd, e), onMouseLeave: () => setTip(null) },
                  h("circle", { r: nd.r, fill: memTypeColor[nd.type] || memTypeColor.other, fillOpacity: 0.9, stroke: nd.hit ? "var(--dsw-alias-state-warn-label,#ffb020)" : (nd.isFocus ? "var(--dsw-alias-label-primary,#fff)" : "none"), strokeWidth: nd.hit ? 3 : (nd.isFocus ? 2.5 : 0) }),
                  h("text", { y: -nd.r - 4, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary,#c8d2e8)", fontSize: nd.isFocus ? 12 : 10 }, String(nd.title).slice(0, nd.isFocus ? 18 : 13)))))),
        tip ? h("div", { key: "tip", className: "mg-tooltip", style: { left: tip.x + "px", top: (tip.y + 12) + "px" } },
          h("div", { className: "t" }, (tip.mem && (tip.mem.title || tip.mem.id)) || ""),
          h("div", { style: { display: "flex", gap: 5, alignItems: "center", margin: "2px 0" } },
            h("span", { className: "mtag", style: { background: memTypeColor[tip.mem && memType(tip.mem)] || memTypeColor.other, color: "#fff" } }, memTypeName[tip.mem && memType(tip.mem)] || "其他"),
            (tip.mem && tip.mem.id) ? h("span", { className: "meta" }, "#" + String(tip.mem.id).slice(-10)) : null),
          h("div", { className: "imp" }, ((tip.mem && tip.mem.impressions) || []).join("、") || "（无印象）"),
          h("div", { className: "meta" }, "关联 " + ((tip.mem && tip.mem.links) || []).length + " / 被引 " + ((tip.mem && tip.mem.backlinks) || []).length)) : null),
      h("div", { className: "mg-legend" },
        h("div", { className: "mg-legend-row" },
          h("span", { className: "lg-item" }, h("span", { className: "lg-dot", style: { background: memTypeColor.convention } }), "规约"),
          h("span", { className: "lg-item" }, h("span", { className: "lg-dot", style: { background: memTypeColor.sum } }), "会话总结"),
          h("span", { className: "lg-item" }, h("span", { className: "lg-dot", style: { background: memTypeColor.review } }), "复盘"),
          h("span", { className: "lg-item" }, h("span", { className: "lg-dot", style: { background: memTypeColor.other } }), "其他")),
        h("div", { className: "mg-legend-row" },
          h("span", { className: "lg-item" }, h("span", { className: "lg-line", style: { borderColor: "var(--dsw-alias-border-l2,rgba(232,232,234,.6))", borderTopStyle: "solid" } }), "主动关联 links"),
          h("span", { className: "lg-item" }, h("span", { className: "lg-line", style: { borderColor: "var(--dsw-alias-state-business-primary,#6d9bff)", borderTopStyle: "dashed" } }), "组合来源 composedOf"),
          h("span", { className: "lg-item" }, h("span", { className: "lg-line", style: { borderColor: "var(--dsw-alias-border-l2,rgba(232,232,234,.35))", borderTopStyle: "solid" } }), "被引用 backlinks")),
        mode === "focus"
          ? h("div", { className: "mg-hit-hint" }, "焦点模式：点击邻域节点可切换焦点 · 点击当前焦点（大节点）查看详情" + (focusId ? " · 当前焦点 #" + String(focusId).slice(-8) : "（未选择焦点，当前显示全景；点任意节点即聚焦）"))
          : null),
      detail ? h(GraphDetail, { key: "detail", detail, related, full, planMemIds, onClose: () => setDetail(null), onToggleFull: () => setFull(!full), onOpen: openDetail, onRefresh: refresh }) : null));
}

// ---------------- 主面板 ----------------
function Panel(props) {
  const [cfg, setCfg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [mems, setMems] = useState([]);
  const [tab, setTab] = useState(panel.tab);
  const [err, setErr] = useState("");
  const [libOpen, setLibOpen] = useState(false);
  const [libPath, setLibPath] = useState("");
  const seqRef = useRef(0);
  const [jumpMsg, setJumpMsg] = useState(null);
  // 记忆库追溯 → 消息页：{ sessionId, seq, hint }；每次导航生成新对象触发 MessagesTab 消费
  const [msgNav, setMsgNav] = useState(null);
  useEffect(() => {
    jumpFeedback.set = (fb) => setJumpMsg(fb);
    return () => { jumpFeedback.set = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    const seq = ++seqRef.current;
    const st = await call("state.get", {}, panel.sessionId);
    if (seq !== seqRef.current) return;
    if (st.error) { setErr(st.error); return; }
    setErr("");
    setCfg(st.config);
    setPlan(st.plan);
    if (st.config && st.config.enabled) {
      const ls = await call("library.scan", {}, panel.sessionId);
      if (seq !== seqRef.current) return;
      if (!ls.error) setMems(ls.memories || []);
    }
  };
  useEffect(() => {
    log("info", "panel", "panel mounted, tab=" + tab + ", session=" + String(panel.sessionId).slice(-10));
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => { panel.open = false; props.onClose(); };
  // 右侧面板头部「图谱」按钮：切换左侧图谱浮层（独立开关，与右侧面板并存互不干扰）
  const toggleGraph = () => { graph.open = !graph.open; notifyGraph(); };
  const switchTab = (t) => {
    panel.tab = t;
    setTab(t);
    log("info", "panel", "switch tab -> " + t);
    if (t === "messages" || t === "library") refresh();
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

  const onTraceToMsg = (target) => {
    // 记忆库追溯：切到消息页并下发目标会话/seq/hint（新对象，MessagesTab 消费后 clearNav）
    switchTab("messages");
    setMsgNav(target ? { ...target, ts: Date.now() } : null);
  };

  let content;
  if (!cfg) content = h("div", { className: "mstatus" }, h("span", { className: "mspin" }), " 加载中…");
  else if (cfg.enabled === false) content = h("div", { className: "mstatus" }, "记忆管理已禁用（设置 → 记忆管理 中开启）");
  else if (tab === "plan") content = h(Boundary, { tag: "plan-tab", onCrash, onReset: resetToPlan }, h(PlanTab, { config: cfg, plan, refresh }));
  else if (tab === "library") content = h(Boundary, { tag: "library-tab", onCrash, onReset: resetToPlan }, h(LibraryTab, { memories: mems, planMemories: plan ? plan.memories : [], refresh, onTraceToMsg }));
  else content = h(Boundary, { tag: "messages-tab", onCrash, onReset: resetToPlan }, h(MessagesTab, { planMemories: plan ? plan.memories : [], refresh, navTarget: msgNav, clearNav: () => setMsgNav(null) }));

  return h("div", { className: "mem-wrap" },
    h("div", { className: "mem-head" },
      h(Btn, { sm: true, kind: "ghost", onClick: close, title: "关闭面板" }, "✕"),
      h("span", { className: "mem-title" }, "记忆管理"),
      h("span", { className: "mstate " + (cfgMode === "on" ? "on" : ""), title: cfgMode === "on" ? "临时记忆模式已开启，每次发送自动注入固定消息与勾选记忆" : "临时记忆模式已关闭，不自动注入" },
        cfgMode === "on" ? "模式：已开启" : "模式：已关闭"),
      h("span", { className: "mem-sid", title: panel.sessionId || "" }, panel.sessionId ? "#" + String(panel.sessionId).slice(-10) : ""),
      h(Btn, { sm: true, kind: "ghost", onClick: () => setLibOpen(!libOpen), title: "设置记忆库文件夹路径" }, "记忆库"),
      h(Btn, { sm: true, kind: "ghost", onClick: toggleGraph, title: "打开左侧记忆图谱浮层（可与本面板同时打开）" }, "图谱")),
    libOpen ? h("div", { key: "librow", style: { padding: "8px 16px", borderBottom: "1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))", display: "flex", gap: 6 } },
      h("input", { className: "minput", placeholder: cfg && cfg.libraryPath ? cfg.libraryPath : "输入记忆库文件夹绝对路径", value: libPath, onChange: (e) => setLibPath(e.target.value) }),
      h(Btn, { sm: true, kind: "primary", onClick: setLibrary }, "设为记忆库")) : null,
    h("div", { className: "mem-tabs" },
      ["plan", "library", "messages"].map((t) =>
        h("button", { key: t, className: "mem-tab" + (tab === t ? " on" : ""), onClick: () => switchTab(t) },
          t === "plan" ? "计划" : (t === "library" ? "记忆库" : "消息")))),
    h("div", { className: "mem-body" },
      err ? h("div", { className: "mstatus err" }, err) : null,
      (jumpMsg && jumpMsg.msg) ? h("div", { className: "mstatus" + (jumpMsg.kind === "err" ? " err" : " ok") }, jumpMsg.msg) : null,
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


// ---------------- 对话定位（跳转接收器 + 触发入口） ----------------
// 依据（已核对 DSH 本地源码）：
//  - conversation 会话级槽位槽组件会收到 useSession/useSessions 与 sessionId；
//    chat 快照为 s.chat.order(键数组) + s.chat.nodes(Map<键, ChatNode>)，
//    ChatConversationViewNode.anchorSeq 即其锚定事件的原始 seq（与记忆面板节点 seq 同源）。
//  - 每个渲染的对话行 DOM 带 data-chat-anchor-key=<节点 key>，滚动容器为
//    [data-conversation-scroll]；定位 = 按 anchorSeq 匹配节点，取其 key 再滚动对应行。
//  - 会话切换：ctx.get('sessions').open(sessionId)（sessions 为 root 级 client service）。
//  - 归档：workspace 槽/服务无公开取消归档 API（ui-workspace README：已归档会话无查看/取消归档界面）；
//    归档仅从分组视图隐藏，会话仍留在 session.list，因此 sessions.open() 仍可尝试打开。
const jumpFeedback = { set: null }; // { set: React setter } 由 Panel 注册，用于回显跳转结果
const jumpState = { last: null };   // { sessionId, turnId, seq, ts } 供 debug/去抖
let JUMP_SERVICE = null;            // ctx 参考：client apply 时注入

// ---- 跨工作区会话列表缓存（sessions.list RPC）----
// 消息页会话选择器与记忆库追溯共用；带时间戳去抖，inflight 去重避免并发重复拉取。
const wsCache = { data: null, ts: 0, inflight: null };
async function loadWorkspaces(force) {
  const now = Date.now();
  if (!force && wsCache.data && now - wsCache.ts < 15000) return wsCache.data;
  if (wsCache.inflight) { try { return await wsCache.inflight } catch { /* fallthrough */ } }
  const p = call("sessions.list", {}).then((r) => {
    const data = (r && !r.error && Array.isArray(r.workspaces)) ? r.workspaces : [];
    wsCache.data = data; wsCache.ts = Date.now(); wsCache.inflight = null;
    return data;
  }).catch(() => { wsCache.inflight = null; return [] });
  wsCache.inflight = p;
  return p;
}
// 找到包含某会话的工作区（未找到返回 null）
function workspaceOfSession(workspaces, sessionId) {
  if (!Array.isArray(workspaces)) return null;
  for (const w of workspaces) {
    if (w && Array.isArray(w.sessions) && w.sessions.some((s) => s && String(s.id) === String(sessionId))) return w;
  }
  return null;
}

// ---- 消息页导航请求（记忆库追溯 → 消息页选中源会话 + 滚动到 seq）----
// 模块级占位，由 Panel 做 state 中转（避免跨组件闭包过期），不直接持久化会话数据。
function jumpTo(sessionId, turnId, seq) {
  // 面板记忆消息均来自当前打开会话；若目标会话非当前显示会话，先切换过去。
  const sid = sessionId || (panel.sessionId);
  const now = Date.now();
  if (jumpState.last && jumpState.last.sid === sid && jumpState.last.ts > now - 300) return; // 去抖
  jumpState.last = { sid, turnId, seq, ts: now };
  const say = (msg, kind) => {
    if (jumpFeedback.set) { try { jumpFeedback.set({ msg, kind: kind || "ok", at: now }) } catch { /* ignore */ } }
  };
  try {
    if (JUMP_SERVICE) {
      try { JUMP_SERVICE.open(sid); } catch (e) { /* 已归档/未知：记录后仍派发，接收端尽力滚动 */ }
    }
  } catch { /* ignore */ }
  // 关闭面板（shell.overlay 覆盖层），让用户看到主对话
  if (panel.open) { panel.open = false; notifyOverlay(); }
  try { log("info", "jump", "jumpTo dispatch before session=" + String(sid) + " turn=" + String(turnId || "") + " seq=" + String(seq)); } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent("dsh:memory:jump", { detail: { sessionId: sid, turnId: turnId || "", seq: seq != null ? Number(seq) : null } }));
    try { log("info", "jump", "jumpTo dispatch after ok session=" + String(sid) + " seq=" + String(seq != null ? Number(seq) : null)); } catch { /* ignore */ }
    say(turnId ? ("已定位到对话（轮次 " + turnId + "）") : "已在对话中定位（如未跳转请重试）");
  } catch (e) {
    try { log("warn", "jump", "jumpTo dispatch threw: " + String((e && e.message) || e)); } catch { /* ignore */ }
    say("定位失败：无法访问对话界面", "err");
  }
}

// 会话级隐藏接收器：挂在 conversation.session.header.actions（list / session 作用域）。
// 只在当前显示会话上渲染，收到匹配本会话的 jump 事件后，按 anchorSeq 找到对应节点，
// 滚动 [data-conversation-scroll] 容器到对应 [data-chat-anchor-key] 行并高亮。
function JumpReceiver(props) {
  // 渲染期合法调用 hook 缓存最新 chat 快照；事件回调只读 ref，绝不再调 hook。
  const chat = props.useSession ? props.useSession((s) => s && ({
    order: s.chat && s.chat.order,
    nodes: s.chat && s.chat.nodes,
    // hasMore / loadingOlder 是 ConversationSnapshot 顶层字段（不是 s.chat 内）
    hasMore: s.hasMore,
    loadingOlder: s.loadingOlder,
  })) : null;
  const chatRef = useRef(chat);
  chatRef.current = chat; // 每次渲染同步
  if (props.sessionId) currentSessionId = String(props.sessionId); // 同步当前所在会话
  useEffect(() => {
    try {
      log("info", "jump", "receiver mounted session=" + String(props.sessionId) + " useSession=" + (typeof props.useSession) + " useSessions=" + (typeof props.useSessions));
    } catch { /* ignore */ }
  });
  useEffect(() => {
    const onJump = (e) => {
      const detail = e && e.detail;
      if (!detail || String(detail.sessionId) !== String(props.sessionId)) { try { log("warn", "jump", "event ignored session=" + String(detail && detail.sessionId) + " my=" + String(props.sessionId)); } catch { /* ignore */ } return; } // 非本会话
      const seq = Number(detail.seq);
      try { log("info", "jump", "event session=" + String(detail.sessionId) + " my=" + String(props.sessionId) + " seq=" + String(seq)); } catch { /* ignore */ }
      // 迭代器：每一轮（含加载更早后重试）都基于最新 chatRef 重算 nodeKey 并尝试滚动
      const isTurnTail = (nd, k) => (nd && String(nd.kind || "") === "turn-tail") || (k && String(k).indexOf("turn-tail") !== -1);
      const computeNodeKey = () => {
        const snap = chatRef.current;
        const nodes = snap && snap.nodes, orderR = snap && snap.order;
        let nodeKey = null, minSeq = null, maxSeq = null;
        if (nodes && orderR) {
          for (const k of orderR) {
            const nd = nodes.get(k);
            if (!nd || typeof nd.anchorSeq !== "number") continue;
            if (minSeq === null || nd.anchorSeq < minSeq) minSeq = nd.anchorSeq;
            if (maxSeq === null || nd.anchorSeq > maxSeq) maxSeq = nd.anchorSeq;
          }
          // 1) 精确 anchorSeq 匹配（优先：某节点 anchorSeq 恰等于目标 seq）
          for (const k of orderR) { const nd = nodes.get(k); if (nd && Number(nd.anchorSeq) === seq) { nodeKey = k; break; } }
          // 2) 兜底：最近的上界 anchorSeq，优先选非 turn-tail 的轮主体（assistant/user/tool）行
          if (nodeKey === null && typeof seq === "number") {
            let best = null, tailBest = null;
            for (const k of orderR) {
              const nd = nodes.get(k);
              if (!nd || typeof nd.anchorSeq !== "number" || nd.anchorSeq > seq) continue;
              if (isTurnTail(nd, k)) {
                if (tailBest === null || nd.anchorSeq > tailBest.anchorSeq) tailBest = { key: k, anchorSeq: nd.anchorSeq };
                continue;
              }
              if (best === null || nd.anchorSeq > best.anchorSeq) best = { key: k, anchorSeq: nd.anchorSeq };
            }
            nodeKey = (best ? best.key : (tailBest ? tailBest.key : null));
          }
        }
        const hasMore = !!(snap && snap.hasMore);
        const loadingOlder = !!(snap && snap.loadingOlder);
        return { nodeKey, minSeq, maxSeq, hasMore, loadingOlder };
      };
      try {
        const s0 = computeNodeKey();
        log("info", "jump", "match nodeKey=" + String(s0.nodeKey) + " min=" + String(s0.minSeq) + " max=" + String(s0.maxSeq) + " hasMore=" + s0.hasMore + " loadingOlder=" + s0.loadingOlder);
        // ~当前快照范围：用于判断目标在投影外（更早）
        // eslint-disable-next-line no-unused-vars
        const _s0 = s0;
      } catch { /* ignore */ }
      const doScroll = () => {
        const scrollport = document.querySelector("[data-conversation-scroll]");
        const rows = scrollport ? scrollport.querySelectorAll("[data-chat-anchor-key]") : null;
        let nodeKey = null;
        try { nodeKey = computeNodeKey().nodeKey; } catch { nodeKey = null; }
        try { log("info", "jump", "scroll attempt scrollport=" + (!!scrollport) + " rows=" + (rows ? rows.length : "?") + " target=" + String(nodeKey)); } catch { /* ignore */ }
        if (!scrollport) return { ok: false };
        let row = null;
        if (nodeKey !== null && rows) {
          for (const r of rows) if (r instanceof HTMLElement && String(r.dataset.chatAnchorKey) === String(nodeKey)) { row = r; break; }
        }
        if (!(row instanceof HTMLElement)) return { ok: false, nodeKey };
        try {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.add("mem-jump-hl");
          setTimeout(() => { try { row.classList.remove("mem-jump-hl"); } catch { /* ignore */ } }, 2600);
          try { log("info", "jump", "scrolled ok"); } catch { /* ignore */ }
          return { ok: true, nodeKey };
        } catch (err2) { try { log("warn", "jump", "scroll threw: " + String((err2 && err2.message) || err2)); } catch { /* ignore */ } return { ok: false, nodeKey }; }
      };
      const clickLoadOlder = () => {
        // "加载更早" 只在 hasMore 时渲染，是 [data-chat-flow] 内首个 button（列内紧跟在 hint 之后）
        try {
          const flow = document.querySelector("[data-chat-flow]");
          if (!flow) return false;
          const btns = flow.querySelectorAll("button");
          if (btns.length === 0) return false;
          const btn = Array.from(btns).find((b) => b instanceof HTMLElement && !b.disabled && String((b.textContent || "")).indexOf("加载更早") !== -1)
            || Array.from(btns).find((b) => b instanceof HTMLElement && !b.disabled && String((b.textContent || "")).toLowerCase().indexOf("load earlier") !== -1)
            || (btns[0] instanceof HTMLElement && !btns[0].disabled ? btns[0] : null);
          if (!(btn instanceof HTMLElement)) return false;
          btn.click();
          return true;
        } catch { /* ignore */ return false; }
      };
      // 目标在快照范围内：保持现有逻辑（短重试）
      const range = computeNodeKey();
      const first = doScroll();
      if (first.ok) return;
      if (range.minSeq !== null && typeof seq === "number" && seq < range.minSeq) {
        // 目标更早，不在当前投影窗口 → 反复点击"加载更早"把窗口前移，再轮询定位
        try { log("info", "jump", "target outside snapshot min=" + String(range.minSeq) + " max=" + String(range.maxSeq) + " seq=" + String(seq) + " (older) — triggering load older"); } catch { /* ignore */ }
        clickLoadOlder();
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          const r = doScroll();
          if (r.ok) { clearInterval(timer); return; }
          const cur = computeNodeKey();
          if (cur.hasMore && !cur.loadingOlder && cur.minSeq !== null && seq < cur.minSeq) {
            clickLoadOlder();
          } else if (!cur.hasMore && !cur.loadingOlder && (cur.minSeq === null || seq < cur.minSeq)) {
            // 已无更多可加载，目标仍更早 → 降级：滚到顶 + 反馈
            clearInterval(timer);
            try {
              const sp = document.querySelector("[data-conversation-scroll]");
              if (sp) sp.scrollTop = 0;
            } catch { /* ignore */ }
            try { log("warn", "jump", "target unreachable: seq=" + String(seq) + " older than snapshot min=" + String(cur.minSeq) + " and hasMore=false — scrolled to top"); } catch { /* ignore */ }
            if (jumpFeedback.set) { try { jumpFeedback.set({ msg: "目标消息在较早位置，已滚动到对话顶部，请继续向上加载后重试", kind: "err", at: Date.now() }); } catch { /* ignore */ } }
            return;
          }
          if (tries >= 60) { // 500ms*60 ≈ 30s 上限（比 10s 更充裕，逐页加载早期大会话）
            clearInterval(timer);
            try { log("warn", "jump", "load-older poll exhausted (" + tries + ")"); } catch { /* ignore */ }
          }
        }, 500);
        return;
      }
      // 同范围但行未渲染（刚切换会话/布局未定）：短重试
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (doScroll().ok || tries >= 12) { clearInterval(timer); try { if (tries >= 12) log("warn", "jump", "retries exhausted (12), abort scroll"); } catch { /* ignore */ } }
      }, 150);
    };
    window.addEventListener("dsh:memory:jump", onJump);
    return () => window.removeEventListener("dsh:memory:jump", onJump);
  }, [props.sessionId]);
  // 无可见 UI（仅占位，避免撑开 header）
  return null;
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
      Row("临时记忆模式", "开启后每轮发送自动注入「计划」页中的固定消息与勾选记忆；关闭则不自动注入",
        Switch({ on: cfg.mode === "on", onChange: () => act("state.setMode", { mode: cfg.mode === "on" ? "off" : "on" }), label: "临时记忆模式" })),
      Row("记忆注入格式（" + (cfg.view === "full" ? "全文" : "紧凑") + "）", "控制「勾选记忆」注入模型时的格式：开启=完整快照（信息全、占字符多）；关闭=仅标题+印象+300字预览（省上下文，需要细节时模型可调 memory_recall 读全文）。注入哪些记忆由「计划」页的勾选记忆决定",
        Switch({ on: cfg.view === "full", onChange: () => act("state.setView", { view: cfg.view === "full" ? "compact" : "full" }), label: "记忆注入格式" })),
      Row("Agent 记忆工具", "允许模型直接调用 memory_search / recall / save / pin / set_enabled / session_inject",
        Switch({ on: !!cfg.modelTools, onChange: () => act("state.setModelTools", { v: !cfg.modelTools }), label: "Agent 记忆工具" })),
      Row("新会话自动注入规约/会话总结记忆", "开启后每个新会话默认常驻所有启用中的规约记忆（tags 含 convention）与最近 8 条会话总结记忆（tags 含 会话总结）；旧会话不自动注入，可在记忆库手动加入",
        Switch({ on: cfg.autoInjectConvention !== false, onChange: () => act("state.setAutoInject", { v: cfg.autoInjectConvention === false }), label: "新会话自动注入规约/会话总结记忆" })),
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
    try { JUMP_SERVICE = ctx.get("sessions") || null; } catch { JUMP_SERVICE = null; }
    log("info", "apply", "client apply: slots ok" + (JUMP_SERVICE ? " (sessions ok)" : " (sessions unavailable)"));
    // 对话定位接收器：挂到会话 header 动作位（list / session 作用域，隐藏渲染）。
    // 使用该子槽而不是 conversation.session / .header（两者均为 single，占用即替换整块内容）。
    slots.inject("conversation.session.header.actions", () => slots.register(
      { name: "conversation.session.header.actions", id: "memory-manager-jump-receiver", order: 1000 },
      (props) => h(JumpReceiver, { sessionId: props.sessionId, useSession: props.useSession, useSessions: props.useSessions }),
    ));
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
    // 左侧记忆图谱浮层：独立 overlay（与右侧面板并存、互不干扰，靠模块级 graph.open 驱动）
    slots.inject("shell.overlay", () => slots.register(
      { name: "shell.overlay", id: "memory-graph", order: 40 },
      (props) => {
        const [, force] = useState(0);
        const tick = () => force((n) => n + 1);
        useEffect(() => {
          graphListeners.push(tick);
          return () => { graphListeners = graphListeners.filter((l) => l !== tick); };
        }, []);
        return graph.open
          ? h(Boundary, { tag: "graph-overlay-root", onCrash: () => { graph.open = false; notifyGraph(); }, onReset: () => { graph.open = false; notifyGraph(); } },
            h("div", { className: "mem-wrap-left" },
              h(GraphPanel, { onCrash: () => { graph.open = false; notifyGraph(); } })))
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
    log("info", "apply", "slots registered: input-left / overlay(x2: panel+graph) / settings / assistant-actions");
    return () => {};
  } catch (e) {
    log("error", "apply", "client register failed: " + String((e && e.message) || e), { stack: e && e.stack });
    return () => {};
  }
};
return module.exports; } });
