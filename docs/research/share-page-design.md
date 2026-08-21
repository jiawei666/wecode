# 临时/长文内容分享网页设计研究

> 研究日期：2026-08-21
> 研究范围：临时或长文 Markdown 内容分享页的动态标题、品牌页头页脚、`Powered by` 露出、分享页元信息与安全边界。
> 资料原则：只采用成熟开源项目的官方文档/官方源码，或产品官方文档；外部资料中的事实与本报告的设计推断分开记录。

> 注：第 4 节记录的是本次改动前的源码快照；随后已按本报告的 P0/P1 方案在工作区实现，最终状态以当前源码和测试为准。

## 1. 执行结论

结论先行：wecode 的页面不应该再把自己称为“分析报告页”。它更准确的产品定义是“临时内容分享页”，内容可以是分析、计划、变更摘要、诊断结果、代码、会议纪要或普通长文。

建议采用下面这组稳定的页面分层：

| 层 | 推荐内容 | 是否由正文决定 |
| --- | --- | --- |
| 页面标题 | 动态内容标题，例如“接口故障排查结果” | 是，需有兜底和长度限制 |
| 页面副标题/描述 | 一句话摘要，用于页面说明和社交预览 | 是，可选 |
| 页头品牌行 | `项目名`（可选）与 `wecode` 品牌 | 否，属于页面外壳 |
| 可见主标题 | 与页面标题一致或略短 | 通常是 |
| 页脚 | `Powered by wecode`、临时分享提示、可选生成时间 | 否，属于页面外壳 |
| 访问边界 | 随机路径、内存保存、TTL、必要时撤销 | 否，属于发布器 |
| 搜索策略 | 临时页默认 `noindex`，不进入 sitemap | 否，属于发布器 |

推荐的第一版视觉文案：

```text
页头：项目名                         wecode

     接口故障排查结果
     一句话摘要（如果有）

正文：Markdown 内容

页脚：Powered by wecode · 临时分享页 · 到期后失效
```

这里的“项目名”和“wecode”必须是两个字段：项目名描述内容来自哪个工作项目，`wecode` 描述页面由哪个产品生成。不要把本地绝对路径、Codex thread ID、微信用户标识或内部服务地址当作品牌信息展示。

### 最终确认

这是本次自我拷问后的确认结果：

1. 标题必须动态化，但不能直接把任意正文或路径原样塞进 HTML `<title>`。
2. 页头可以展示项目名，页脚可以稳定展示 `Powered by wecode`；这两者都应低干扰，不应抢正文注意力。
3. 长文分享页应该支持 `title`、`description`、Open Graph 等元信息，但临时页不应为了 SEO 添加 canonical、sitemap 或公开索引。
4. 随机分享链接是“持有链接即可访问”，不是登录鉴权。随机路径、TTL、`no-store` 和 `noindex` 分别解决猜测、生命周期、缓存和搜索发现问题，不能互相替代。
5. Markdown 渲染安全和访问控制是两条独立边界：即使路径不可猜，恶意 HTML 或危险链接仍可能伤害访问者；即使 HTML 已清洗，拿到链接的人仍可能看到正文。

## 2. 研究方法与术语

### 2.1 资料范围

本报告核验了以下一手资料：

- GitHub Pages/Jekyll 官方文档与 GitHub 官方 `github/markup` 源码仓库。
- GitBook 官方文档：页面标题/描述、页头页脚、SEO、公开发布、分享链接和访问控制。
- Read the Docs 官方文档，以及其所使用的 Sphinx/MkDocs 官方配置文档。
- Docusaurus 官方 SEO 与主题配置文档。
- VitePress 官方站点配置、Frontmatter 和页脚文档。
- Cloudflare 官方 Quick Tunnel 文档，用于核对 wecode 的临时公网链接边界。

### 2.2 术语拆分

成熟文档系统往往把下面几个概念分开。把它们混成一个 `title` 字符串，会导致页面标题、浏览器标签、社交卡片和品牌展示互相污染。

| 术语 | 含义 | wecode 需要的处理 |
| --- | --- | --- |
| Content title | 当前内容是什么 | 动态，例如“发布前检查结果” |
| Visible heading | 用户在页面正文顶部看到的标题 | 可以等于 Content title，或做短化 |
| Document title | 浏览器标签中的 `<title>` | `Content title · 项目名 · wecode`，按长度裁剪 |
| Description | 对内容的一句话摘要 | 用于 `<meta name="description">` 和社交预览 |
| Brand | 生成页面的产品身份 | 固定为 `wecode` |
| Project label | 当前 Codex 工作目录/项目的可读名称 | 可选，只展示安全标签，不展示路径 |
| Access token | URL 中用于定位页面的随机片段 | 高熵、不可预测、过期可撤销 |
| Indexing policy | 搜索引擎是否收录 | 临时页默认禁止索引 |

“页面标题”和“搜索索引”也不是同一个问题：标题是帮助人和爬虫理解页面，`noindex` 是告诉合规爬虫不要收录，真正的访问控制仍要由服务端决定。

## 3. 成熟案例研究

### 3.1 GitHub Pages/Jekyll：用 Front Matter 让页面元数据独立于正文

#### 官方事实

GitHub Pages 的 Jekyll 文档说明，Markdown/HTML 文件顶部可以使用 YAML Front Matter 配置页面变量和元数据，例如 `layout`、`title` 和 `permalink`；正文从 Front Matter 之后开始，主题会把这些页面套入默认布局。[GitHub Pages：Adding content using Jekyll](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/adding-content-to-your-github-pages-site-using-jekyll)

GitHub Pages 是把仓库中的 HTML/CSS/JavaScript 发布成网站的静态托管服务，可以使用 `github.io` 域名或自定义域名。[GitHub Pages：What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

GitHub 官方 `github/markup` 源码还明确区分了 Markdown 转 HTML 和 HTML 清洗：该库本身只负责选择底层标记语言转换库，GitHub.com 的后续管线才负责强力清洗危险标签和属性。[GitHub Markup 官方源码说明](https://github.com/github/markup)

GitHub Pages 支持 HTTPS，但官方同时提醒，发布后的网站在互联网上可访问，不应把敏感数据放进站点；HTTPS 只保护传输过程，不改变内容的公开属性。[GitHub Pages：Securing your site with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

#### 可迁移的设计规律

- **事实**：页面级 `title`、布局和 URL 可以由元数据独立声明。
- **事实**：Markdown 转换和安全清洗是两个阶段。
- **推断**：wecode 应在内部把 `title`/`description`/`projectName` 作为页面元数据对象，而不是让模板从正文猜所有信息。
- **推断**：即使 Markdown 已经转换成功，也要保留独立的 HTML 安全策略；不能把“用了 Markdown parser”当作完成了 XSS 防护。
- **边界**：GitHub Pages 是版本化的静态站点，不是一次性临时分享服务；它能证明“元数据和外壳应分离”，不能直接证明 wecode 应把页面持久化到 Git 仓库。

### 3.2 GitBook：最接近“内容、品牌、访问策略”三层分离

#### 官方事实

GitBook 的页面模型包含页面标题、可选描述和页面选项。页面标题会进入目录和 URL slug；页面描述可以作为搜索引擎预览文本。[GitBook 页面内容说明](https://gitbook.com/docs/resources)

GitBook 的 SEO 文档说明，HTML title 和 Open Graph title 由页面标题与空间标题形成，meta description 和 Open Graph description 来自页面描述；公开文档还会生成 sitemap，并使用 canonical URL 处理重复内容。[GitBook：How does GitBook handle SEO?](https://gitbook.com/docs/help-center/published-documentation/publishing/how-does-gitbook-handle-seo)

GitBook 把页头和页脚作为站点布局能力：页头可以放导航链接和按钮，页脚可以放 logo、版权文本和链接。[GitBook：Layout and structure](https://gitbook.com/docs/publishing-documentation/customization/layout-and-structure)

GitBook 的发布受众分为公开发布、分享链接和认证访问。官方文档指出，分享链接只允许持有有效链接的人访问，且不会被搜索引擎索引；但这仍然是“持有链接即可访问”，不是每个访客都必须登录。[GitBook：Public publishing](https://gitbook.com/docs/publishing-documentation/publish-a-docs-site/public-publishing)

GitBook 还支持页面级隐藏、内部搜索索引开关、外部搜索引擎索引开关，以及 canonical/alternate URL；这些能力是“发现策略”，与访问权限分开。[GitBook：Pages](https://gitbook.com/docs/creating-content/content-structure/page)

GitBook 的品牌规则也值得注意：官方支持自定义 logo、颜色、站点标题和页脚，但文档说明不能移除发布文档中的 `Powered by GitBook` 链接。[GitBook：Site customization](https://gitbook.com/docs/publishing-documentation/customization)

#### 可迁移的设计规律

- **事实**：页面标题、描述、页头、页脚和访问受众是不同的产品配置面。
- **事实**：分享链接和搜索引擎索引可以分别控制。
- **事实**：品牌露出可以是页脚中的产品署名，而不是正文标题的一部分。
- **推断**：wecode 可以采用“页头项目名 + 页脚 `Powered by wecode`”的低成本模型；无需把 `wecode` 拼进每一个可见 H1。
- **推断**：临时页应该默认 `noindex`，但产品文案必须明确“链接持有者可访问”，避免把“不收录”误解成“私密”。
- **边界**：GitBook 有成熟的认证访问和平台侧撤销能力；wecode 当前的本地内存页面没有同等身份系统，不能借用 GitBook 的“私有”措辞。

### 3.3 Read the Docs、Sphinx 与 MkDocs：站点级品牌是布局变量，不是正文内容

#### 官方事实

MkDocs 的官方配置文档把 `site_name` 定义为项目文档的主标题，把 `site_url` 用于生成每页的 canonical link，把 `site_description` 生成 HTML head 中的 meta tag，把 `site_author` 生成作者 meta tag，把 `copyright` 交给主题放入文档页面。[MkDocs：Configuration](https://www.mkdocs.org/user-guide/configuration/)

MkDocs 官方主题文档列出了主题模板中的 `htmltitle`、`site_name`、`extrahead`、正文 `content` 和 `footer` 等插槽/变量，并支持通过自定义主题扩展页面外壳。[MkDocs：Customizing a theme](https://www.mkdocs.org/user-guide/customizing-your-theme/)

Read the Docs 通过仓库中的 `.readthedocs.yaml` 固定文档构建环境和配置，使不同版本可以拥有与源代码版本一致的构建设置。[Read the Docs：Configuration file reference](https://docs.readthedocs.com/platform/stable/config-file/v2.html)

Read the Docs 的 SEO 指南建议使用准确、描述性的 HTML `<title>`，并使用可读 URL；文档中提到 Sphinx 的页面标题来自页面首个标题。[Read the Docs：SEO guide](https://docs.readthedocs.com/platform/latest/guides/technical-docs-seo-guide.html)

#### 可迁移的设计规律

- **事实**：站点名、站点描述、作者、版权、logo、favicon、页脚和 head 扩展都属于模板/站点配置层。
- **事实**：canonical URL 只有在页面拥有稳定、权威地址时才有意义。
- **推断**：wecode 临时页可以借用“站点外壳变量”的思想，但不能把固定域名、作者、版本导航等完整文档站能力搬进一次性页面。
- **推断**：当前项目名适合成为 `projectLabel`，而不是强行重写成站点标题；这样标题动态化时仍然保留品牌一致性。
- **边界**：Read the Docs 的版本化文档强调持久 URL 和长期索引；wecode 的临时页强调 TTL 和撤销，生命周期目标相反。

### 3.4 Docusaurus：页面级 SEO 元数据与页脚品牌有明确接口

#### 官方事实

Docusaurus 官方 SEO 文档说明，页面可以通过 Front Matter 提供 `title`、`description`、`image` 和 `keywords`；Docusaurus 会把这些数据用于页面的 title、description、Open Graph 等元信息，并自动添加 canonical URL 等常用 metadata。[Docusaurus：SEO](https://docusaurus.io/docs/seo)

Docusaurus 的主题配置支持全局 `metadata`、`image`、navbar logo/title，以及 footer 的 logo、copyright 和 links；官方示例还直接使用了“Built with Docusaurus”形式的产品署名。[Docusaurus：Theme configuration](https://docusaurus.io/docs/api/themes/configuration/)

Docusaurus 官方明确警告，`robots.txt` 不会阻止 HTML 页面被索引；整站可以用 `noIndex`，单页可以使用 robots meta 标签，sitemap 插件也会过滤带 `noindex` 的页面。[Docusaurus：SEO 中的 Robots 与 Sitemap](https://docusaurus.io/docs/seo)

Docusaurus 是静态站点生成器，每个 URL 路由都会生成静态 HTML，这有利于搜索引擎直接发现内容。[Docusaurus：Static HTML generation](https://docusaurus.io/docs/seo)

#### 可迁移的设计规律

- **事实**：页面内容元数据可以覆盖站点默认值。
- **事实**：页脚可以承担 logo、copyright、links 和构建工具署名。
- **事实**：`robots.txt` 不是访问控制，也不是可靠的“禁止索引”唯一手段。
- **推断**：wecode 应把 `noindex` 放在单页 HTML 的 metadata 中，并同时避免临时页进入 sitemap；不能只依赖 URL 随机性或 `robots.txt`。
- **推断**：可参考 Docusaurus 的“元数据优先于手写重复标签”原则：将 description 作为一个字段，同时生成普通 description 和社交预览所需的描述，而不是让调用方拼 HTML。

### 3.5 VitePress：`titleTemplate` 适合解决“动态内容标题 + 稳定品牌后缀”

#### 官方事实

VitePress 支持每个 Markdown 文件使用 Front Matter；站点配置中的 `title` 可以作为所有页面标题的默认后缀，页面最终标题可以呈现为“页面标题 | 站点标题”。`titleTemplate` 还可以自定义整个后缀，或关闭后缀。[VitePress：Site Config](https://vitepress.dev/reference/site-config)

VitePress 的页面级配置支持 `title`、`description` 和 `head`，其中 `head` 可以注入当前页面的额外 meta/link/script 标签。[VitePress：Frontmatter Config](https://vitepress.dev/reference/frontmatter-config)

VitePress 默认主题支持全局 footer 的 `message` 和 `copyright`，并允许使用内联链接；这些内容可以作为页面外壳，而不是 Markdown 正文的一部分。[VitePress：Footer](https://vitepress.dev/reference/default-theme-footer)

#### 可迁移的设计规律

- **事实**：动态页面标题和稳定站点后缀可以通过模板组合，而不是由内容作者手工重复品牌名。
- **事实**：描述和额外 head 标签支持页面级覆盖。
- **推断**：wecode 可以采用 `内容标题 · 项目名 · wecode` 的标题模板，但应设置长度上限，防止长自然语言任务把浏览器标签撑满。
- **推断**：可见 H1 不一定需要包含完整品牌后缀；浏览器 `<title>`、页头品牌行和页脚署名可以分别承担不同信息。

### 3.6 Cloudflare Quick Tunnel：随机公网地址不等于私密分享

#### 官方事实

Cloudflare 官方把 Quick Tunnel/ TryCloudflare 定位为测试和开发用途。运行 `cloudflared tunnel --url http://localhost:8080` 后，它会生成随机的 `trycloudflare.com` 子域名，并将请求代理到本机 localhost 服务；不需要先把站点加入 Cloudflare DNS。[Cloudflare：Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

Cloudflare 同时说明 Quick Tunnel 不保证 SLA 或 uptime，当前有 200 个 in-flight requests 的硬限制，并且不支持 Server-Sent Events；如果 `.cloudflared` 目录存在 `config.yaml`，Quick Tunnel 当前可能无法工作。[Cloudflare：Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

#### 可迁移的设计规律

- **事实**：Quick Tunnel 的地址是随机公网地址，访问者通过公网 URL 访问本机 localhost 服务。
- **事实**：它适合临时体验和开发，不适合作为正式内容托管或强安全边界。
- **推断**：wecode 应把 Quick Tunnel 称为“临时分享通道”，不要在页面文案中暗示这是 Cloudflare Access 或登录保护。
- **推断**：分享页本身必须做好 bearer link 安全；Tunnel 只负责把本地页面送到公网，不负责判断哪个人有权看哪一页。

## 4. 当前 wecode 实现核对

以下是对当前仓库的事实记录，不是外部案例推断。

| 能力 | 当前实现事实 | 判断 |
| --- | --- | --- |
| 标题入口 | `RenderInput` 已有可选 `title`；没有传入时，`renderResponse` 使用 `Codex 分析报告`、`Codex Diff`、`Codex 输出` 等固定兜底 | 已有动态接口，但语义仍偏向报告/开发工具 |
| 页头 | `renderPageHtml` 固定展示 `CODEX REPORT`，可见副标题固定为“可在手机上阅读的分析报告” | 与“内容不一定是分析报告”冲突 |
| 页脚 | 固定为 `Generated by Codex · 临时分享页` | 有署名，但品牌不是 wecode，且没有项目名/过期提示 |
| HTML `<title>` | 已生成并对标题做 HTML escape | 基础能力存在 |
| 描述/社交元信息 | 当前只生成 charset、viewport、theme-color 和 `<title>`，没有 description、Open Graph、Twitter card、robots 或 canonical | 需要补足，但临时页不应盲目增加 canonical/sitemap |
| Markdown HTML | 自定义 renderer 将原始 HTML 转义；链接和图片通过 `safeHref` 只允许 `http`、`https`、`mailto` 或页面锚点 | 已有基础渲染防护，仍需持续测试属性、外部资源和标题元数据 |
| 页面路径 | 使用 `randomBytes(12)` 生成 24 位十六进制 slug，路由为 `/p/<slug>` | 具备不可预测性，但不是鉴权 |
| 生命周期 | 页面存放在进程内 `Map`，按 `pageTtlMs` 到期清理；进程关闭会清空页面 | 适合临时页，不是持久化分享 |
| 本地监听 | 页面服务器只监听 `127.0.0.1` 的随机端口 | 符合“Tunnel 只暴露页面服务”的边界 |
| 响应缓存 | 页面响应包含 `cache-control: no-store` | 有利于减少中间缓存残留，不能阻止用户复制、截图或转发 |
| 访问鉴权 | 路由通过 slug 查找页面，没有登录/用户身份校验 | 当前语义是 bearer link：拿到链接即可访问 |
| Cloudflare | Quick Tunnel 由 `cloudflared tunnel --url` 启动，返回随机 `trycloudflare.com` 基础地址 | 依赖 Cloudflare 官方的临时开发通道限制 |

对应源码证据：[src/render.ts:12](../../src/render.ts:12)、[src/render.ts:152](../../src/render.ts:152)、[src/render.ts:176](../../src/render.ts:176)、[src/render.ts:263](../../src/render.ts:263)、[src/render.ts:316](../../src/render.ts:316)、[src/render.ts:381](../../src/render.ts:381)。已有安全回归测试见 [test/render.test.ts:74](../../test/render.test.ts:74)。

### 当前实现最明显的产品问题

当前实现的主要问题不是“没有页面外壳”，而是外壳把内容类型写死了：

```text
CODEX REPORT
{动态或固定标题}
可在手机上阅读的分析报告
...
Generated by Codex · 临时分享页
```

因此，即使正文是计划、代码、故障诊断或普通长文，用户仍会看到“分析报告”。这会让标题、页头和页脚都传达错误的内容语义。更合理的外壳应是：

```text
{项目名，可选}                         wecode

{动态内容标题}
{动态摘要，可选}
...
Powered by wecode · 临时分享页 · 到期后失效
```

## 5. 推荐的信息模型与生成规则

以下是设计建议，不是本次要落地的业务代码变更。

### 5.1 建议的页面元数据对象

```ts
interface SharePageMeta {
  /** 用户真正要阅读的内容标题，不带品牌后缀。 */
  title: string;
  /** 一句话摘要，用于 meta description 和分享卡片。 */
  description?: string;
  /** 可读的项目标签，不是绝对路径。 */
  projectName?: string;
  /** 可选的内容类型，仅用于辅助副标题/图标，不决定页面是否叫报告。 */
  kind?: 'analysis' | 'plan' | 'diff' | 'diagnosis' | 'code' | 'note' | 'generic';
  /** 发布时间与到期时间，仅在产品希望向读者展示时输出。 */
  publishedAt?: string;
  expiresAt?: string;
}
```

这个对象的核心价值是把内容语义和页面外壳解耦。`kind` 可以帮助生成 fallback，但不应再把所有长文归类为 `report`。

### 5.2 标题优先级

建议按以下顺序生成 `contentTitle`：

1. 调用方明确传入的标题。
2. 正文第一个有意义的 Markdown H1/H2，去掉 Markdown 标记、HTML 和多余空白。
3. 根据已知任务语义生成短标题，例如“发布前检查结果”“接口故障排查结果”“代码变更摘要”。
4. 最终兜底为“分享内容”。

然后再单独生成浏览器标题：

```text
{contentTitle} · {projectName} · wecode
```

当没有项目名时省略中间段：

```text
{contentTitle} · wecode
```

建议对每个段落做长度上限、Unicode 安全裁剪和 HTML escape；标题不应直接采用用户任务原文、绝对路径或包含大量代码的 H1。

### 5.3 项目名的来源与边界

项目名可以来自当前会话已有的项目标签、用户选择的项目名称或工作目录 basename。无论来源如何，都应遵守：

- 只展示可读标签，不展示 `/home/...`、`C:\Users\...` 等绝对路径。
- 不展示 thread ID、bot ID、微信用户 ID、内部端口、Token 或完整命令行。
- 对项目名做长度限制和 HTML escape。
- 项目名缺失时直接隐藏，不要用“未知项目”制造噪声。
- 如果项目名来自模型生成内容，应先按普通文本处理，不允许它注入 HTML 属性或标签。

### 5.4 页头与页脚的推荐职责

页头只回答两个问题：“这是谁生成的？”和“这篇内容讲什么？”

```text
品牌行：{projectName，可选}                         wecode
主标题：{contentTitle}
副标题：{description，可选}
```

页脚只回答三个问题：“由谁生成？”“这是怎样的链接？”“是否有生命周期？”

```text
Powered by wecode · 临时分享页 · 到期后失效
```

如果要加入项目链接，链接必须来自明确配置或已验证的项目主页，不能从本地路径自动拼 URL。默认不放分析平台、统计脚本、外部广告或会把内容发送给第三方的资源。

## 6. 分享页元信息建议

### 6.1 推荐的最小 head

临时内容页可以使用下面的最小元信息集合：

```html
<meta name="description" content="{安全裁剪后的一句话摘要}">
<meta property="og:title" content="{页面标题}">
<meta property="og:description" content="{页面描述}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="wecode">
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex, nofollow, noarchive">
```

其中：

- `<title>` 是浏览器标签和基础分享预览的标题。
- `description` 只放摘要，不放整篇正文、不放敏感路径、不放 Token。
- `og:*` 用于聊天软件/社交平台预览，标题与描述应与页面语义一致。
- `og:site_name` 只表达产品品牌，不表达本地项目路径。
- `noindex` 是搜索发现策略，不是访问控制。
- `canonical` 对临时随机 URL 通常没有收益；除非内容有明确的稳定权威页面，否则不要生成。
- sitemap 不应包含临时页面。

Docusaurus 官方特别说明 `robots.txt` 不能阻止 HTML 页面被索引，单页应使用 robots meta；这条原则适用于本项目的临时页面。[Docusaurus SEO：Robots 与单页 noindex](https://docusaurus.io/docs/seo)

### 6.2 `og:url` 与随机 URL

`og:url` 可以帮助分享平台识别当前页面，但当前 wecode 的随机 slug 和 Tunnel 基础地址是在发布流程中逐步确定的。因此有两种合理实现：

1. 先取得公网基础地址和 slug，再生成含最终分享 URL 的 HTML。
2. HTML 在请求时生成，将当前请求的规范 URL作为 `og:url`。

这是实现选择，不是本报告要求本次修改。若暂时不生成 `og:url`，不会影响页面正文访问；但不要误用一个固定的 `sharePageBaseUrl` 作为所有页面的 canonical。

### 6.3 预览图与内容泄露

Open Graph 图片可以提高分享卡片的识别度，但临时页面不建议第一版把整篇正文渲染成外部图片：这会增加缓存、生成服务和敏感内容复制链路。若未来增加预览图，建议只使用品牌图或不含正文的通用封面，并保持与 TTL 同步。

## 7. 安全边界

### 7.1 访问控制：临时链接是 bearer link

当前路由只根据随机 slug 查找内存页面，没有用户鉴权。因此准确的产品文案应是：

> 获得链接的人可以访问页面；页面在 TTL 到期或 wecode 进程停止后失效。

不要写成“私密页面”“只有指定人可见”或“Cloudflare 已经保护页面”。如果未来需要真正的私密访问，应增加独立的认证/授权层，而不是只把 slug 变长。

建议保留并验证这些边界：

- 使用密码学安全随机数生成 slug。
- slug 不编码标题、项目名、时间戳、用户 ID 或文件路径。
- 页面只保存在内存，并按 TTL 清理。
- 进程退出时清空页面并终止 Tunnel。
- 本地服务只监听 `127.0.0.1`。
- 只允许精确的 `/p/<slug>` 路由，不提供目录列表、静态文件任意读取或调试接口。
- 返回 `404` 时不要泄露页面是否曾经存在、创建者或内部状态。
- 除 `no-store` 外，可按需要增加 `no-cache`、`Pragma` 等兼容性控制，但缓存策略不能替代 TTL。

### 7.2 搜索与访问是两条线

推荐同时做：

```text
访问边界：随机 slug + TTL + 内存 Map + 可选鉴权
搜索边界：noindex + nofollow + 不生成 sitemap + 不设置 canonical
```

这四类措施各自解决不同问题：

| 措施 | 解决什么 | 不能解决什么 |
| --- | --- | --- |
| 随机 slug | 降低被猜中的概率 | 不能防止链接转发 |
| TTL/撤销 | 限制生命周期 | 不能追回已复制的内容 |
| `Cache-Control: no-store` | 减少浏览器/中间缓存 | 不能阻止截图、复制或爬虫首次读取 |
| `noindex` | 降低搜索引擎收录 | 不能阻止拿到 URL 的人访问 |
| HTTPS/Tunnel | 保护传输并提供公网入口 | 不负责页面身份授权 |
| HTML 清洗 | 降低脚本/XSS 风险 | 不防止内容本身包含秘密 |

### 7.3 Markdown 渲染安全

GitHub 官方源码明确把 Markdown 转换和下游 HTML 清洗拆开。对 wecode 而言，至少应保持：

- 原始 HTML 默认转义或经过严格 sanitize；不允许 `script`、危险 style、事件处理器和任意 iframe。
- URL 只允许明确的安全协议；拒绝 `javascript:`、`data:`（除非有非常明确的白名单用途）和不合法 URL。
- 所有进入 `<title>`、meta content、页头、页脚、HTML 属性的字段都必须 escape。
- 如果外链使用新窗口，使用 `rel="noopener noreferrer"`；不需要新窗口时不要无谓添加 `target="_blank"`。
- 外部图片要注意访问者浏览器会请求第三方 URL，可能造成 IP、Referer 或访问时间泄露；临时敏感页可禁止远程图片，或使用 `referrerpolicy="no-referrer"`。
- 附件正文、代码块、文件名和错误信息都按不可信文本处理；文件名不能改变页面结构。

当前项目已经对原始 HTML 做转义、对链接/图片做协议过滤，并有对应测试；后续扩展动态 header/footer/meta 时，必须给这些字段增加同等级测试。

### 7.4 内容安全：页面公开前的产品提醒

这是与 XSS 不同的“内容保密”问题。分析、诊断和代码输出可能包含：

- API key、Token、Cookie、内网域名和数据库连接信息。
- 本地绝对路径、用户名、项目私有名称和系统环境变量。
- 代码片段中的生产配置、日志中的手机号或业务数据。

因此建议：

1. 用户明确要求“生成分享页”时再发布；如果仅仅因为内容很长自动转页，应在聊天中清楚说明这是公开链接。
2. 分享成功消息里说明“获得链接的人可以访问”。
3. 生成前做轻量敏感信息提示或检测，但不要把检测器当成绝对保证。
4. 若检测到高风险 Token/密钥模式，优先回退聊天或要求用户确认，不要静默公开。
5. 页面过期只意味着当前 URL 不再服务，不意味着已经被复制的文本、截图或第三方缓存自动消失。

这些是基于当前 bearer-link 架构的产品推断，不是 GitBook、GitHub Pages 或 Cloudflare 对 wecode 的承诺。

## 8. 自我拷问：逐项确认设计是否站得住

### 问题一：用户说“分享网页”，是不是默认就是“分析报告”？

不是。当前代码把长内容和报告模式绑定得过紧，页头副标题也写死为分析报告；但成熟系统把页面标题作为页面级元数据，不把所有 Markdown 页面归成一个内容类型。最终应使用“分享内容”作为通用兜底，分析只是一个可选 kind。

### 问题二：标题动态化会不会让页面看起来不稳定、很杂乱？

会，如果把整句用户任务或第一段正文直接作为标题。解决方式不是继续使用固定“分析报告”，而是设置明确的标题优先级、清洗和长度限制，并把品牌放入稳定的 suffix/页脚。动态标题负责语义，模板负责一致性。

### 问题三：项目名应该出现在 `<title>`、H1、页头还是页脚？

推荐：项目名出现在页头品牌行；如果短且有价值，可以作为 `<title>` 的中间段；不强行塞进正文 H1，也不在页脚重复两次。这样用户一眼知道内容属于哪个项目，但搜索/分享标题仍以内容本身为主。

### 问题四：`Powered by wecode` 会不会显得像广告？

页脚低对比度、单行展示即可，不要在正文顶部插大横幅。成熟文档工具普遍把版权、构建工具署名或品牌链接放在页脚；GitBook 甚至将其作为发布文档的固定品牌露出。对 wecode 来说，标准写法是 `Powered by wecode`，而不是 `powerbywecode` 或 `Generated by Codex`。

### 问题五：随机 URL 很长，是不是已经安全了？

没有。随机 URL 主要降低猜测概率；当前没有身份校验，所以它仍然是 bearer link。必须同时强调 TTL、可撤销性、公开链接提示、内容脱敏和渲染安全。

### 问题六：加了 `noindex`，是不是就不用担心泄露？

不用。Docusaurus 官方明确指出 robots.txt 不能阻止页面被索引；更重要的是，`noindex` 针对搜索发现，不是访问授权。必须把 `noindex` 与随机 slug、TTL、`no-store` 和必要的认证分开设计。

### 问题七：为了做 Open Graph，是不是应该生成一张包含正文的分享图片？

第一版不应该。临时页的核心价值是可读正文，正文截图会增加缓存和复制路径，且可能把敏感信息送入图片生成或 CDN。先提供安全裁剪的 title/description；未来再做不含正文的品牌封面。

### 问题八：Quick Tunnel 既然由 Cloudflare 提供，是不是 Cloudflare 负责安全？

不负责页面授权。Cloudflare 官方把 Quick Tunnel定位为测试/开发通道，随机域名只是公网入口，并且没有生产级 SLA。wecode 必须自己负责页面路由、TTL、HTML 清洗和内容提醒。

### 问题九：项目名自动取工作目录 basename 行不行？

可以作为低风险 fallback，但不能把完整路径输出。更优先使用会话已有的项目标签；basename 也要清洗、裁剪，并允许缺省隐藏。项目名不是安全凭证，不能影响 slug 或授权判断。

### 问题十：现在已经有 `no-store`、随机 slug、HTML escape，是不是不需要再做？

这些基础边界是正确的，应保留；但它们只覆盖缓存、猜测和部分渲染风险。当前缺少动态描述/社交元信息，页头页脚还写死为报告/Codex，且访问者不会被明确告知“拿到链接即可访问”。所以应该在现有安全基础上补元数据和产品文案，而不是推翻临时内存页面模型。

## 9. 推荐落地顺序

### P0：先统一语义与公开边界

1. 将页面通用名称确定为“临时分享页/分享内容页”。
2. 删除页头“CODEX REPORT”和“可在手机上阅读的分析报告”这类固定报告语义。
3. 页头使用可选项目名，页脚使用 `Powered by wecode · 临时分享页 · 到期后失效`。
4. 分享成功的聊天文案明确链接持有者可访问、页面会过期。

### P1：补齐动态元数据

1. 引入 `SharePageMeta` 语义对象。
2. 按明确优先级生成动态标题，提供 `分享内容` 兜底。
3. 增加安全裁剪的 `description`、`og:title`、`og:description`、`og:site_name` 和 `twitter:card`。
4. 临时页增加 `noindex`/`nofollow`，不生成 canonical 和 sitemap。
5. 对 title、projectName、description 和所有 meta 属性增加恶意输入测试。

### P1：补强内容安全回归

1. 保持原始 HTML 转义和危险协议过滤。
2. 增加事件属性、`data:` URL、外部图片、恶意 title/description、超长 Unicode 标题的测试。
3. 限制页面正文和附件大小，避免把本地大量文件变成公网页面。
4. 对高风险密钥模式给出发布前提醒或回退策略。

### P2：再考虑增强分享体验

1. 生成不含正文的品牌 Open Graph 封面。
2. 增加显式撤销某个分享页的能力。
3. 需要真正私密分享时再引入认证/一次性访问凭证，不把随机 slug 继续堆长当成权限系统。
4. 需要长期稳定地址时，再考虑配置域名/正式 Cloudflare Tunnel；Quick Tunnel继续定位为临时开发能力。

## 10. 参考资料（全部为一手资料）

### GitHub

- [GitHub Pages：Adding content using Jekyll](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/adding-content-to-your-github-pages-site-using-jekyll)
- [GitHub Pages：What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages：Securing your site with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- [GitHub Markup 官方源码仓库](https://github.com/github/markup)

### GitBook

- [GitBook：Page title and description](https://gitbook.com/docs/resources)
- [GitBook：How does GitBook handle SEO?](https://gitbook.com/docs/help-center/published-documentation/publishing/how-does-gitbook-handle-seo)
- [GitBook：Layout and structure](https://gitbook.com/docs/publishing-documentation/customization/layout-and-structure)
- [GitBook：Public publishing](https://gitbook.com/docs/publishing-documentation/publish-a-docs-site/public-publishing)
- [GitBook：Pages](https://gitbook.com/docs/creating-content/content-structure/page)
- [GitBook：Site customization](https://gitbook.com/docs/publishing-documentation/customization)

### Read the Docs、Sphinx 与 MkDocs

- [Read the Docs：Configuration file reference](https://docs.readthedocs.com/platform/stable/config-file/v2.html)
- [Read the Docs：SEO guide](https://docs.readthedocs.com/platform/latest/guides/technical-docs-seo-guide.html)
- [MkDocs：Configuration](https://www.mkdocs.org/user-guide/configuration/)
- [MkDocs：Customizing a theme](https://www.mkdocs.org/user-guide/customizing-your-theme/)

### Docusaurus 与 VitePress

- [Docusaurus：SEO](https://docusaurus.io/docs/seo)
- [Docusaurus：Theme configuration](https://docusaurus.io/docs/api/themes/configuration/)
- [VitePress：Site Config](https://vitepress.dev/reference/site-config)
- [VitePress：Frontmatter Config](https://vitepress.dev/reference/frontmatter-config)
- [VitePress：Footer](https://vitepress.dev/reference/default-theme-footer)

### 公网临时分享通道

- [Cloudflare：Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## 11. 研究边界

本报告没有修改业务代码、README、`package.json`、`package-lock.json`、版本号、Git tag 或远端仓库，也没有把建议当作已经实现的功能。后续如果进入实现阶段，应以本报告的“推荐信息模型”和“安全边界”作为验收标准，而不是直接照抄某个文档平台的完整站点方案。
