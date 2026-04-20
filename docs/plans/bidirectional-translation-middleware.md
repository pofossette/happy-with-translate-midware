# 双向翻译中间件设计方案

## 目标

给当前项目增加一层双向翻译中间件，实现以下体验：

- 远程客户端用户可以直接输入中文。
- 实际发给本地编码 agent 的仍然是英文。
- agent 返回的英文内容会被翻译成中文后展示给远程客户端。
- 尽量保持当前端到端加密模型，不让服务端接触明文。

## 现状约束

当前消息链路里，服务端只负责存储和转发密文，不理解消息正文：

- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`
  - `socket.on('message')` 直接把 `message` 当成密文字符串写入 `sessionMessage.content.c`
- `packages/happy-agent/src/session.ts`
  - `sendMessage(text, meta?)` 在 agent 侧构造明文消息，然后加密后发送
  - 收到 `new-message` 时也在 agent 侧解密
- `packages/happy-app/sources/sync/sync.ts`
  - app 侧同样在本地加解密
  - `sendMessage(sessionId, text, options?)` 已支持 `meta.displayText`
- `packages/happy-app/sources/components/MessageView.tsx`
  - 用户消息渲染优先使用 `displayText || text`
- `packages/happy-wire/src/messageMeta.ts`
  - 共享 `MessageMetaSchema` 已包含 `displayText`

这意味着：

- 不能把翻译逻辑放在 `happy-server`，否则必须破坏现有 E2EE。
- 最合理的位置是“解密之后、进入 UI/agent 之前”的会话边缘。

## 设计结论

推荐采用“agent 侧翻译代理 + 客户端显示覆写”的方案。

- 入站翻译：远程客户端发中文，消息在进入真实 agent 之前由本地 `happy-agent` 翻译成英文。
- 出站翻译：真实 agent 输出英文，先由本地 `happy-agent` 翻译成中文，再发给远程客户端。
- 原文保留：消息 metadata 里同时保存原文和展示文，避免丢失英文上下文。
- 服务端保持无状态透传，不参与翻译。

## 控制流

### 1. 远程客户端发送中文消息

```txt
Remote user sends Chinese text
│
├─ happy-app/sources/-session/SessionView.tsx
│  └─ sync.sendMessage(sessionId, chineseText, { source: 'chat' })
│
├─ happy-app/sources/sync/sync.ts
│  ├─ content: UserMessage
│  │  ├─ role: 'user'
│  │  ├─ content: { type: 'text', text: chineseText }
│  │  └─ meta.displayText = chineseText
│  └─ encryptRawRecord(content) → socket 'message'
│
├─ happy-server sessionUpdateHandler.ts
│  └─ stores opaque ciphertext only
│
├─ happy-agent/src/session.ts
│  └─ decrypt(...) → { role: 'user', content: { type: 'text', text: chineseText }, meta }
│
└─ TranslationInboundMiddleware.handleUserText(message)
   ├─ detectLanguage(chineseText) -> 'zh'
   ├─ translate zh -> en
   ├─ mutates:
   │  ├─ runtime forwardText = englishText
   │  └─ message.meta.translation = {
   │     sourceLang: 'zh',
   │     targetLang: 'en',
   │     sourceText: chineseText,
   │     translatedText: englishText
   │  }
   └─ pass englishText to real provider adapter (Claude/Codex/Gemini)
```

### 2. agent 输出英文，远程客户端展示中文

```txt
Provider emits English output
│
├─ happy-cli / provider adapter
│  └─ produces agent message chunks / final text in English
│
├─ TranslationOutboundMiddleware.handleAgentText(message)
│  ├─ collect visible text blocks only
│  ├─ translate en -> zh
│  ├─ preserve original englishText
│  └─ build UI-facing message:
│     ├─ content.text = englishText
│     └─ meta.translation = {
│        sourceLang: 'en',
│        targetLang: 'zh',
│        sourceText: englishText,
│        translatedText: chineseText
│     }
│
├─ happy-agent/src/session.ts
│  └─ encrypt(translated envelope with metadata) → socket 'message'
│
├─ happy-server
│  └─ stores opaque ciphertext only
│
└─ happy-app
   ├─ decryptMessage(...)
   ├─ reducer normalizes message
   ├─ user-text already supports displayText
   └─ agent-text should render:
      if meta.translation.translatedText exists
      show translatedText
      else show text
```

### 3. 开关与降级

```txt
Session translation mode change
│
├─ session.metadata.translation
│  ├─ enabled: boolean
│  ├─ userInput: { source: 'zh', target: 'en' }
│  ├─ agentOutput: { source: 'en', target: 'zh' }
│  ├─ provider: 'openai' | 'deepl' | 'custom'
│  └─ mode: 'full' | 'display-only'
│
├─ happy-app reads metadata
│  └─ shows badge / status / failure hint
│
└─ happy-agent reads metadata
   ├─ enabled = false -> bypass all translation
   ├─ translator unavailable -> fallback to raw text
   └─ translation timeout -> send raw text + service event
```

## 推荐分层

### A. 翻译能力只放在 `happy-agent`

新增一个本地翻译层，建议放在 `packages/happy-agent/src/translation/`：

- `translator.ts`
  - `translate(request): Promise<TranslationResult>`
- `languageDetection.ts`
  - 简单语言检测或显式配置优先
- `inboundMiddleware.ts`
  - 用户消息进入真实 agent 前翻译
- `outboundMiddleware.ts`
  - agent 输出回传前翻译
- `translationTypes.ts`
  - 会话配置、缓存 key、meta shape

理由：

- agent 侧天然能看到明文。
- 本地执行可保留 E2EE。
- 可按会话、按机器、按 provider 配置，不污染 server。

### B. 服务端只扩展 metadata，不处理正文

服务端只需要继续透传：

- session metadata 中的翻译配置
- message meta 中的翻译结果

不需要新增服务端翻译 API。

### C. app 负责展示 translatedText，不负责主要翻译

app 侧只做两类事情：

- 用户消息继续使用已有 `displayText`
- agent 消息新增 `translatedText` 优先展示能力

不建议把主翻译能力放在 app：

- Web / iOS / Android 三端都要重复实现
- 会打散同一 session 的翻译一致性
- 无法覆盖 `happy-agent send`、CLI 恢复、语音等非 app 入口

## 协议建议

### Session metadata

建议在 session metadata 中新增：

```ts
type SessionTranslationConfig = {
  enabled: boolean;
  mode: 'full' | 'display-only';
  userInput: {
    sourceLang: 'zh' | 'auto';
    targetLang: 'en';
  };
  agentOutput: {
    sourceLang: 'en' | 'auto';
    targetLang: 'zh';
  };
  provider: 'openai' | 'deepl' | 'custom';
  preserveOriginal: boolean;
};
```

说明：

- `full`: 用户输入上行前翻译，agent 输出下行前翻译。
- `display-only`: 不改变上行 prompt，只翻译展示层输出。适合先灰度。
- `preserveOriginal`: UI 可切换“查看英文原文”。

### Message meta

建议在 `MessageMetaSchema` 上扩展：

```ts
type MessageTranslationMeta = {
  direction: 'inbound' | 'outbound';
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  translatedText: string;
  provider: string;
  status: 'success' | 'fallback' | 'timeout' | 'skipped';
};
```

合并后形态：

```ts
type MessageMeta = {
  displayText?: string;
  translation?: MessageTranslationMeta;
};
```

建议约定：

- 用户消息：
  - `content.text = englishText`
  - `meta.displayText = chineseText`
  - `meta.translation.direction = 'inbound'`
- agent 消息：
  - `content.text = englishText`
  - `meta.translation.translatedText = chineseText`

这样可以保持：

- provider 侧上下文统一是英文
- UI 侧优先展示中文
- 调试和重试仍可取到英文原文

## UI 行为建议

### 用户消息

现有能力基本够用：

- `happy-app/sources/sync/sync.ts` 发送时已经支持 `displayText`
- `happy-app/sources/components/MessageView.tsx` 已优先展示 `displayText`

只需要确保：

- 当双向翻译开启时，远程客户端总是把中文写入 `displayText`
- 真正发送给 agent 的 `content.text` 改为英文

### agent 消息

需要补一层标准渲染规则：

- 如果 `meta.translation.translatedText` 存在，默认显示中文
- 提供“查看原文”切换或长按展开英文
- 复制时允许选择“复制中文”或“复制英文”

## 为什么不要直接改写历史消息

不要在 server 或 reducer 中把英文正文直接覆盖成中文：

- 会丢失真实 prompt / provider output
- 调试问题时无法回溯原始上下文
- 日后关闭翻译后历史会变得不一致

正确做法是：

- 原文保留在 `content.text`
- 展示文放在 `meta.displayText` 或 `meta.translation.translatedText`

## 翻译粒度建议

### 入站

按“单条用户消息”翻译。

优点：

- 实现简单
- 与现有 `sendMessage(sessionId, text)` 模型一致
- 失败时容易回退到原文发送

### 出站

第一阶段按“最终可见文本块”翻译，不翻 thinking 和 tool 细节。

优先翻译：

- agent 普通文本回复
- service message
- turn summary

先不翻译：

- thinking
- tool call 参数
- 原始 JSON / diff / shell 输出

否则风险很高：

- 命令、路径、代码块被误翻译
- 工具结果失真
- token 和延迟成本暴涨

## 缓存与性能

建议在 `happy-agent` 本地做短期缓存：

```ts
type TranslationCacheKey = `${direction}:${sourceLang}:${targetLang}:${sha256(sourceText)}`;
```

缓存目标：

- 网络抖动重发
- app / agent 重连后重复消息
- 同一句权限提示、服务提示反复翻译

额外策略：

- 文本长度阈值，小于阈值不走自动检测
- 代码块占比过高时直接跳过翻译
- 超时后返回原文并标记 `status: 'timeout'`

## 风险

### 1. 上下文污染

如果把中文和英文同时送进真实 agent，上下文会变乱。

规避：

- 提供给 provider 的只保留英文
- 中文仅保留在 UI metadata

### 2. 代码/命令误翻译

规避：

- 对代码块、路径、命令行、 JSON 做保护
- 仅翻译自然语言片段

### 3. 流式输出闪烁

如果每个 token 都翻译，体验会很差。

规避：

- 只在句子边界或 chunk 合并后翻译
- 第一版可只翻译 final text message

### 4. 成本不可控

规避：

- 仅对开启翻译的 session 生效
- 支持 provider 配置和限流
- 增加缓存

## 渐进式落地顺序

### Phase 1

先做“输出中文展示”，不改输入链路。

- agent 输出英文
- `happy-agent` 翻译成中文写入 `meta.translation.translatedText`
- app 优先展示中文

价值：

- 风险最低
- 不影响真实 prompt
- 很快验证翻译质量和延迟

### Phase 2

加入“中文输入 -> 英文上行”。

- app 发送中文时保留 `displayText`
- `happy-agent` 收到后翻成英文再喂给真实 agent

### Phase 3

补全产品化能力。

- 会话级开关
- 原文/译文切换
- 错误提示
- provider 配置
- 统计和超时降级

## 最小实现清单

1. `happy-agent` 增加翻译抽象层与会话配置读取。
2. `happy-agent` 在入站用户消息处增加 zh -> en 翻译。
3. `happy-agent` 在出站文本消息处增加 en -> zh 翻译。
4. `happy-app` 的 agent message 渲染支持 `meta.translation.translatedText`。
5. session metadata 增加 `translation` 配置。
6. 加入超时、fallback、缓存和日志。

## 最终建议

对这个项目，最稳妥的方案不是“服务端翻译网关”，而是“本地会话边缘翻译”：

- `happy-server` 继续只处理密文
- `happy-agent` 负责双向翻译中间件
- `happy-app` 只负责中文优先展示和状态反馈

这样改动最符合当前架构，也不会破坏 Happy 现在最重要的特性之一：端到端加密。
