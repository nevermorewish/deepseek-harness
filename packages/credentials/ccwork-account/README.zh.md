---
description: "授权 ccwork 账号，把令牌存入现有的本地凭据存储，并读取该账号计费所依据的余额、模型目录与消耗流水。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ccwork-account

[English](README.md) | 中文

本包把 harness 登录到某个 ccwork 部署，并回答该账号可以花什么。它拥有一条存放令牌的凭据记录和一条存放所选组织的非机密记录。每一次余额、目录与用量读取都以该组织为作用域，而这正是 ccwork 对请求的要求。

## Summary

通过浏览器确认的设备授权、密码提示或账号注册来登录。令牌存放在现有的本地凭据存储中，因此 CLI、Web host 与 Desktop host 共用一次登录。只有服务端确定的拒绝才会丢弃它们；限流或并发轮换会保留。

## Table of Contents

- [使用本包](#use-this-package)
- [登录方式](#sign-in-methods)
- [令牌寿命与刷新](#token-lifetime-and-refresh)
- [组织选择](#organization-selection)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

插件为 `ccwork-account/default` 这条凭据键注册了一个授权流程，因此任何列出可授权对象的界面都会提供它，`ctx.authorization.begin` 运行它。配置指定部署地址：

```yaml
- id: ccwork-account
  config:
    apiBaseUrl: https://ccwork.site/api
```

`apiBaseUrl` 默认为 harness 出货所针对的 ccwork 部署。启动时，`issuer` 与配置不同的已存记录会被删除，而不是发往错误的主机。

余额读取 `available_credits_precise`、`credits_frozen_precise` 与 `credits_precise`，保留 ccwork 的十进制字符串。ccwork 同时发送的整数形式会丢失扣费的小数部分，因此只作为回退。目录读取映射 `context_window_tokens` 与 `max_output_tokens`；用量读取把计量项固定为 `llm.tokens`，以免 LLM 消耗与同一端点提供的存储、媒体记录混在一起。

<a id="sign-in-methods"></a>
## 登录方式

`device` 位于流程方法列表的首位。提供方 POST `/auth/device/code`，把短码与已预填的验证 URL 作为两个独立的通知字段上报——通知携带消息、页面与代码，由界面各自渲染——随后按 ccwork 返回的间隔轮询 `/auth/device/token`，直到用户确认。RFC 8628 的四种结果被区别处理：`AUTHORIZATION_PENDING` 继续轮询，`SLOW_DOWN` 拉长间隔，`ACCESS_DENIED` 把该次尝试判定为用户拒绝而非失败，`EXPIRED_TOKEN` 使其失败。

`password` 提示输入标识与密码。密码以 `secret` 提示收集，以便界面遮蔽并使其不进入日志；它绝不会被放入通知。标识接受邮箱、手机号或用户名，因为 ccwork 从同一字段解析这三者。

`register` 通过 `/auth/send-verification-code` 与 `/auth/register` 创建账号。邀请码作为可选字段请求，因为是否必需由部署决定——ccwork 自身的设置会随其运行的配置档案而默认为两种取值，因此流程接受空值，让服务端拒绝缺失的那个。注册直接返回会话，因此不再有第二次登录。

<a id="token-lifetime-and-refresh"></a>
## 令牌寿命与刷新

ccwork 签发 24 小时的访问令牌（`remember_me` 延长至 7 天），并且每次刷新都轮换两个令牌。刷新在一次 `modifyRecord` 的读取—判定—替换内完成，因此共享同一凭据存储的两个进程无法并发轮换同一个刷新令牌，也就不会丢失先写入的那一个。

最近 30 秒内成功过的刷新会被复用而不是重复执行，因为 ccwork 对该端点限流，一串请求否则会各自发起一次刷新。处于两分钟过期缓冲内的访问令牌被视为即将过期。

失败分类正是这套逻辑与存储分离的原因。信封中的业务码先于 HTTP 状态被读取，因为 ccwork 曾用 401 表达被限流的刷新：先看状态的判断会把一个仅仅被限流的用户登出。

- 限流（`RATE_LIMITED`，或 HTTP 408/425/429）保留凭据。若已存访问令牌仍然有效，则直接使用它，而不是让一个用户已授权的请求失败。
- 并发轮换（`REFRESH_CONFLICT`，或 HTTP 409）保留凭据。先重读存储，因为另一个写入者刷新的令牌可能已经落盘，之后才以带抖动的退避重试，至多两次。
- 确定的拒绝（HTTP 401/403/404，或指明令牌无效、用户不存在、账号停用的业务码）丢弃两条记录并发出 `ccwork-account/session-expired`。
- 服务端故障或传输失败保留凭据，并把错误交给调用方重试。

登出先删除本地记录，再在后台撤销会话；撤销失败绝不会恢复本地登出。

<a id="organization-selection"></a>
## 组织选择

ccwork 的登录响应不携带组织，因此提供方在授权后列出 `/context/organizations` 并选择其一。这里采用 ccwork 自家客户端的顺序——先个人组织，再账号默认，最后是列出的第一个——因为先选默认会让默认是团队的组织显示出与 ccwork 桌面端不同的余额。

所选组织与完整列表存放在非机密的 `ccwork-account/profile` 记录中。所选 id 会作为 `X-TabTin-Organization-Id` 随每一次余额、目录与用量读取发送。

<a id="model-experience"></a>
## Model Experience

无。账号凭据影响 HTTP 认证，绝不进入模型提示、会话日志或工具结果。

#### KV Cache effect

模型请求前缀不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 令牌存放在共享的本地凭据文档中，本包不加密它，Desktop host 也未用 Electron `safeStorage` 封装它。在单用户机器上，这与 harness 已经给予 API key 的保护相同；多用户或远程 Web host 会把已登录账号共享给每一个接入的浏览器。把令牌记录移到可加密的凭据提供方之后属于待办，且无需改动本包，因为存储缝是可替换的。
- 不提供组织切换器。账号的组织已被记录以备后用，但提供方只做自动选择；若用户想查看团队而非个人组织的消耗，目前没有界面路径。
- `refreshExpiresAt` 被记录为无上界，因为 ccwork 不告知客户端刷新令牌的存活时长。因此过期是由服务端在下一次刷新时的拒绝来发现的，而非预测——这是正确的，但意味着过期后的第一个请求要承担这次发现的开销。
- 余额按需读取且不轮询，提供方也收不到消耗在他处发生时的信号，因此可见余额在界面刷新之前可能是陈旧的。ccwork 没有暴露本包所订阅的推送通道。
