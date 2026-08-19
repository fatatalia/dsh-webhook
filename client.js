/**
 * dsh-webhook — client 半部分（配置页，浏览器 bundle）
 *
 * 渲染 webhook hooks 表：每个 hook 一行（id / token / workspace / session / template），
 * 支持添加、删除、保存。数据经 Typert remote（getConfig/setConfig）读写，
 * 落盘 settings.yaml 的 webhook 段，保存后 host 侧 watch 热生效（无需重启）。
 */
window.__ModuleLoader__.load({
  id: "dsh-webhook",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

    const CONTRIBUTION = {
      package: "dsh-webhook",
      descriptors: [
        { id: "dsh-webhook#webhook/getConfig", service: "webhook", namespace: "webhook", method: "getConfig", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-webhook#WebhookConfig") },
        { id: "dsh-webhook#webhook/setConfig", service: "webhook", namespace: "webhook", method: "setConfig", invocation: { kind: "direct" }, parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-webhook#SetPayload") }], result: codec("dsh-webhook#SetResult") },
      ],
    };

    const inputStyle = { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", fontSize: 13 };
    const labelStyle = { flex: "0 0 110px", fontWeight: 500, fontSize: 13 };

    function Row({ label, children }) {
      return S.jsxs("div", { style: { margin: "6px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
        S.jsx("label", { style: labelStyle, children: label }),
        children,
      ] });
    }

    /** 单个 hook 编辑卡片。 */
    function HookCard({ id, hook, onPatch, onRemove }) {
      const [showToken, setShowToken] = React.useState(false);
      const set = (field, v) => onPatch(id, { ...hook, [field]: v });
      return S.jsxs("div", { style: { border: "1px solid var(--dsw-alias-divider, #ddd)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, background: "var(--dsw-alias-surface-2, transparent)" }, children: [
        S.jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }, children: [
          S.jsx("strong", { children: id }),
          S.jsx("button", { type: "button", onClick: () => onRemove(id), style: { padding: "2px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-state-error-primary, #c33)", color: "var(--dsw-alias-state-error-primary, #c33)", background: "transparent", cursor: "pointer", fontSize: 12 }, children: "删除" }),
        ] }),
        S.jsxs("div", { style: { margin: "6px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: labelStyle, children: "Token" }),
          S.jsx("input", { type: showToken ? "text" : "password", value: hook.token ?? "", onChange: (e) => set("token", e.target.value), style: inputStyle, placeholder: "Bearer token（必填）" }),
          S.jsx("button", { type: "button", onClick: () => setShowToken((v) => !v), style: { flex: "0 0 auto", padding: "3px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", background: "transparent", cursor: "pointer", fontSize: 12 }, children: showToken ? "隐藏" : "显示" }),
        ] }),
        S.jsx(Row, { label: "工作区", children: S.jsx("input", { value: hook.workspace ?? "", onChange: (e) => set("workspace", e.target.value), style: inputStyle, placeholder: "/Users/<you>/dsh/default" }) }),
        S.jsx(Row, { label: "会话 key", children: S.jsx("input", { value: hook.session ?? "", onChange: (e) => set("session", e.target.value), style: inputStyle, placeholder: "可选，默认用 hookId 派生固定会话" }) }),
        S.jsxs("div", { style: { margin: "6px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: labelStyle, children: "会话模式" }),
          S.jsx("select", { value: hook.sessionMode ?? "persistent", onChange: (e) => set("sessionMode", e.target.value), style: { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", fontSize: 13 }, children: [
            S.jsx("option", { value: "persistent", children: "固定会话（上下文延续）" }),
            S.jsx("option", { value: "new", children: "每次新会话（互不影响）" }),
          ] }),
          S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: "new 模式每次 hook 独立会话，防止上一条内容影响下一条；处理完自动归档" }),
        ] }),
        S.jsxs("div", { style: { margin: "6px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: labelStyle, children: "同步模式" }),
          S.jsx("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }, children: [
            S.jsx("input", { type: "checkbox", checked: hook.sync === true, onChange: (e) => set("sync", e.target.checked), style: { accentColor: "var(--dsw-alias-state-info-primary, #08f)", cursor: "pointer" } }),
            S.jsx("span", { children: "等待 agent 回复并随 HTTP 响应返回（200 {ok, reply}）" }),
          ] }),
        ] }),
        S.jsx("p", { style: { margin: "-2px 0 6px 120px", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: "勾选后 POST 会等待 agent 处理完（最长 120s）并返回回复文本，供音箱等交互场景；不勾则立即返回 202 异步入队（短信记账等场景）。" }),
        S.jsxs("div", { style: { margin: "6px 0", display: "flex", gap: 10 }, children: [
          S.jsx("label", { style: labelStyle, children: "模板" }),
          S.jsx("textarea", { value: hook.template ?? "", onChange: (e) => set("template", e.target.value), rows: 4, style: { ...inputStyle, fontFamily: "monospace", fontSize: 12 }, placeholder: "发给 agent 的消息模板，{{text}} 会被替换为短信内容" }),
        ] }),
        S.jsx("p", { style: { margin: "4px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: "入口：POST /webhook/" + id + "，Header: Authorization: Bearer <token>" }),
      ] });
    }

    function WebhookSection(props) {
      const { getConfig, setConfig } = props;
      const [cfg, setCfg] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [newId, setNewId] = React.useState("");

      React.useEffect(() => {
        let current = true;
        setLoading((prev) => prev || cfg === null);
        Promise.resolve().then(() => getConfig()).then((c) => {
          if (!current) return;
          setCfg(c || {});
          setLoading(false);
        }, () => { if (current) { setLoading(false); setError(true); } });
        return () => { current = false; };
      }, [getConfig]);

      if (loading) return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取 webhook 配置…" });
      if (error || !cfg) return S.jsxs("div", { children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "读取配置失败" }),
        S.jsx("button", { onClick: () => { setError(false); setLoading(true); setCfg(null); }, children: "重试" }),
      ] });

      const hooks = cfg.hooks || {};
      const patch = (id, hook) => setCfg((c) => ({ ...c, hooks: { ...(c.hooks || {}), [id]: hook } }));
      const remove = (id) => setCfg((c) => {
        const next = { ...(c.hooks || {}) };
        delete next[id];
        return { ...c, hooks: next };
      });
      const add = () => {
        const id = newId.trim();
        if (!id) return;
        if (hooks[id]) return;
        setCfg((c) => ({ ...c, hooks: { ...(c.hooks || {}), [id]: { token: "", workspace: "", session: "", template: "请处理这条短信并记账：\n{{text}}", sync: false } } }));
        setNewId("");
      };
      const save = () => {
        Promise.resolve().then(() => setConfig({ hooks })).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); }).catch((e) => console.error("webhook save failed", e));
      };

      return S.jsxs("div", { style: { maxWidth: 720, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" },
          children: "Webhook：外部 POST /webhook/<hookId>（Bearer token 认证）→ 消息入队 → 投递到固定会话。同一 hook 串行处理。默认异步（202 即回）；勾选同步模式则等待 agent 回复并返回（200 {ok, reply}）。典型场景：手机银行短信转发自动记账（异步）、音箱对话（同步）。" }),
        Object.keys(hooks).length === 0
          ? S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "还没有任何 webhook，先添加一个。" })
          : Object.keys(hooks).sort().map((id) => S.jsx(HookCard, { key: id, id, hook: hooks[id], onPatch: patch, onRemove: remove })),
        S.jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }, children: [
          S.jsx("input", { value: newId, onChange: (e) => setNewId(e.target.value), style: { width: 220, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" }, placeholder: "新 hook id（如 sms-forward）" }),
          S.jsx("button", { type: "button", onClick: add, style: { padding: "4px 12px", borderRadius: 6, cursor: "pointer" }, children: "添加 hook" }),
        ] }),
        S.jsxs("div", { style: { display: "flex", gap: 8 }, children: [
          S.jsx("button", { type: "button", onClick: save, style: { padding: "6px 14px", borderRadius: 8, fontWeight: 500, cursor: "pointer" }, children: saved ? "✓ 已保存（热生效）" : "保存" }),
        ] }),
      ] });
    }

    const inject = ["slots", "remote"];

    function apply(ctx) {
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.webhook");
        const result = await remote[method](...args);
        if (!result || !result.ok) throw new Error(`webhook.${method} failed`);
        return result.value;
      };
      const getConfig = () => callRemote("getConfig");
      const setConfig = (payload) => callRemote("setConfig", payload);
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "webhook", order: 26, label: () => "Webhook", inject: () => ({ getConfig, setConfig }) },
        WebhookSection,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
