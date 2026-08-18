/**
 * dsh-webhook — host 半部分（独立插件）
 *
 * 职责：提供 HTTP webhook 入口 `POST /webhook/<hookId>`：
 *   - Bearer token 认证（配置在 webhook.hooks.<id>.token）
 *   - 立即 202 返回，消息入队异步投递（同一 hook 串行，防止并发搅乱会话）
 *   - hookId → {workspace, session, template} 映射，投递到固定会话
 *
 * 典型用途：手机端把银行短信 POST 进来 → 固定会话 agent 用 beancount-ledger 记账。
 * 本插件不实现 iMessage 发送（agent 记完账可调用 iMessage 网关的全局 message 工具通知）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { WebhookCore } from "./lib/webhook-core.mjs";

export const name = "dsh-webhook";

export const inject = ["typert", "settings", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "sessionPersistence", "webServer"];

export const Config = z.object({
  settingsPath: z.string().default(join(homedir(), ".dsh", "settings.yaml")),
});

/** `webhook` settings namespace：hooks 表（hookId → 认证/映射/模板）。 */
const HookSchema = z.object({
  token: z.string().required(),
  workspace: z.string().required(),
  session: z.string(),
  sessionMode: z.string(),
  template: z.string().required(),
  sync: z.boolean(), // true = 同步模式：等待 agent 回复并作为 HTTP 响应返回（供音箱等交互场景）
});
const WebhookSchema = z.object({
  hooks: z.dict(HookSchema),
});

// ── Typert wire schemas（宽松 parse） ───────────────────────────────────────
function parseObj() {
  return { parse(value) { if (typeof value !== "object" || value === null) throw new Error("expected object"); return value; } };
}
const getResultSchema = parseObj();
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

const MANIFEST = {
  package: "dsh-webhook",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-webhook#webhook/getConfig",
      service: "webhook",
      namespace: "webhook",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-webhook#WebhookConfig", schema: getResultSchema },
    },
    {
      id: "dsh-webhook#webhook/setConfig",
      service: "webhook",
      namespace: "webhook",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-webhook#SetPayload", schema: setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-webhook#SetResult", schema: setResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service：读写 webhook 配置。 */
class WebhookService extends TypertRemoteService {
  constructor(ctx, scope) {
    super(ctx, "webhook");
    this.scope = scope;
  }
  getConfig() {
    const snap = this.scope.get();
    return { hooks: snap?.hooks ?? {}, writable: true };
  }
  async setConfig(payload) {
    if (payload?.hooks !== undefined) await this.scope.update({ hooks: payload.hooks });
    return { ok: true };
  }
}

/** 常数时间 token 比较（防时序攻击）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 读取请求体（纯文本）。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** 从请求体提取短信文本：JSON {text|message|content} 或纯文本。 */
function extractText(body, contentType) {
  const raw = String(body ?? "").trim();
  if (!raw) return "";
  if (/application\/json/i.test(contentType ?? "")) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        const t = obj.text ?? obj.message ?? obj.content ?? obj.body;
        if (typeof t === "string") return t;
      }
    } catch { /* 非 JSON 按纯文本 */ }
  }
  return raw;
}

export function apply(ctx, config) {
  const Logger = ctx.logger;
  const ts = () => new Date().toISOString();
  const log = {
    info: (m) => { console.log(`[${ts()}] [wh] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [wh:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [wh:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  // 注册 schema + 拿 scope（配置落盘 settings.yaml 的 webhook 段，热生效）。
  const scope = ctx.settings.register("webhook", WebhookSchema, {
    base: { hooks: {} },
  });
  const service = new WebhookService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-webhook: typert manifest");

  // 投递核心（hooks 表随配置热更新）。
  const core = new WebhookCore({
    agents: ctx.get("agents"),
    defaultModel: ctx.get("agentDefaultModel"),
    sessions: ctx.get("sessions"),
    agentPresets: ctx.get("agentPresets"),
    workspaceRegistry: ctx.get("workspaceRegistry"),
    sessionPersistence: ctx.get("sessionPersistence"),
    log,
  });
  core.updateHooks(scope.get()?.hooks);

  // 配置热生效：watch 到 hooks 变化就替换表（无需重启）。
  scope.watch(() => {
    try {
      const snap = scope.get();
      const next = snap?.hooks ?? {};
      const changed = JSON.stringify(next) !== JSON.stringify(core.hooks);
      if (!changed) return;
      core.updateHooks(next);
      log.info(`webhook: hooks 配置已热生效（${Object.keys(next).length} 个）`);
    } catch (e) {
      log.error(`webhook: watch 处理失败 ${e instanceof Error ? e.message : e}`);
    }
  });

  // ── HTTP 入口：POST /webhook/<hookId> ──────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/webhook",
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const pathname = new URL(req.url, "http://internal").pathname;
        const hookId = decodeURIComponent(pathname.slice("/webhook/".length));
        if (!hookId || hookId.includes("/")) return send(404, { ok: false, error: "not found" });

        const hook = core.hooks[hookId];
        if (!hook) return send(404, { ok: false, error: `hook ${hookId} 不存在` });

        // 认证：Authorization: Bearer <token>
        if (req.method !== "POST") return send(405, { ok: false, error: "method not allowed" });
        const auth = req.headers["authorization"] ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!safeEqual(token, hook.token)) {
          log.warn(`webhook: [${hookId}] 认证失败（token 不匹配）`);
          return send(401, { ok: false, error: "unauthorized" });
        }

        const text = extractText(await readBody(req), req.headers["content-type"]);
        if (!text) return send(400, { ok: false, error: "empty body" });

        // 同步模式（hook.sync=true）：入队并等待 agent 回复，回复文本随 HTTP 响应返回。
        // 异步模式（默认）：入队立即返回 202（银行短信记账等场景）。
        if (hook.sync === true) {
          log.info(`webhook: [${hookId}] 同步投递 text=${text.slice(0, 60)}…`);
          const reply = await core.enqueueSync(hookId, text, 120000);
          if (reply == null) {
            return send(504, { ok: false, error: "timeout or no reply", hook: hookId });
          }
          return send(200, { ok: true, reply, hook: hookId });
        }

        core.enqueue(hookId, text);
        log.info(`webhook: [${hookId}] 已入队 text=${text.slice(0, 60)}…`);
        return send(202, { ok: true, queued: true, hook: hookId });
      } catch (e) {
        log.error(`webhook: 请求处理失败 ${e instanceof Error ? e.message : e}`);
        return send(500, { ok: false, error: "internal error" });
      }
    },
  }), "dsh-webhook: /webhook route");

  log.info(`webhook 插件已加载，hooks=${Object.keys(core.hooks).length} 个，入口 POST /webhook/<hookId>`);
}
