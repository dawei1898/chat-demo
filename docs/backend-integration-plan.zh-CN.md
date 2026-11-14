# chat-demo 后端接入方案

> 2026-11-14。基于本次讨论重新整理的本地版本，不是此前附件的逐字副本。本次只记录方案与调整本地运行端口，尚未实现后端代理。

## 1. 推荐路线

先增加同协议 BFF，保留 React、Zustand、IndexedDB 及现有 Messages SSE 解析；再增加登录、PostgreSQL 会话持久化与配额。多模型统一事件放到最后，不必为了增加代理迁移 Next.js 或重写全部 UI。

```text
React → 自己的后端（认证、校验、限流、注入服务端 Key）→ DeepSeek
      ← 保持原始 Messages SSE 流 ←
```

技术选项：Hono + Node.js 适合快速沿用 TypeScript；Spring Boot 3 适合以 Java 为核心的权限和业务服务；NestJS 适合希望使用 TypeScript 模块化工程结构。技术栈与是否持久化、是否统一协议是独立选择。

## 2. 当前调用入口与迁移范围

| 功能 | 当前上游路径 | 处理方式 |
| --- | --- | --- |
| 聊天 | POST /anthropic/v1/messages | fetch + ReadableStream，Messages SSE |
| 上传附件 | POST /anthropic/v1/files | multipart |
| 删除附件 | DELETE /anthropic/v1/files/:id | 校验文件业务归属 |
| Key 校验 | GET /models | 改成应用身份/配置状态接口，不向浏览器发送服务商 Key |
| 语音识别 | POST /v1/tools/asr | multipart 音频 |
| 语音合成 | POST /v1/tools/tts | PCM 二进制流，不是 SSE |

主要位置：`src/services/api/client.ts`、`src/services/api/speech.ts`、`src/services/api/sse.ts`、`src/services/chat/store.ts`、`src/services/chat/reply.ts`、`src/services/settings.ts`、`rspack.config.ts`。

## 3. 第一阶段：最小 BFF

1. 前端将 API origin 改为自己的同源 API 路径；删除模型 Key 输入、localStorage 持久化及校验依赖，使用应用登录凭证。
2. 后端固定上游为 `https://api.deepseek.com`，只开放白名单路由；不接受任意目标 URL，也不允许客户端覆盖服务端鉴权头。
3. Key 只从服务端环境配置获取，不写入前端构建变量、不返回浏览器、不记录到日志、不提交 Git。
4. 服务端限制模型、输出 token、请求体大小、并发和频率。公开访问前必须有认证和配额；CORS 不能代替鉴权。Cookie 登录要配套 CSRF 防护。
5. 保留原始 SSE 事件结构，逐块转发，不能先读取完整 `text()` / `json()` 再发送。
6. 上游 HTTP 错误保留合适状态码；流已经开始后通过流事件表达错误，不能再改 HTTP 状态码。客户端取消或断线时取消上游请求。
7. 反向代理关闭响应缓冲并配置合理超时；测试首包、长回答、停止生成、异常断流。
8. 共享服务商 Key 后，附件上传、引用、删除均须做业务用户归属校验，不能仅验证登录。

此阶段历史仍在 IndexedDB，不自动获得多设备同步，也没有实现服务端会话管理。

## 4. 第二阶段：业务后端和数据库

建议 Hono + PostgreSQL + Better Auth，或者 Spring Boot 3 + PostgreSQL + 适合项目的认证方案。后端负责加载历史、调用模型、保存完整消息及 usage，前端只提交业务消息并接收流。

建议接口（属于设计，不是现有接口）：

- `POST /api/conversations` 创建会话
- `GET /api/conversations` 分页会话列表
- `GET /api/conversations/:id/messages` 消息历史和分支
- `POST /api/conversations/:id/messages` 发送消息、SSE 返回
- `DELETE /api/conversations/:id` 删除会话

表设计应至少覆盖用户、会话、消息、附件、用量；保留消息父子关系以支持编辑与重新生成分支。每条会话和附件均绑定用户。消息保存完整 content blocks，不能只存最终回答文本，否则可能丢失 thinking/tool blocks、搜索来源和续轮必要信息。

保存到数据库不要求同时重做 SSE 协议，可继续使用 Messages 事件。浏览器旧记录迁入数据库需要独立导入设计，失败/中断生成应保留明确状态而不是假装成功。

## 5. 第三阶段：多模型统一

按供应商建立适配层，将上游转换成自己的事件，如 reasoning_delta、text_delta、tool_call_delta、usage、done、error。前端解析层需同步改造。

当前功能依赖 DeepSeek 的搜索、读链接、标题和 latest_reminder 等扩展；不是换 base URL 就能兼容全部模型。对不支持的能力明确关闭 UI 或返回可理解错误。

## 6. SSE 契约与联调清单

Messages 流通常经过 message_start、content_block_start/delta/stop、message_delta、message_stop，可能包含 ping；不是 `data: [DONE]`。缺少 message_stop 的断流应标记不完整。最终 usage 不应与初始累计值重复相加。

- 普通回答、深度思考、搜索/链接、标题均正确渲染。
- 逐块解析可处理 UTF-8 字符和 SSE 帧跨网络 chunk。
- 停止生成能取消上游；断流、401/429、超时与流内错误有明确反馈。
- 编辑、重生成、分支和工具续轮保持原有行为。
- 附件与语音分别验证，不以聊天成功代表全部接口成功。
- 不同用户不能读、引用、删除对方会话或文件。
- 日志没有 Key；请求配额和费用统计可追踪。

参考：https://api-docs.deepseek.com/guides/anthropic_api/

## 7. 本机开发

本次工作目录：`/Users/fu/code/codex_projects/deepseek-chat-demo`，分支 `dev`。

```sh
pnpm install --frozen-lockfile
pnpm type
pnpm lint
pnpm build
pnpm dev
```

开发端口已设为 `8095`，只绑定 `127.0.0.1`。在同一台 Mac 上打开 `http://127.0.0.1:8095/`。当前仍是原有浏览器 Key 模式，用户自行在页面填写，不要发到聊天中。若系统 watcher 报 EMFILE，可用 `CHOKIDAR_USEPOLLING=true WATCHPACK_POLLING=true pnpm dev` 启动，避免调整系统安全设置。
