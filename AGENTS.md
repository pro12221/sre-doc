# AGENTS.md — sre-doc 项目指南

> 本文件在每次会话启动时自动加载,为 AI Agent 提供项目上下文和操作规范。

## 项目概述

sre-doc 是一个**纯静态个人技术知识库**,部署在 Cloudflare Pages。**Markdown 是唯一源**:
所有内容存放在 `MarkDown/` 目录,提交后由 `build.mjs` 自动渲染为静态 HTML。

**核心流程**(对比 v2 之前):

| 旧流程(v2) | 新流程(v3) |
|---|---|
| 1. 写 `MarkDown/*.md` | 1. 写 `MarkDown/**/*.md` |
| 2. 手工转 `posts/*.html` | — |
| 3. 手工改 `index.html` | — |
| 4. 手工改 `js/data.js` | — |
| 5. 手工改 `rss.xml` / `sitemap.xml` | — |
| 6. git commit + push | 2. git commit + push |
| 7. CI 部署 | 3. CI 跑 `npm run build` + 部署 |

**站点地址**:Cloudflare Pages 托管,project `sre-note`,域 `sre-note.pages.dev`。

---

## 目录结构

```
sre-doc/
├── MarkDown/                  # Markdown 源文件(唯一源)
│   ├── kubernetes/            # 每篇文章按主分类放子目录
│   │   ├── admission-webhook.md
│   │   └── ...
│   ├── ai/
│   ├── bigdata/               # 新分类(2026-07)
│   ├── linux/
│   ├── network/
│   ├── Observability/         # 目录名首字母大写可,build 会归一化
│   ├── devops/
│   └── iac/
├── posts/                     # 生成的 HTML(不提交,build 产物)
├── templates/                 # HTML/JS/XML 模板(build.mjs 读这些)
│   ├── post.html
│   ├── home.html
│   ├── about.html
│   ├── 404.html
│   ├── data.js
│   ├── rss.xml
│   └── sitemap.xml
├── build/                     # 构建模块
│   └── categories.mjs         # 分类元数据 + 关键词标签
├── build.mjs                  # 主构建脚本(读 MD → 输出 HTML/JS/XML)
├── package.json               # marked 依赖
├── css/
│   ├── tokens.css             # 设计 token(深青 #0F766E)
│   ├── doc.css                # 布局(sidebar / topbar / TOC)
│   ├── content.css            # 文章正文 + 卡片 + tag
│   └── components.css         # palette / mobile
├── js/                        # 客户端脚本(瘦,只负责数据驱动 UI)
│   ├── data.js                # ← build.mjs 生成
│   ├── theme.js
│   ├── sidebar.js
│   ├── palette.js             # ⌘K
│   ├── home.js                # 首页 hero + recent + categories + featured
│   ├── toc.js
│   └── reading.js             # 代码块复制按钮
├── index.html                 # ← templates/home.html
├── 404.html                   # ← templates/404.html
├── about.html                 # ← templates/about.html
├── rss.xml                    # ← templates/rss.xml
├── sitemap.xml                # ← templates/sitemap.xml
├── .github/workflows/
│   └── static.yml             # CI:checkout → npm ci → npm run build → deploy
└── AGENTS.md                  # 本文件
```

---

## 分类体系

固定分类列表(在 `build/categories.mjs` 维护)。每篇文章归属**一个主分类**(由父目录决定)。

| 分类 ID        | 显示名称      | 目录名(大小写不敏感)  | 描述                       |
|--------------|------------|---------------|--------------------------|
| `kubernetes` | Kubernetes | `kubernetes/` | 容器编排 · 调度 · 存储          |
| `ai`         | AI         | `ai/`         | LLM · Agent · NLP         |
| `bigdata`    | BigData    | `bigdata/`    | HDFS · Spark · YARN(2026-07 新增) |
| `linux`      | Linux      | `linux/`      | 内核 · 性能调优 · 包处理          |
| `network`    | Network    | `network/`    | TCP/IP · Overlay · 架构    |
| `observability` | Observability | `Observability/` 或 `observability/` | 监控 · 指标 · 告警 |
| `devops`     | DevOps     | `devops/`     | CI/CD · 部署 · 自动化          |
| `iac`        | IaC        | `iac/`        | Terraform · 基础设施即代码      |

**新增分类步骤**:
1. 编辑 `build/categories.mjs`,在 `CATEGORIES` 数组中加一项
2. 创建 `MarkDown/{id}/` 目录
3. 写 `.md` 文件 → 提交 → CI 自动处理

---

## 文章命名规则

| 来源         | 规则                                               |
|------------|--------------------------------------------------|
| 文件名        | 用户自定(只用 ASCII + 中文,避免特殊字符)                  |
| 标题         | 从第一个 `# 一级标题` 解析(若没有则用 `## 二级标题` 或文件名)        |
| URL slug   | 标题 → kebab-case(空格 → `-`,中文保留)                 |
| HTML 文件名   | `posts/{slug}.html`(由 build.mjs 生成)             |
| HTML `<title>` | `{标题} - SRE Notes`(由模板)                       |
| 日期         | `git log` 首次提交日期(ISO);fallback:文件 mtime         |
| 摘要         | 标题后第一段,≤90 中文字符 + `…`                        |
| 标签         | 主分类 + 关键词扫描匹配(`build/categories.mjs` 的 `TAG_KEYWORDS`) |

---

## 新增文章完整流程

### 写一篇新文章

1. **写 Markdown**:在 `MarkDown/{主分类}/` 下创建 `{slug}.md`
   - 第一行 `# 文章标题`
   - 内容用标准 Markdown(支持 GFM 表格、代码块、引用、列表)
   - 图片放在 `MarkDown/{主分类}/images/`,用相对路径 `![](./images/foo.png)`
   - 可用以下自定义组件(HTML 直写):
     - `<div class="highlight-box">` — 提示/注意框
     - `<div class="card">` — 信息卡片
     - `<div class="flow-diagram">` — ASCII 流程图
     - `<div class="flow-steps">` + `<div class="flow-step">` — 步骤流

2. **提交 + 推送**:
   ```bash
   git add MarkDown/{主分类}/{slug}.md
   git commit -m "docs: add {文章标题} article"
   git push origin main
   ```

3. **CI 自动完成**:
   - GitHub Actions: `npm ci` → `npm run build` → Cloudflare Pages deploy
   - `build.mjs` 自动:
     - 解析标题/分类/日期/标签/摘要
     - 渲染 `posts/{slug}.html`
     - 重新生成 `js/data.js`、`index.html`、`rss.xml`、`sitemap.xml`

### 改一篇现有文章

直接编辑对应的 `.md` 文件,提交即可。下次 CI 触发会重建。

### 删除一篇文章

删除对应的 `.md` 文件,提交即可。下次 CI 触发会从 `posts/` 移除。

---

## 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 构建一次
npm run build

# 3. 启动本地预览(http://localhost:8080)
npm run serve
# 或一键
npm run preview   # = build + serve

# 4. 监听 MD 变化自动重建(可选)
npm run build:watch
```

**目录说明**:
- `MarkDown/` → 写作
- `templates/` → 调整 HTML/JS 模板
- `build/categories.mjs` → 改分类元数据、关键词标签
- `css/*.css` → 改样式
- `js/*.js`(除 `data.js`)→ 改客户端行为

**不要手动编辑**:
- `posts/*.html` — 会被 build 覆盖
- `js/data.js` — 会被 build 覆盖
- `rss.xml` / `sitemap.xml` — 会被 build 覆盖
- `index.html` / `about.html` / `404.html` — 会被 build 覆盖

---

## HTML 模板占位符

`templates/post.html` 使用的占位符(由 `build.mjs` 替换):

| 占位符 | 替换为 |
|---|---|
| `{{TITLE}}` | 文章标题 |
| `{{TITLE_SHORT}}` | 短标题(用于面包屑末尾) |
| `{{EXCERPT}}` | 摘要(≤90 字) |
| `{{CATEGORY}}` | 主分类 ID(如 `kubernetes`) |
| `{{CATEGORY_LABEL}}` | 主分类显示名(如 `Kubernetes`) |
| `{{EXTRA_TAGS}}` | 附加标签 HTML 片段 |
| `{{DATE}}` | YYYY-MM-DD |
| `{{READING_TIME}}` | 阅读分钟数 |
| `{{BODY}}` | 渲染后的 HTML 正文 |
| `{{PREV_TITLE}}` / `{{NEXT_TITLE}}` | 上下篇标题 |
| `{{PREV_HREF}}` / `{{NEXT_HREF}}` | `href="..."` 或 `aria-disabled="true"` |
| `{{PREV_DISABLED}}` / `{{NEXT_DISABLED}}` | ` disabled` 或空 |
| `{{RELATED_CARDS}}` | 同分类最新 3 篇的卡片 HTML |

---

## 部署架构

```
git push → main 分支
    ↓
GitHub Actions (.github/workflows/static.yml)
    ↓
  checkout (fetch-depth: 0)
    ↓
  npm ci  (Node 20)
    ↓
  npm run build  (build.mjs)
    ↓
  cloudflare/wrangler-action@v3 → Cloudflare Pages
    ↓
  线上站点更新
```

**关键配置**:
- 部署触发:push 到 `main` 或手动 `workflow_dispatch`
- Cloudflare secrets:`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
- 部署目录:项目根目录(`--project-name sre-note`)
- Node 版本:20.x

---

## Git Commit 规范

| 前缀         | 用途              | 示例                                       |
|------------|-----------------|--------------------------------------------|
| `docs:`    | 新增/更新文章       | `docs: add IP包结构与MTU位置 article`         |
| `feat:`    | 新功能            | `feat: add search functionality`            |
| `fix:`     | 修复             | `fix: correct sidebar count on Go category` |
| `ci:`      | CI/CD 变更       | `ci: update Cloudflare deployment config`   |
| `refactor:`| 重构（非功能变更）    | `refactor: redesign blog card layout`        |
| `style:`   | 样式调整           | `style: adjust card hover effect`           |
| `chore:`   | 杂项(模板/配置)     | `chore: update article template`            |

---

## 禁止事项

- 不要手动编辑 `posts/*.html` / `js/data.js` / `rss.xml` / `sitemap.xml` —— 它们是 build 产物
- 不要删除 `MarkDown/` 中的源文件(除非要下架文章)
- 不要修改 `.github/workflows/static.yml` 除非明确要求
- 不要在 HTML 中用内联样式(除 template 中已有的特殊布局)
- 提交时不要 force push,不要使用 `--no-verify`

---

## 添加新分类示例

假设要加一个 `database` 分类:

1. **编辑 `build/categories.mjs`**:
   ```js
   export const CATEGORIES = [
     // ... 已有分类
     { id: 'database', name: 'Database', desc: '关系型 · NoSQL · 存储引擎' },
   ];
   ```

2. **创建目录并写文章**:
   ```bash
   mkdir MarkDown/database
   echo "# MySQL 索引原理" > MarkDown/database/mysql-index.md
   ```

3. **提交**:
   ```bash
   git add build/categories.mjs MarkDown/database/mysql-index.md
   git commit -m "feat: add database category; docs: add MySQL 索引原理 article"
   git push
   ```

4. **CI 自动处理**:`posts/mysql-索引原理.html` + 首页卡片 + RSS + sitemap 全部自动生成。

---

## 快速参考

### 构建选项

| 命令 | 作用 |
|---|---|
| `npm install` | 安装依赖 |
| `npm run build` | 完整构建一次 |
| `npm run build:watch` | 监听 MarkDown 变化,自动重建 |
| `npm run clean` | 清理所有生成产物 |
| `npm run serve` | 启动本地静态服务器(端口 8080) |
| `npm run preview` | build + serve 一键 |

### 自定义组件速查

| 组件 | 用法 |
|---|---|
| 提示框 | `<div class="highlight-box">...</div>` |
| 卡片 | `<div class="card">...</div>` |
| ASCII 图 | `<div class="flow-diagram">...</div>` |
| 步骤流 | `<div class="flow-steps"><div class="flow-step">**标题**:描述</div></div>` |

### URL slug 规则

- 标题 `Admission Webhook 开发` → slug `Admission-Webhook-开发`
- 标题 `ConfigMap 与 Secret` → slug `ConfigMap-与-Secret`
- 标题 `IP包结构与MTU位置` → slug `IP包结构与MTU位置`(中文保留)
