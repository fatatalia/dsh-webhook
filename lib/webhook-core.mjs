/**
 * webhook-core.mjs — dsh webhook 核心（队列 + 投递）
 *
 * 职责：
 *   - 每个 hookId 一条 FIFO 队列：上一条未处理完，下一条排队等待（同一会话串行，
 *     避免并发投递把会话上下文搅乱）；不同 hook 之间互不阻塞。
 *   - 投递逻辑与 iMessage 网关同源（固定会话 + preset mount + workspace 归属 +
 *     resume/create 判断），但会话 id 由 hookId 派生，与网关互不相干。
 *
 * 依赖经由调用方注入（agents/agentDefaultModel/sessions/...），本模块不持有框架状态。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { homedir } from "node:os";
import { join } from "node:path";

/** 从事件取给定区间最后一条纯文本 assistant 回复。 */
function summarizeReply(events, firstSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

/** 按 hookId 生成稳定 session id（同一 webhook 固定同一会话，上下文延续）。 */
function sessionIdForHook(hookId) {
  const h = String(hookId ?? "").trim().toLowerCase();
  let h1 = 5381;
  for (let i = 0; i < h.length; i++) h1 = ((h1 << 5) + h1 + h.charCodeAt(i)) >>> 0;
  let h2 = 52711;
  for (let i = 0; i < h.length; i++) h2 = ((h2 << 7) + h2 * 31 + h.charCodeAt(i) + i) >>> 0;
  const hex1 = h1.toString(16).padStart(8, "0");
  const hex2 = h2.toString(16).padStart(8, "0");
  return SessionId(`webhook-${hex1}${hex2}-wh`);
}

export class WebhookCore {
  constructor({ agents, defaultModel, sessions, agentPresets, workspaceRegistry, sessionPersistence, log = console }) {
    this.agents = agents;
    this.defaultModel = defaultModel;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.workspaceRegistry = workspaceRegistry;
    this.sessionPersistence = sessionPersistence;
    this.log = log;
    /** hookId → {token, workspace, session, template}（热更新）。 */
    this.hooks = {};
    /** hookId → FIFO promise 链。 */
    this._queues = new Map();
  }

  /** 配置热更新：替换 hooks 表（已入队的旧请求仍按入队时快照处理）。 */
  updateHooks(hooks) {
    this.hooks = hooks && typeof hooks === "object" ? hooks : {};
  }

  /** hookId → 归属工作区。 */
  workspaceFor(hookId) {
    return this.hooks[hookId]?.workspace || join(homedir(), "dsh", "default");
  }

  /**
   * 入队一条 webhook 消息（异步，立即返回）。
   * 同一 hookId 串行处理；错误被吞并记录，不影响后续队列。
   */
  enqueue(hookId, text) {
    this._queue(hookId, text).catch(() => {});
  }

  /**
   * 入队一条 webhook 消息并等待处理结果（同步模式）。
   * 同一 hookId 串行；返回该条投递的 agent 回复文本（失败/超时返回 null）。
   * 注意：超时只放弃等待，不中断后台投递（回复仍会完成，只是不回传）。
   */
  async enqueueSync(hookId, text, timeoutMs = 120000) {
    const task = this._queue(hookId, text);
    const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return Promise.race([task, timer]);
  }

  /** 内部：把一条消息排进 hookId 的 FIFO 链，返回处理结果 promise。 */
  _queue(hookId, text) {
    const prev = this._queues.get(hookId) ?? Promise.resolve();
    const task = prev
      .then(() => this._process(hookId, text))
      .catch((e) => {
        this.log?.error?.(`webhook: [${hookId}] 处理失败 ${e instanceof Error ? e.message : e}`);
        return null;
      });
    this._queues.set(hookId, task.catch(() => {}));
    return task;
  }

  /** 处理一条消息：渲染模板 → 投递到会话（按 sessionMode）。返回回复文本。 */
  async _process(hookId, text) {
    const hook = this.hooks[hookId];
    if (!hook) {
      this.log?.warn?.(`webhook: [${hookId}] 配置已不存在，丢弃消息`);
      return null;
    }
    const message = String(hook.template ?? "").replaceAll("{{text}}", String(text ?? ""));
    const mode = hook.sessionMode === "new" ? "new" : "persistent";
    this.log?.info?.(`webhook: [${hookId}] 开始投递 workspace=${hook.workspace} sessionMode=${mode}`);
    const reply = await this.deliver(hookId, hook.workspace, message, { sessionMode: mode });
    this.log?.info?.(`webhook: [${hookId}] 处理完成 reply=${String(reply ?? "").slice(0, 60)}`);
    return reply;
  }

  /**
   * 依据 agent-presets 组合出 web 兼容的 agent setup。
   * 与 iMessage 网关同源：web 进程 create agent 必须 presets.mount，否则 create 挂起。
   */
  async composeSetup(presetId) {
    const presets = this.agentPresets;
    if (presets === void 0) {
      return {
        setup: (agentCtx) => {
          const selection = this.defaultModel.currentSelection();
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
          return Promise.resolve();
        },
      };
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    const selection = this.defaultModel.currentSelection();
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  /** 把会话归属到对应 workspace（找不到按路径创建）。 */
  async attachWorkspace(sessionId, cwd) {
    const registry = this.workspaceRegistry;
    if (registry === void 0) return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (workspace === void 0) workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
    } catch (e) {
      this.log?.warn?.(`webhook: attach workspace ${cwd} 失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 投递用户消息到会话，返回 agent 回复。
   * sessionMode:
   *   - persistent（默认）：固定会话（live 复用 → resume 持久 → create），上下文延续
   *   - new：每次新建独立会话（id 带时间戳），投递完归档，互不影响
   */
  async deliver(hookId, workspace, message, options = {}) {
    const mode = options.sessionMode === "new" ? "new" : "persistent";
    const id = mode === "new"
      ? SessionId(`webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      : sessionIdForHook(hookId);
    const selection = this.defaultModel.currentSelection();
    const agentOptions = { provider: selection.provider, model: selection.model };

    let agent = this.agents.get(id);
    if (!agent) {
      const composition = await this.composeSetup(undefined);
      if (mode === "new") {
        // 一次性会话：直接 create，不查持久化
        this.log?.info?.(`webhook: [${hookId}] create 一次性 id=${id}`);
        const created = await this.agents.create({
          sessionId: id,
          meta: {
            cwd: workspace,
            ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions,
          setup: composition.setup,
        });
        agent = created.agent;
      } else {
        let persisted = false;
        try {
          const headers = await this.sessionPersistence?.list?.();
          persisted = !!headers?.some((h) => String(h.id) === String(id));
        } catch { /* persistence 不可用视为新建 */ }
        if (persisted) {
          this.log?.info?.(`webhook: [${hookId}] resume 持久 id=${id}`);
          const resumed = await this.agents.resume({
            resumeSessionId: id,
            agentOptions,
            setup: composition.setup,
          });
          agent = resumed.agent;
        } else {
          this.log?.info?.(`webhook: [${hookId}] create 固定 id=${id}`);
          const created = await this.agents.create({
            sessionId: id,
            meta: {
              cwd: workspace,
              ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }),
            },
            agentOptions,
            setup: composition.setup,
          });
          agent = created.agent;
        }
      }
    }

    // turn 级单步超时配置（dsh-turn-guard 读取）：从 hook 配置读 stepTimeoutSec（单位秒），
    // 挂到 agent 上的通用扩展容器 __pluginConfig（不可枚举、不持久化、分区）。
    // 幂等：每次投递都挂（live 复用/恢复/新建都覆盖）；无配置不挂（turn-guard 不干预）。
    if (agent && !agent.__pluginConfig) {
      try {
        Object.defineProperty(agent, "__pluginConfig", {
          enumerable: false,
          writable: true,
          configurable: true,
          value: {},
        });
      } catch (e) {
        this.log?.warn?.(`webhook: [${hookId}] 初始化 __pluginConfig 失败: ${e instanceof Error ? e.message : e}`);
      }
    }
    const stepSec = Number(this.hooks[hookId]?.stepTimeoutSec) > 0 ? Number(this.hooks[hookId]?.stepTimeoutSec) : 0;
    if (agent?.__pluginConfig) {
      if (stepSec > 0) agent.__pluginConfig.turnGuard = { stepSec };
      else delete agent.__pluginConfig.turnGuard; // 配置清零 → 不干预
    }

    await this.attachWorkspace(id, workspace);

    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: "text", text: message }],
      source: { kind: "user" },
    }));
    // 工具调用轮次上限：模型可能陷入调查循环/输出退化（如记账场景反复查
    // ledger 不决策，最终退化为重复文本无限跑）。超过上限用 agent.cancel
    // 中断当前 turn，避免无限循环。正常任务 3-8 轮工具调用，15 轮很宽松。
    const MAX_TOOL_CALLS = 15;
    const countToolCalls = () => agent.session.events.filter((e) => e.type === "tool/call").length;
    let loopCancelled = false;
    const loopPoller = setInterval(() => {
      if (!loopCancelled && countToolCalls() > MAX_TOOL_CALLS) {
        loopCancelled = true;
        this.log?.warn?.(`webhook: [${hookId}] 工具调用超 ${MAX_TOOL_CALLS} 轮，中断疑似循环`);
        try {
          agent.cancel({ kind: "hook", reason: `webhook tool call limit (${MAX_TOOL_CALLS}) exceeded` });
        } catch (e) {
          this.log?.warn?.(`webhook: [${hookId}] 中断失败 ${e instanceof Error ? e.message : e}`);
        }
      }
    }, 500);
    try {
      await agent.whenIdle();
    } finally {
      clearInterval(loopPoller);
    }
    await this.sessions.flush(agent.session);
    const reply = summarizeReply(agent.session.events, firstSeq);

    // 一次性会话用完归档，保持会话列表干净
    if (mode === "new") {
      try {
        await this.workspaceRegistry?.archiveSession(id);
        this.log?.info?.(`webhook: [${hookId}] 一次性会话 ${id} 已归档`);
      } catch (e) {
        this.log?.warn?.(`webhook: [${hookId}] 归档失败 ${e instanceof Error ? e.message : e}`);
      }
    }
    return reply;
  }
}
