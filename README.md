# dsh-webhook — Webhook 插件

提供 HTTP webhook 入口 `POST /webhook/<hookId>`，把外部请求转成消息投递到 dsh 的固定会话，由 agent 处理。随 dsh web 启停，零 dsh 框架改动。

## 功能

- **HTTP 入口**：`POST /webhook/<hookId>`，Bearer token 认证（常数时间比较，防时序攻击）
- **异步队列**：默认立即 202 返回，消息入队投递；同一 hook 串行处理（上一条未完成下一条排队），不同 hook 互不阻塞
- **同步模式**：hook 配置 `sync: true` 时，等待 agent 完成并随 HTTP 响应返回回复文本（200 `{ok, reply}`）——适合小爱音箱等"发一句等一句"的交互场景
- **固定会话**：hookId 派生固定会话 id，上下文延续；支持 workspace / session / sessionMode(新/持久) / template 映射
- **典型场景**：手机把银行短信 POST 进来 → 固定会话 agent 用记账工具自动记账 → 完成后可调 iMessage 网关的全局 message 工具通知

## 目录

```
dsh-webhook/
├── index.js              # host 插件：webServer 路由 + Bearer 认证 + 配置 remote
├── client.js             # 浏览器 bundle：Settings → Webhook 配置页（hooks 表）
├── lib/webhook-core.mjs  # 队列 + 投递核心（固定会话 + preset mount + workspace 归属）
├── cordis.patch.yml      # bundle patch（插入 host 插件行）
└── package.json
```

挂载：web profile（`~/.dsh/profiles/web/`）`package.json` → `dependencies["dsh-webhook"] = "link:<project>/dsh-webhook"`，bundles 列表含 `dsh-webhook`。

## 配置

`$DSH_HOME/settings.yaml` 的 `webhook:` 段（可在配置页编辑）：

```yaml
webhook:
  hooks:
    sms-forward:
      token: "<bearer-token>"                 # 必填；请求头 Authorization: Bearer <token>
      workspace: "/Users/<you>/dsh/default"   # 投递目标工作区
      session: ""                             # 可选；默认用 hookId 派生固定会话
      template: "请处理这条短信并记账：\n{{text}}"  # 消息模板，{{text}} 为请求体
    xiaoai:
      token: "<token>"
      workspace: "/Users/<you>/dsh/default"
      sessionMode: "persistent"               # "persistent" 固定会话 / "new" 一次性
      sync: true                              # 同步模式：等待回复并随 HTTP 返回
      template: "你是智能管家，简洁口语化回答：\n{{text}}"
```

调用方式：

```sh
curl -X POST https://<dsh-host>/webhook/sms-forward \
  -H "Authorization: Bearer <token>" \
  -d '您的账户入账 100.00 元'
```

## 开发要点

- 新插件项目必须建依赖软链（否则 import `@deepseek-ai/*` 报 ERR_MODULE_NOT_FOUND）：
  ```sh
  mkdir -p node_modules && ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ```
- 改代码后重启 web 生效（web profile 的 HMR 已禁用）
