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
另有 `/samples/base-path` 专测 `<base href>` 与 JSON 化 data 属性。

```bash
PORT=5000 npm start        # 换端口
npm run dev                # --watch 热重启
npm run samples            # 重新生成 public/samples
node scripts/selftest.mjs  # 离线自检（解析 / 分类 / 策略 / 元数据 / ZIP，146 条断言）
```

## 扫描策略：哪些东西不去扫描

**界面装饰与技术资源默认不扫描、不下载、不导出**，两把开关在命令台上随时可开：

| 开关 | 覆盖类别 | 默认 |
| --- | --- | --- |
| UI 图标 | `icon`（favicon、apple-touch-icon、mask-icon、雪碧图、表情 / 徽章 / 默认头像、界面小图） | 关 |
| 技术资源 | `font` `stylesheet` `script` `data` `page` `other`（字体、样式表、脚本与 source map、JSON / XML / 字幕 / manifest、站内页面） | 关 |

排除发生在两个阶段，**阶段一完全不产生网络请求**：

1. **解析阶段（preFilter）**——只看地址与上下文：类别是图标 / 字体 / 样式表 / 脚本 / 数据；
   路径含图标关键字或图标目录（`/icons/`、`favicon`、`sprite`、`arrow-16`…）；
   1×1 / `spacer` / `beacon` / `pixel` 之类命名；打点域名（doubleclick、bat.bing、
   google-analytics…）；CSS `mask-image` / `border-image` / `list-style-image` / `cursor` 属性；
   `.tab-icon`、`#logo`、`.avatar` 这类选择器；`background-position` 偏移定位的雪碧图；
   图片服务声明的短边 ≤ 64px；极小的内联 data URI。
2. **探测阶段（postFilter）**——拿到真实字节后复核：真实尺寸 ≤ 64px 判图标、1×1 判占位像素、
   ICO / ICNS 多尺寸图标集、SVG 是「图标字形」还是插画（有 `<text>` / 滤镜 / 内嵌图 / 大面积即保留）、
   精灵图与 symbol 集合、以及打点响应。

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
├── README.txt              来源、范围、合计体积、类型分布、扫描策略排除明细、保真声明
├── 图片/001-xxx.png        按类型中文名分目录，001- 前缀保留页面出现顺序；扩展名按魔数纠正
├── 音频/014-chime.wav
├── 字体/…  文档/…  压缩包/…  视频/…
├── _manifest.json          每项：path name url type mime bytes reportedBytes 宽高 时长 签名 + 全部深度元数据
├── _资源清单.csv           28 列中文表头，UTF-8 BOM + CRLF，Excel 可直接打开
└── _文案/正文.md  文案.csv  文案.json
```

CSV 列：序号 / 类型 / 文件名 / 体积(字节) / 宽 / 高 / 时长(秒) / 页数 / 页面尺寸 / 文档标题 /
作者·艺人 / 专辑 / 年份 / 流派 / 采样率 / 声道 / 帧率 / 编解码 / 播放列表 / 字体 / 相机 /
精灵图 / 声明尺寸 / 声明来源 / 地址后缀修正 / 识别格式 / MIME / 原始 URL。

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
* **命令台**：地址输入 + 深度解析 / 采纳推断地址 / **UI 图标** / **技术资源** / 站内顺带扫描页数开关；
  按钮带进度态，准星显示百分比，下方实时滚动解析日志与四个计数器。
* **类型光谱**：左侧按类型统计数量与体积（动画条 + 体积饼带），点击即筛选；主机维度同样可点。
* **展台**：网格 / 列表双视图、关键字搜索（也搜文档标题 / 艺人 / 字体家族 / 播放列表等元数据）、
  出现顺序 / 体积 / 像素 / 类型排序、只看已选、隐藏失效；
  卡片磁吸倾斜、FLIP 重排、图片懒加载、音频波形示意、视频悬停播放（走 `/api/proxy` 的 Range 分段）、
  字体样本进入视口才加载；缩略图角标显示页数、流媒体档位、字体家族、相机型号与「按内容补探测」。
* **详情抽屉**：每个资源一张元数据表，按 EXIF / 视音频 / 文档 / 清单 / 字体 / 解析来源分组，
  深色下保证正文对比度；文字条目同样可展开原文预览与逐条复制。
* **文字页**：标题骨架、关键词条、段落卡片（字数 / 行号 / 噪音标记 / 一键复制），
  可整段或按选中导出 md / txt / csv / json / html。
* **导出坞**：底部浮层显示已选数量与体积，支持当前类型、已选全部、逐类型、整站，以及附带文案。
* 动效遵循 `prefers-reduced-motion`；自定义光标在触屏设备自动关闭。

快捷键：`/` 搜索、`a` 全选当前视图、`e` 导出、`g` 切换视图、`x` 清空选择、`Esc` 关闭。
URL 参数：`/?url=https://…` 直接开扫，`/?job=ID` 载入历史结果，`/?job=ID&type=font` 定位到某类。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/scan` | 入参 url / deep / infer / **includeIcons** / **includeTech** / crawlPages / maxResources，返回 job |
| GET | `/api/jobs` 与 `/api/jobs/:id` | 任务列表 / 完整快照（含 result） |
| GET | `/api/jobs/:id/events` | SSE：status log meta item progress done reopen，支持 Last-Event-ID 续传 |
| GET | `/api/proxy?url=&name=&download=` | 原始字节代理，**支持 Range/206**，响应头 x-original-size |
| GET | `/api/inline?job=&id=&download=` | 取回 data URI 解码后的原文件 |
| POST | `/api/reprobe` | 按 ids 或 urls 重试不可达项 |
| POST | `/api/bundle` | ids / scope:type+types / scope:all + label + withText + textIds → 流式 ZIP |
| POST | `/api/export` | job + format(md/txt/csv/json/html) + 可选 ids → 文案文件 |
| POST | `/api/cache/purge` | 清空字节缓存 |
| GET | `/api/health` | 存活与任务数 |

## 缓存与隐私

* 抓取结果写入项目内 `.cache/`（SHA1 命名，24 小时 TTL）；重复扫描与导出直接命中本地字节，
  因此二次扫描常在一秒内完成，导出近乎瞬时。**重新生成样本后请先 `rm -rf .cache` 或调 purge 接口。**
* 服务只监听 `127.0.0.1`，不与任何第三方通信；请求直发目标站点，携带目标站自身的
  Referer 与常见浏览器 UA。请自行确认目标站点访问条款，仅解析你有权抓取的内容。
* 解析器不执行 JavaScript，纯客户端渲染的站点可用「站内顺带扫描」与脚本地址推断兜底；
  若目标不可达，条目会以对应状态保留在结果里而不是消失。

## 目录结构

```text
server/   config.mjs  mime.mjs  net.mjs  urlmeta.mjs  policy.mjs  probe.mjs  containers.mjs
          docmeta.mjs  lazy-attrs.mjs  extract.mjs  scan.mjs  zip.mjs  index.mjs
public/   index.html  css/(base|console|results).css  js/(app|store|views|api|radar|fx|util).js  samples/
scripts/  make-samples.mjs  selftest.mjs  inspect-job.mjs
```

* `extract.mjs` —— 手写容错 HTML 解析（隐式闭合、srcset、CSS url / @import、data URI、行号定位、文案分区）
* `policy.mjs` —— 扫描策略：preFilter（零请求）+ postFilter（真实字节复核）+ 内容线索救援 + 排除明细限量与摘要
* `urlmeta.mjs` —— 地址语义：20+ 图片服务 / CDN 参数、内层原图还原、徽章 / 表情 / 头像识别
* `probe.mjs` —— 魔数与图像 / 视音频容器元数据（全部大端 / 小端按规范读取，扩展名与 MIME 以魔数为准）
* `containers.mjs` —— 字体表目录（sfnt / WOFF / WOFF2）、ICO / ICNS 图标集、DDS / EXR / PNM / TGA / QOI
* `docmeta.mjs` —— PDF 信息字典与页面尺寸、OOXML / ODF / EPUB、HLS 与 DASH 清单
* `scan.mjs` —— 任务引擎：抓取 → 解析 → 递归 CSS → 站内顺带扫描 → 策略过滤 → 6 路并发探测（75s 预算）→ 深度容器解析 → 归并统计
* `zip.mjs` —— 流式 ZIP 写入器（UTF-8 文件名标志、crc32 表、deflate 与 store 回退、目录项）

## 验收基线

| 目标 | 保留 | 排除 | 说明 |
| --- | --- | --- | --- |
| `/samples/lab` | 25 | 114 | 1 项由内容线索救回；图标 / 字体 / 样式表 / 数据 / 页面全部零请求 |
| `https://www.apple.com/` | 255 | 309 | 字体 144、页面 107、图标 35（其中 2 项探测后确认）、脚本 12、样式表 9、像素 2；144 张 ≥600px 内容图完整保留 |
| `https://www.bing.com/` | 5 | 98 | 保留的两张为 1920×1200 / 1366×768 当日壁纸；搜索框、麦克风、菜单、关闭等按钮图标全部按选择器 / 真实尺寸排除 |