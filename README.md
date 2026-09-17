# IDENTIFY 2.0 · 网页资源识别与按类型原尺寸导出

> 需求对应：**① 输入网站链接进行解析 → ② 识别出的文件可按类型导出，并保持原大小**
> 风格：**深色扫描台**——雷达点阵背景、动能排版、流式解析日志，摒弃传统网站布局。

零依赖的本地解析控制台：只用 Node 内置模块（http / https / zlib / crypto / fs），无需 `npm install`。
粘贴一个网址，它会抓取并解析页面、递归外链样式表、按扫描策略筛掉界面装饰与技术资源，
只对**真正的内容资源**发起探测并读取真实字节与元数据（像素尺寸、时长、页数、文档标题、
音频标签、字体度量、HLS·DASH 档位、MIME、魔数签名），再让你按类型勾选并打包导出。

## 快速开始

```bash
node -v            # 需要 >= 18.17（使用内置 fetch）
npm start          # 自动生成样本资源并启动 → http://127.0.0.1:4620
```

打开后点命令台下方的 **本机样本页** 芯片，即可走一遍完整的识别与导出流程。
样本页 `/samples/lab` 是一个刻意做难的标本：srcset、懒加载 data-src、内联 style、
`@import` 二级 CSS、`font-face`、`noscript`、脚本内 JSON 裸链接、data URI、失效链接、
跨站视频、精灵图、无扩展名图片、HLS/DASH 清单、带标签的 PDF/MP3/TTF 一应俱全；
页面上还专门立了 6 个「界面框架」标本——`<header>` 站头大图与 logo、`<nav>` 菜单图标、
`<aside>` 侧栏推广、`.share-links` 推广条、`<footer>` 页脚徽章（其中页眉 logo 同时被正文引用一次，
用来验证「多处引用按最高者优先」的救援规则）；
另有 `/samples/base-path` 专测 `<base href>` 与 JSON 化 data 属性。

```bash
PORT=5000 npm start        # 换端口
npm run dev                # --watch 热重启
npm run samples            # 重新生成 public/samples
node scripts/selftest.mjs  # 离线自检（解析 / 分类 / 策略 / 区域 / 元数据 / ZIP / 选择逻辑，271 条断言）
```

## 扫描策略：哪些东西不去扫描

**界面装饰与技术资源默认不扫描、不下载、不导出**，页面框架（页眉 / 导航 / 页脚）也默认不算内容，
三把开关在命令台上随时可开：

| 开关 | 覆盖类别 | 默认 |
| --- | --- | --- |
| UI 图标 | `icon`（favicon、apple-touch-icon、mask-icon、雪碧图、表情 / 徽章 / 默认头像、界面小图） | 关 |
| 技术资源 | `font` `stylesheet` `script` `data` `page` `other`（字体、样式表、脚本与 source map、JSON / XML / 字幕 / manifest、站内页面） | 关 |
| 扫描范围 | `region`（页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件里的引用，详见下节） | 默认**只扫描主体内容区**，勾选「扫描页眉 / 导航 / 页脚」可放开 |

排除发生在两个阶段，**阶段一完全不产生网络请求**：

1. **解析阶段（preFilter）**——只看地址与上下文：位于非内容区（见下节）；类别是图标 / 字体 / 样式表 / 脚本 / 数据；
   路径含图标关键字或图标目录（`/icons/`、`favicon`、`sprite`、`arrow-16`…）；
   1×1 / `spacer` / `beacon` / `pixel` 之类命名；打点域名（doubleclick、bat.bing、
   google-analytics…）；CSS `mask-image` / `border-image` / `list-style-image` / `cursor` 属性；
   `.tab-icon`、`#logo`、`.avatar` 这类选择器；`background-position` 偏移定位的雪碧图；
   图片服务声明的短边 ≤ 64px；极小的内联 data URI。
2. **探测阶段（postFilter）**——拿到真实字节后复核：真实尺寸 ≤ 64px 判图标、1×1 判占位像素、
   ICO / ICNS 多尺寸图标集、SVG 是「图标字形」还是插画（有 `<text>` / 滤镜 / 内嵌图 / 大面积即保留）、
   精灵图与 symbol 集合、以及打点响应。

### 只扫描主体内容区（页眉 / 导航 / 页脚不算内容）

命令台的第三把开关默认「只扫描主体内容区」。判定时不猜像素、不看截图，而是**沿 DOM 祖先链走一遍**：
`server/region.mjs` 给每个元素算一个区域状态 `{ zone, kind }`，`zone` 三档——`main`（确定在正文里）、
`content`（未定性，默认照样扫描）、`noise`（在主体内容区之外）。结论同时写到资源引用与文案块上，
预览层用同一份代码（`public/js/pv-match.js` 逐字镜像）在浏览器里把区域框画出来，自检里比对两边一致。

判据按强弱排：

* **语义地标（强）**：`<header>` `<nav>` `<aside>` `<footer>` 与 `role=banner|navigation|search|form|complementary|contentinfo|…`
  → 非内容区；`<main>` `role=main` `<article>` → 正文。命名线索（`#content` `.prose` `.entry-body`…）只把元素升为**正文**，
  绝不把正文外的东西拉回正文，也不把正文压成噪音。
* **容器命名（弱）**：`globalnav` `subnav` `mainmenu` `masthead` `sitefooter` `sidebar` `cookie-consent` `share` `social`
  `search-box` `back-to-top` `install-banner`… 共 6 类词表，外加**粘连词根**（`globalnav`、`sitefooter`、`mainmenu` 这类
  糊成一个词的写法也认）。这类结论标成「按命名推断」，界面上用琥珀色虚线区分。
* **从属片段豁免**：`.card-header` `.content-footer` `.post-entry-header` 先剥掉再判，所以卡片自己的抬头 / 落款
  仍算正文；`<article>` `<section>` `<li>` 里的 `<header>` 同理不算页眉（`<main>` 是正文根、不算章节，
  因此「整页套在 `<main>` 里」的站点照样能认出页脚）。

三条防误伤规则：

1. **同一地址多处引用取最高**：某个图标既在导航里出现、又在正文里出现 → 保留，并在清单里注明「也被非内容区引用」。
2. **页面级引用不做区域判定**：外链样式表（CSS 规则与元素位置无关）、`<script>` 里的 JSON 数据岛、
   正文散落的裸地址——它们本就不属于任何一个 DOM 区域（内联 `<style>` 例外，它跟着所在元素的位置走）。
3. **命名推断区里的内容线索仍放行**：只凭 class 猜出来的挂件 / 分享区里，`a[download]` 下载链接与
   `video / audio / source / picture / iframe` 等媒体标签不裁——必应首页的当日壁纸原图就挂在 `ul.share` 里，
   靠这条不被误杀。语义地标判定的区域不享受此例外。

被区域规则排除的条目走 `reason: region`，明细里写「位于页脚，在主体内容区之外」，
日志与导出清单同步给出区域统计；关掉开关即全部恢复（数量、顺序、原尺寸都不变）。

**内容线索救援**：类别判不动但地址带内容味道的（`<video src>`、`background: url(...)`、
`/api/media?id=42`、`?w=1600` 这类处理参数、`/news/` 目录…）仍然会被探测，
**以魔数为准**纠正类型、MIME 与扩展名——样本页里的 `feature-image-no-extension`
（一个 640×400 的 PNG，地址无扩展名）就是靠这条规则被捞回来的，界面上标「按内容补探测」。

被排除的项不会消失：右侧「扫描策略」面板按理由汇总（合计排除 N 项、其中 M 项在发起请求前就被识别），
明细最多展示若干条（按理由限量），并给出体积；`_manifest.json` / README.txt 同样记录排除明细。

> 注意：**样式表仍然会被读取与解析**（否则拿不到 `url()` 与 `@font-face` 里的图片），
> 只是不作为资源导出。

## 它能识别什么

| 类别 | 来源 |
| --- | --- |
| 图片 / 矢量 | `img[src]`、`srcset`（含多密度候选）、`picture/source`、`poster`、`og:image`、`image-set()`、`data-src` 等懒加载属性、内联 `style`、CSS `url()`、`link rel=icon`、`data:` URI；解析 PNG / JPEG(+EXIF) / GIF / WebP(含动图 ANIM·ANMF) / BMP / TIFF / PSD / QOI / DDS / EXR / PNM / TGA / AVIF / HEIF / SVG / ICO / ICNS |
| 视音频 | `video` / `audio` / `source` / `track`；ISO-BMFF（mp4/mov/m4a：mvhd+tkhd+stsd+elst+矩阵旋转、faststart、轨道与编解码四字符码）、Matroska/WebM（EBML Unicode 标签、时长、轨道、编解码、写入器）、FLV+AMF0 元数据、AVI RIFF（strf/strh）、IDL3v2.2/2.3/2.4 + ID3v1 + MPEG 帧遍历（时长 / 码率 / CBR / 采样率 / 声道 / 标题 / 艺人 / 专辑 / 年份 / 流派）、OGG（granule 时长）、WAV（含扩展 fmt / fact）、AIFF、FLAC |
| 清单 / 流媒体 | HLS（`EXT-X-STREAM-INF` 档位、分辨率、码率、音频 / 字幕组、语言、START、ENDLIST → 是否直播、分片时长与序号）与 DASH（Period / AdaptationSet / Representation、模板展开、时长、自适应、加密） |
| 文档 / 表格 / 压缩包 | `a[href]` 与 `a[download]`：PDF（页数、页面尺寸、信息字典——**字面串与 `<FEFF…>` 十六进制 UTF-16BE 都读**、表单、线性化）、DOCX / PPTX / XLSX / ODF / EPUB（ZIP 中央目录 + 解压 `core.xml` / `app.xml` 取标题、作者、字数、幻灯片 / 表格 / 条目数）、RTF、CSV / TSV、纯文本与 Markdown |
| 字体 | 外链 CSS 中的 `@font-face` src（含 Google Fonts 的 unicode-range 子集）；打开开关后解析 sfnt / WOFF / WOFF2 表目录：字形数、unitsPerEm、包围盒、字重 / 宽度分级、fsType 嵌入许可、name 表（家族 / 样式 / 完整版 / 版权 / 许可 / 设计师 / 厂商 / 识别符）、OS/2 覆盖区间、post italicAngle、是否为图标字体（ cmap 落在 PUA / 家族名含 icon） |
| 文字 | 标题层级、正文、引用、列表项、表格单元格、链接文案；带标签、行号、字数、**逐段原文预览**，并区分**正文区与噪音区（导航 / 页脚）** |
| 隐藏引用 | 内联 `script` 的 JSON 与裸链接、`noscript` 内的标签、`data-*` 里的 JSON 串、`<base href>` 参与相对地址解析，标记为「推断」 |
| 地址语义 | 20+ 图片服务与 CDN 的写法：`?w=&h=&q=&fm=`、`=s2000-c`、`w_800,h_600`、`@900w`、`/800px-`、`:large`、`_b`、`cdn-cgi/image/…`、`x-oss-process` / `imageMogr2`、`_400x400q90`、`_next/image?url=`（还原内层原图）、`wp.com` / `weserv` 代理，以及 shields 徽章 / twemoji / gravatar 等界面用途 |

失效地址（404 / 403 / DNS / 超时）**不会被丢弃**，而是以“不可达”状态列出并可单独重试
（`POST /api/reprobe`）——它们同样是页面资源事实的一部分。

## 原尺寸导出

压缩包里的每个文件，都是目标站点返回的**原始字节流**：不缩放、不重编码、不改容器。
服务端直接从磁盘字节缓存（`.cache`）取出原始响应写入 ZIP；deflate 只作用于 ZIP 传输层，
解包后字节完全一致（自检与验收都用 md5 比对通过）。

```text
IDENTIFY-<host>-<范围>-<时间戳>.zip
├── README.txt              来源、范围、合计体积、类型分布、扫描区域与区域统计、扫描策略排除明细、保真声明
├── 图片/001-xxx.png        按类型中文名分目录，001- 前缀保留页面出现顺序；扩展名按魔数纠正
├── 音频/014-chime.wav
├── 字体/…  文档/…  压缩包/…  视频/…
├── _manifest.json          每项：path name url type mime bytes reportedBytes 宽高 时长 签名 + 全部深度元数据
│                           另含 `zone`（主体内容区 / 非内容区（页脚·按命名推断）/ 未定性）与 `zoneAlso`
├── _资源清单.csv           30 列中文表头，UTF-8 BOM + CRLF，Excel 可直接打开
└── _文案/正文.md  文案.csv  文案.json
```

CSV 列：序号 / 类型 / 文件名 / 体积(字节) / 宽 / 高 / 时长(秒) / 页数 / 页面尺寸 / 文档标题 /
作者·艺人 / 专辑 / 年份 / 流派 / 采样率 / 声道 / 帧率 / 编解码 / 播放列表 / 字体 / 相机 /
精灵图 / 声明尺寸 / 声明来源 / 地址后缀修正 / 识别格式 / **所在区域** / **也被非内容区引用** / MIME / 原始 URL。

文案导出（`_文案/正文.md`、`文案.csv`、`文案.json`）同样带区域标注：段落级写明「正文区」或「导航菜单」，
默认导出的 `_文案/正文.md` 只收正文区与未定性段落，页面框架文字另存一份 `_文案/正文外.md` 备查。

`bytes` 是实际写入的字节数，`reportedBytes` 是探测时 `Content-Length` 或 HEAD 得到的值，
两者不一致会在 manifest 中暴露。校验示例：

```bash
unzip -t out.zip            # macOS 自带 unzip 不认 UTF-8 文件名，建议用「归档工具」或 ditto -x -k
md5  图片/001-aurora.png
curl -sI https://host/aurora.png | grep -i content-length   # 三者应完全相等
```

前端导出走 `fetch` + `ReadableStream`，进度遮罩显示**真实已写入字节数**，完成后交给浏览器保存。

## 界面与交互

* **雷达扫描台**：全屏 canvas 点阵随光标呼吸，扫描过程中每个被识别的资源实时生成一个星座节点。
* **命令台**：地址输入 + 深度解析 / 采纳推断地址 / **UI 图标** / **技术资源** / **扫描页眉·导航·页脚** / 站内顺带扫描页数开关；
  五个开关的状态记在 localStorage 里，下次打开自动还原；
  按钮带进度态，准星显示百分比，下方实时滚动解析日志与四个计数器。
* **类型光谱**：左侧按类型统计数量与体积（动画条 + 体积饼带），点击即筛选；主机维度同样可点。
* **展台**：网格 / 列表双视图、关键字搜索（也搜文档标题 / 艺人 / 字体家族 / 播放列表等元数据）、
  出现顺序 / 体积 / 像素 / 类型排序、只看已选、隐藏失效；
  卡片磁吸倾斜、FLIP 重排、图片懒加载、音频波形示意、视频悬停播放（走 `/api/proxy` 的 Range 分段）、
  悬停卡片右下角浮出 **⇧ 连选** 提示，勾选框的 title 写明「按住 Shift 点击可从上次位置连续多选」；
  关掉「只扫描主体内容区」后，位于页眉 / 导航 / 页脚的卡片会去饱和并打上「页脚 · 内容区外」角标
  （按命名推断的区域用琥珀色虚线角标），详情抽屉里多一行「扫描区域」说明判定依据；
  字体样本进入视口才加载；缩略图角标显示页数、流媒体档位、字体家族、相机型号与「按内容补探测」。
* **详情抽屉**：每个资源一张元数据表，按 EXIF / 视音频 / 文档 / 清单 / 字体 / 解析来源分组，
  深色下保证正文对比度；文字条目同样可展开原文预览与逐条复制。
* **文字页**：标题骨架、关键词条、段落卡片（字数 / 行号 / 噪音标记 / 一键复制 / **区域小标**：「正文区」或「导航菜单」），
  可整段或按选中导出 md / txt / csv / json / html。
* **⇧ 连续多选**：所有可选面（展台卡片、文字行、页面预览里的叠加框）共用 `store.js` 的 `pickSelection()`——
  普通点击切换勾选并记下**锚点**；按住 Shift 点击则把「锚点 → 当前项」这一段**只加不减**地并入选区，锚点不动，
  所以可以连续往两个方向拉长区间。所谓「连续」按**当前视图顺序**算：筛选 / 排序改变后区间随之改变，
  锚点若已不在当前视图里则自动退化为普通切换（不会误选半站）。图片条目与文字段落各记各的锚点，互不干扰；
  提示条会写明「Shift 连续多选 · 区间 N 项（新增 M）」。
* **导出坞**：底部浮层显示已选数量与体积，支持当前类型、已选全部、逐类型、整站，以及附带文案。
* **展台 / 页面预览双形态**：同一份扫描结果，既能以卡片展台浏览，也能贴回原始页面快照上点选（见下节）。
* **深色可读性**：文字三档 `--ink` #f4f8fd / `--muted` #bcc9d8 / `--dim` #9aa9bd，在半透明面板合成底色
  上实测 17.9:1 / 11.4:1 / 8.0:1，全部越过 WCAG AAA（7:1）—— 此前最弱一档只有 4.9:1，是「字太浅」的主因；
  面板与分隔线同步加厚，界面上 9~10.5px 的等宽微标签整体抬到 11~11.5px 下限，只有水印式装饰字仍走低对比。
* 动效遵循 `prefers-reduced-motion`；自定义光标在触屏设备自动关闭。

快捷键：`/` 搜索、`a` 全选当前视图、`e` 导出、`g` 切换视图、`x` 清空选择、`p` 展台 ↔ 页面预览、`Esc` 关闭；
选择修饰键：`⇧ Shift + 点击` 连续多选（区间）、`⇧ + 拖框` 叠加已有选择、`⌥/Alt + 点击` 打开详情。
URL 参数：`/?url=https://…` 直接开扫，`/?job=ID` 载入历史结果，`/?job=ID&type=font` 定位到某类，
`&stage=preview` 一进来就落在页面预览上。

## 页面预览与实时框选/勾选导出

支持**输入网址直接打开对应页面**，在原始页面版式中通过**框选**或**勾选**交互选择元素并导出。
命令台提供「打开页面」与「开始扫描」双入口，工具条支持「展台 / 页面预览」随时切换（快捷键 `p`），
页面预览叠加层与展台卡片、底部导出坞状态实时同步。

* **输入网址一键直达**：输入任意网址后点击「打开页面」，即可直接加载目标页面的安全静态快照并高亮定位所有可提取的元素。
* **页面中勾选元素**：每个元素框右上角均配有显式勾选按钮（`✓`），悬停即现、点击即选；支持 `⇧ Shift + 点击` 连续区间多选。
* **页面中框选元素**：支持点击工具栏「⬚ 框选模式 (M)」或直接在页面空白区域拖动鼠标拉出选框，实时计算选区内元素数量与体积，放开即可完成框选；按住 `⇧ Shift` 拖动为**叠加选区**，按住 `⌥ Alt` 拖动为**减去选区**。
* **快捷工具切换**：快捷键 `V` 切换至点选/勾选模式，`M` 切换至框选模式，`E` 一键导出已选元素。
* **一键导出选区**：预览底栏与导出坞实时呈现已选资源大小、数量与类型统计，点击「导出所选 ↓」即可一键将选中的图片、视音频、文档等打包为 byte-exact 原始尺寸 ZIP 压缩包。

**快照怎么来的**：扫描时把页面原始字节按 `地址 + #doc` 另存进 `.cache`（`server/preview.mjs`），
预览时读出来改写成一份静态快照，经 `/api/preview?job=…&page=…` 以同源返回。只做减法、不改版式 ——
站点自己的 CSS、颜色、字体、间距原样保留，所以「预览」是页面本来的样子，不是我们重画的样子。

* 剥掉：`<script>`、`<iframe>`、`<frame>`、`<object>`、`<embed>`、`<noscript>`、`<base>`、重复的 `charset` meta、
  `http-equiv`（CSP / 定时刷新）、`rel=manifest|prefetch|preload|icon…` 的 link
* 注入：唯一一份 `<base href>`（页面最终地址）、`meta[name=referrer]=no-referrer`、robots noindex、来源与截断标记，
  以及一小段补丁样式（禁 `scroll-behavior:smooth`、给加载失败的 `<img>` 留替代文字位）
* 双保险：响应头 `Content-Security-Policy: script-src 'none'; …`，前端 `<iframe sandbox="allow-same-origin">` 不给
  `allow-scripts` —— 内联 `on*` 处理器同样失效；保留同源是为了外层能读 DOM 画叠加框
* `page` 参数只能取本次扫描记录过的页面（`/api/preview/pages` 给清单），陌生地址一律 403；
  PDF / 图片 / 视音频类文档按原始字节直出，交给浏览器自己渲染
* 快照里加载失败的图与样式表，自动改走 `/api/proxy`（带目标站 Referer）重试一次 —— 防盗链站点也能看全

**在快照上选择**：资源条目由 `public/js/pv-match.js` 按与解析器相同的地址口径映射回 DOM 元素，三级兜底：
标签属性（含懒加载 `data-*`、srcset、内联 style 的 url()）→ 计算样式（background / border-image / mask /
list-style / cursor，含 `::before`、`::after`）→ 解析器记下的 CSS 选择器。所以样本页 30 项资源里 28 项可点，
剩下 2 项是「只出现在 JSON 数据岛、页面上本就没有位置」的推断条目；56 段文案 56 段可点（36 处资源标记 + 56 处文案标记）。
映射不上会在底栏写明原因，不会静默消失。

* **点框即选**，`⌥/Alt + 点` 打开该条详情，`⇧ + 点` 从上次点过的框连续多选（框序 = 页面上出现的先后顺序）；
  同一地址多处引用 → 多个框（点一个即选中这一条）
* **区域框选**：按住拖一块矩形，落点 ≥40% 在框内的条目入选（虚线框 = 被排除项，暗色 = 当前筛选下不可见，
  按住 ⇧ 拖动为叠加）
* **标注非扫描区**：工具条开关（默认开）用琥珀色斜纹带框出页眉 / 导航菜单 / 侧栏 / 推广条 / 页脚，
  绿色带标出识别到的主体内容区，带宽上写明区域名；只凭命名推断的区域是**点线**边框并附「（按命名推断）」。
  这些框由预览层用 `pv-match.js` 里那份与后端逐字一致的区域代码实时算出，底栏同时列出各区域计数与
  「正文外已排除 N」——看到被误判的区域，就能立刻判断该不该把开关打开。
* **文案块模式**：切到 ¶ 后同样能框选，直接导出这一区文案的 md / csv / json / txt / html
* 视口宽度（1920→390）与缩放（适配 / 100% / 75% / 50%，或 `⌘ + 滚轮`）可调，整页高度自动撑到 16000px 上限；
  「重算位置」应对懒布局与字体回流
* 「在展台查看」把这一区的选中项带回卡片视图，「导出这一区 ↓」走 `/api/bundle` 打原文件 ZIP

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/scan` | 入参 url / deep / infer / **includeIcons** / **includeTech** / **mainOnly**（默认 true，只扫描主体内容区）/ crawlPages / maxResources，返回 job |
| GET | `/api/jobs` 与 `/api/jobs/:id` | 任务列表 / 完整快照（含 result） |
| GET | `/api/jobs/:id/events` | SSE：status log meta（含 `regions` 区域计数）item progress done reopen，支持 Last-Event-ID 续传 |
| GET | `/api/proxy?url=&name=&download=` | 原始字节代理，**支持 Range/206**，响应头 x-original-size |
| GET | `/api/inline?job=&id=&download=` | 取回 data URI 解码后的原文件 |
| POST | `/api/reprobe` | 按 ids 或 urls 重试不可达项 |
| POST | `/api/bundle` | ids / scope:type+types / scope:all + label + withText + textIds → 流式 ZIP |
| POST | `/api/export` | job + format(md/txt/csv/json/html) + 可选 ids → 文案文件 |
| GET | `/api/preview?job=&page=` | 该页的无脚本静态快照（同源 + `script-src 'none'`；非 HTML 文档按原字节直出） |
| GET | `/api/preview/pages?job=` | 可预览页面清单（主页面恒在首位）与留档状态 |
| POST | `/api/cache/purge` | 清空字节缓存 |
| GET | `/api/health` | 存活与任务数 |

## 缓存与隐私

* 抓取结果写入项目内 `.cache/`（SHA1 命名，24 小时 TTL）；重复扫描与导出直接命中本地字节，
  因此二次扫描常在一秒内完成，导出近乎瞬时。**重新生成样本后请先 `rm -rf .cache` 或调 purge 接口。**
* 服务只监听 `127.0.0.1`，不与任何第三方通信；请求直发目标站点，携带目标站自身的
  Referer 与常见浏览器 UA。请自行确认目标站点访问条款，仅解析你有权抓取的内容。
* 页面原文另按 `地址 + #doc` 存一份（24h TTL 同样生效），供「页面预览」复原快照；预览只在同源下读这份留档，
  不会替你向第三方再发一次页面请求（补抓仅发生在留档缺失时）。
* 解析器不执行 JavaScript，纯客户端渲染的站点可用「站内顺带扫描」与脚本地址推断兜底；
  若目标不可达，条目会以对应状态保留在结果里而不是消失。

## 目录结构

```text
server/   config.mjs  mime.mjs  net.mjs  urlmeta.mjs  region.mjs  policy.mjs  probe.mjs  containers.mjs
          docmeta.mjs  lazy-attrs.mjs  extract.mjs  preview.mjs  scan.mjs  zip.mjs  index.mjs
public/   index.html  css/(base|console|results|preview).css
          js/(app|store|views|api|radar|fx|util|preview|pv-match).js  samples/
scripts/  make-samples.mjs  selftest.mjs  inspect-job.mjs
```

* `extract.mjs` —— 手写容错 HTML 解析（隐式闭合、srcset、CSS url / @import、image-set 的 url() 与裸字符串两种写法、data URI（方案名大小写不敏感）、行号定位、文案分区）
* `preview.mjs` —— 页面原文留档与无脚本快照：剥离可执行 / 会外联的标签，注入唯一一份 `<base href>`、
  no-referrer 与一小段补丁样式；非 HTML 文档按原字节直出
* `region.mjs` —— 扫描区域判定的唯一实现：语义地标（标签 / ARIA role）、6 类容器命名 + 粘连词根、从属抬头剥离、
  章节与正文护栏，输出 `main / content / noise` 三态与 `soft`（仅凭命名）标记；`mergeZone()` 负责同一地址多处引用时按最高者保留
* `pv-match.js` —— 浏览器侧的「地址 / 文案 / 区域口径镜像」：与 `extract.mjs` 共用同一张懒加载属性表、srcset 切分与
  文本归一口径，并**逐字复制** `region.mjs` 的区域规则（自检按源码正则表与祖先链结果双向比对），防止两边漂移
* `policy.mjs` —— 扫描策略：preFilter（零请求）+ postFilter（真实字节复核）+ 内容线索救援 + 排除明细限量与摘要
* `urlmeta.mjs` —— 地址语义：20+ 图片服务 / CDN 参数、内层原图还原、徽章 / 表情 / 头像识别
* `probe.mjs` —— 魔数与图像 / 视音频容器元数据（全部大端 / 小端按规范读取，扩展名与 MIME 以魔数为准）
* `containers.mjs` —— 字体表目录（sfnt / WOFF / WOFF2）、ICO / ICNS 图标集、DDS / EXR / PNM / TGA / QOI
* `docmeta.mjs` —— PDF 信息字典与页面尺寸、OOXML / ODF / EPUB、HLS 与 DASH 清单
* `scan.mjs` —— 任务引擎：抓取 → 解析 → 递归 CSS → 站内顺带扫描 → 策略过滤 → 6 路并发探测（75s 预算）→ 深度容器解析 → 归并统计
* `zip.mjs` —— 流式 ZIP 写入器（UTF-8 文件名标志、crc32 表、deflate 与 store 回退、目录项）

## 验收基线

默认「只扫描主体内容区」（下表「保留 / 排除」为 `mainOnly=true`；关掉开关后样本页为 30 / 114）：

| 目标 | 保留 | 排除 | 区域判定 | 说明 |
| --- | --- | --- | --- | --- |
| `/samples/lab` | 24 | 120 | 引用 正文 29 · 未定性 5 · 正文外 6；文案 正文 54 / 正文外 2 | 6 项按区域排除（页脚 1、页眉 2、导航 1、侧栏 1、推广 1），≥600px 长边内容图从 12 张收敛到 7 张；1 项由内容线索救回 |
| `https://www.apple.com/` | 255 | 309 | 引用 正文 256 · 未定性 127 · 正文外 3；文案 正文 40 / 正文外 104 | 字体 144、页面 107、图标 35、脚本 12、样式表 9、像素 2；153 项 ≥600px 内容图完整保留；两种扫描范围结果一致（导航 / 页脚图标都在**外链 CSS** 里，按设计不做区域判定），但正文外文案精准命中 87 条导航 + 17 条页脚免责 |
| `https://www.bing.com/` | 5 | 99 | 引用 未定性 76 · 正文外 3；文案 正文外 17 | 1920×1200 / 1366×768 两张当日壁纸**照常保留**——它们挂在 `ul.share` 里，靠「命名推断区 + `a[download]` 例外」不被误杀；搜索框、麦克风、菜单、关闭等按钮图标按选择器 / 真实尺寸排除 |

预览侧基线（无头 Chrome 实跑，非自检覆盖）：`/samples/lab` 的 30 项资源有 28 项、56 段文案全部能定位回元素，
36 处资源标记 + 56 处文案标记与元素矩形逐像素吻合；区域框选 → 导出 ZIP、区域文案 → md 均在浏览器里跑通。
**区域标注**：预览里画出 6 条区域带（页眉 1440×1222、导航菜单、侧栏、推广条（点线框 +「按命名推断」）、页脚、绿色正文带）。
**Shift 连选**：展台卡片点第 3 张 + ⇧ 点第 9 张 → 选中 7 项；预览叠加层 ⇧ 点选 → 区间 18 项；
文案模式 ⇧ 点选 → 区间 10 段，提示条均正确显示「Shift 连续多选 · 区间 N 项（新增 M）」。
自检 `node scripts/selftest.mjs` 共 271 条断言，含预览净化（剥脚本 / 单一 `<base>` / 去 `http-equiv`）、
区域判定（10 条祖先链前后端逐格比对、粘连词根、章节例外、`mergeZone` 优先级、样本页 6 个标本、`preFilter` 开关双向）
与选择逻辑（`visibleOrder` / `pickSelection` 区间只加不减、锚点越界退化、图文锚点互不干扰），
以及前后端口径一致（`absKey` ≡ `normalizeUrl`、懒加载属性表逐字相同、内联资源键同构、srcset 与 CSS 抽取一致）。