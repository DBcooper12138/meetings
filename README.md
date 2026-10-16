# 会议发布与参会确认系统

发布会议 → 生成专属链接 → 参会人在手机上确认是否参会 → 结果自动汇总回后台，可统计、可导出 Excel。

**完整说明请先看：[docs/部署与使用手册.md](docs/部署与使用手册.md)**

---

## 三步跑起来

| 步骤 | 做什么 | 在哪做 |
| --- | --- | --- |
| **1. 建数据库** | 在 [supabase.com](https://supabase.com) 免费注册 → 新建项目（区域选 Singapore）→ 把 `supabase/01_schema.sql` 整段粘进 SQL Editor 执行 → 再执行一行 `select public.set_admin_secret('你的口令');` | Supabase 网页 |
| **2. 填参数** | 把 Supabase 的 `Project URL` 和 `anon public` 密钥填进 `config/config.js` | 记事本 |
| **3. 发布** | 把整个文件夹（**不含 `_dev`**）上传到 GitHub 仓库 → Settings → Pages → 选 `main` 分支 `/ (root)` → 得到 `https://用户名.github.io/仓库名/` | GitHub 网页 |

然后打开那个网址 → 名单管理 → **写入初始 55 人名单** → 发布会议 → 复制链接发群。

---

## 目录结构

```
index.html            入口页面
css/app.css           样式（含手机端、打印样式）
js/app.js             界面与路由（后台 + 参会人填报页）
js/db.js              数据访问层（Supabase 云端 / 本机 localStorage 两种模式）
js/parser.js          数据逻辑（名单解析、参会汇总、导出表格）
js/xlsx.js            零依赖 Excel 读写
js/qr.js              零依赖二维码生成
js/util.js            通用工具
config/config.js      ★ 需要你修改的唯一文件
config/seed.js        初始 55 人名单
supabase/01_schema.sql ★ 要粘到 Supabase 执行的建库脚本
docs/                 使用手册
_dev/                 开发自检脚本（不要上传）
```

## 网址形态

| 用途 | 网址 |
| --- | --- |
| 后台（你自己用） | `https://用户名.github.io/仓库名/#/meetings` |
| 参会人填报（发给别人） | `https://用户名.github.io/仓库名/#/s/<会议token>` |

## 技术说明

- 纯静态前端：HTML + CSS + 原生 JS，无构建步骤，无框架，改完直接上传即可。
- 唯一的外部依赖是 Supabase 客户端库（通过 CDN 引入）。**Excel 读写和二维码生成都是自己实现的**，不依赖任何 CDN，断网也能用。
- 数据持久化在 Supabase（PostgreSQL）。名单与回执由数据库层的行级安全策略（RLS）保护，只认后台口令。
- 参会人只能看到自己那场会议的公开信息与受邀人姓名列表，看不到他人的参会状态与请假原因。

## 自检（开发用）

```powershell
# 01 单元自检：Excel 读写往返、名单解析、参会汇总、导出表格、二维码编解码、工具函数
<python> _dev/make_fixtures.py      # 先准备 Excel 样本
<node>   _dev/run.js                # 50 项检查

# 02 端到端回归（本机模式，用 jsdom 跑真实界面）：15 项检查
<node>   _dev/e2e.js                # 需要先在 _dev 下 pnpm add jsdom
```

两层覆盖：

| 层 | 覆盖内容 |
| --- | --- |
| `_dev/run.js` | Excel 读取 / 写入往返、名单导入解析（列名乱序、无表头、重复行、CSV 引号）、参会汇总与统计口径、导出表格内容、二维码编码后用真实解码器 `jsqr` 验证、工具函数 |
| `_dev/e2e.js` | 本机模式启动、写入名单、全选类别建会、生成参会链接、二级网页填报、后台统计与状态标签、催办文本、导出 |

