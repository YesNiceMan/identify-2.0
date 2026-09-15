# IDENTIFY 2.0 · 网页资源识别与按类型原尺寸导出

> 需求对应：**① 输入网站链接进行解析 → ② 识别出的文件可按类型导出，并保持原大小**
> 风格：**深色扫描台**——雷达点阵背景、动能排版、流式解析日志，摒弃传统网站布局。

零依赖的本地解析控制台：只用 Node 内置模块（http / https / zlib / crypto / fs），无需 `npm install`。
粘贴一个网址，它会抓取并解析页面、递归外链样式表、逐个读取资源的真实字节与元数据
（像素尺寸、时长、采样率、MIME、魔数签名），再让你按类型勾选并打包导出。

## 快速开始

```bash
node -v            # 需要 >= 18.17（使用内置 fetch）
npm start          # 自动生成样本资源并启动 → http://127.0.0.1:4620
```

打开后点命令台下方的 **本机样本页** 芯片，即可走一遍完整的识别与导出流程。
样本页 `/samples/lab` 是一个刻意做难的标本：srcset、懒加载 data-src、内联 style、
import 二级 CSS、font-face、noscript、脚本内 JSON 裸链接、data URI、失效链接、
跨站视频一应俱全。

```bash
PORT=5000 npm start        # 换端口
npm run dev                # --watch 热重启
npm run samples            # 重新生成 public/samples
node scripts/selftest.mjs  # 离线自测（解析 / 分类 / 元数据 / ZIP，54 条断言）
```

## 它能识别什么

| 类别 | 来源 |
| --- | --- |
| 图片 / 矢量 | `img[src]`、`srcset`（含多密度候选）、`picture/source`、`poster`、`og:image`、`data-src` 等懒加载属性、内联 `style`、CSS `url()`、`link rel=icon`、`data: URI` |
| 视音频 | `video` / `audio` / `source` / `track`；解析 MP4(mvhd+tkhd)、Matroska、MP3(Xing)、WAV、OGG、FLAC 得到时长、宽高、采样率、声道 |
| 文档 / 表格 / 压缩包 | `a[href]` 与 `a[download]`：pdf、docx、xlsx、csv、zip…（魔数纠正类型） |
| 字体 | 外链 CSS 中的 `font-face` src（含 Google Fonts 的 unicode-range 子集） |
| 样式表 / 脚本 / 数据 | `link rel=stylesheet`、`script src`、JSON、`import` 递归展开 |
| 文字 | 标题层级、正文、引用、列表项、表格单元格、链接文案；带标签、行号、字数，并区分**正文区与噪音区（导航/页脚）** |
| 隐藏引用 | 内联 `script` 的 JSON 与裸链接、`noscript` 内的标签，标记为「推断」 |

失效地址（404 / 403 / DNS / 超时）**不会被丢弃**，而是以“不可达”状态列出并可单独重试
（`POST /api/reprobe`）——它们同样是页面资源事实的一部分。

## 原尺寸导出

压缩包里的每个文件，都是目标站点返回的**原始字节流**：不缩放、不重编码、不改容器。
服务端直接从磁盘字节缓存（`.cache`）取出原始响应写入 ZIP；deflate 只作用于 ZIP 传输层，
解包后字节完全一致。

```text
IDENTIFY-<host>-<范围>-<时间戳>.zip
├── README.txt              来源、范围、合计体积、类型分布、保真声明
├── 图片/001-xxx.png        按类型中文名分目录，001- 前缀保留页面出现顺序
├── 音频/014-chime.wav
├── 字体/…  文档/…  压缩包/…
├── _manifest.json          每项：path name url type mime bytes reportedBytes 宽高 时长 签名
├── _资源清单.csv           同上，UTF-8 BOM + CRLF，Excel 可直接打开
└── _文案/正文.md  文案.csv  文案.json
```

`bytes` 是实际写入的字节数，`reportedBytes` 是探测时 `Content-Length` 或 HEAD 得到的值，
两者不一致会在 manifest 中暴露。校验示例：

```bash
unzip -t out.zip
md5  图片/001-aurora.png
curl -sI https://host/aurora.png | grep -i content-length   # 三者应完全相等
```

前端导出走 `fetch` + `ReadableStream`，进度遮罩显示**真实已写入字节数**，完成后交给浏览器保存。

## 界面与交互

* **雷达扫描台**：全屏 canvas 点阵随光标呼吸，扫描过程中每个被识别的资源实时生成一个星座节点。
* **命令台**：地址输入 + 深度解析 / 采纳推断地址 / 站内顺带扫描页数开关 + 目标芯片；
  按钮带进度态，准星显示百分比，下方实时滚动解析日志与四个计数器。
* **类型光谱**：左侧按类型统计数量与体积（动画条 + 体积饼带），点击即筛选；主机维度同样可点。
* **展台**：网格 / 列表双视图、关键字搜索、出现顺序 / 体积 / 像素 / 类型排序、只看已选、隐藏失效；
  卡片磁吸倾斜、FLIP 重排、图片懒加载、音频波形示意、视频悬停播放（走 `/api/proxy` 的 Range 分段）、
  字体样本进入视口才加载。
* **文字页**：标题骨架、关键词条、段落卡片（字数 / 行号 / 噪音标记 / 一键复制），
  可整段或按选中导出 md / txt / csv / json / html。
* **导出坞**：底部浮层显示已选数量与体积，支持当前类型、已选全部、逐类型、整站，以及附带文案。
* 动效遵循 `prefers-reduced-motion`；自定义光标在触屏设备自动关闭。

快捷键：`/` 搜索、`a` 全选当前视图、`e` 导出、`g` 切换视图、`x` 清空选择、`Esc` 关闭。
URL 参数：`/?url=https://…` 直接开扫，`/?job=ID` 载入历史结果，`/?job=ID&type=font` 定位到某类。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/scan` | 入参 url / deep / infer / crawlPages / maxResources，返回 job |
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
  因此二次扫描常在一秒内完成，导出近乎瞬时。
* 服务只监听 `127.0.0.1`，不与任何第三方通信；请求直发目标站点，携带目标站自身的
  Referer 与常见浏览器 UA。请自行确认目标站点访问条款，仅解析你有权抓取的内容。
* 解析器不执行 JavaScript，纯客户端渲染的站点可用「站内顺带扫描」与脚本地址推断兜底；
  若目标不可达，条目会以对应状态保留在结果里而不是消失。

## 目录结构

```text
server/   config.mjs  mime.mjs  net.mjs  probe.mjs  extract.mjs  scan.mjs  zip.mjs  index.mjs
public/   index.html  css/(base|console|results).css  js/(app|store|views|api|radar|fx|util).js  samples/
scripts/  make-samples.mjs  selftest.mjs  inspect-job.mjs
```

* `extract.mjs` —— 手写容错 HTML 解析（隐式闭合、srcset、CSS url、data URI、行号定位、文案分区）
* `probe.mjs` —— 手写魔数与容器元数据解析（PNG/JPEG/GIF/BMP/WebP/AVIF/ICO/SVG；MP4/MKV/WebM；
  MP3/WAV/OGG/FLAC；ZIP/RAR/7z；PDF/DOCX/XLSX）
* `scan.mjs` —— 任务引擎：抓取 → 解析 → 递归 CSS → 站内顺带扫描 → 6 路并发探测（75s 预算）→ 归并统计
* `zip.mjs` —— 流式 ZIP 写入器（UTF-8 文件名标志、crc32 表、deflate 与 store 回退、目录项）
