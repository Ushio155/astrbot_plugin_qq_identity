# SUMMARY.md — astrbot_plugin_qq_identity（写给 AI 队友）

<!-- repo-summary
root: .
-->

> 行号快照：`main`（仓库刚建立时写，没有具体行号引用，故不会腐烂）。

## 1. 核心文件地图

| 文件 | 一句话作用（为什么存在） |
|---|---|
| `main.py` | 插件全部后端：身份判定、模板渲染、会话隔离、打码、熟人/候选存储、WebUI 接口。单文件是刻意的——AstrBot 插件加载时只认 `main.py` 的 `Star` 子类。 |
| `_conf_schema.json` | 配置页 schema。默认值全部中性（`master_qq` / `isolate_groups` 默认空），新装不该带任何人的 QQ。 |
| `views/identity/` | 插件页三件套（`index.html` / `style.css` / `app.js`），由 AstrBot 的 page-asset 路由服务，静态文件，改完刷新页面即生效。 |
| `metadata.yaml` | 市场解析用：`display_name` / `short_desc` / `repo` / `support_platforms` / `tags` 缺一个市场页就少一块信息。 |
| `docs/*.png` | README 与市场配图，**内容必须是默认模板**（不能出现任何真实 QQ、群号、人名）。 |

## 2. 索引（读代码读不出来的）

- **开发副本在仓库外**：真正跑在 AstrBot 上的那份是 `D:\AstrBot\AstrBot\data\plugins\astrbot_plugin_qq_identity\`（结构与本仓库相同）。本仓库是它的发布副本。
- **验证脚本不在本仓库**：都在工作区 `D:\code_practice\AI_coding\chats\scripts\`：
  - `clickthrough_tpl_tabs.py`：真 Chrome 点击链路（三档切换 / 变量高亮 / 恢复默认 / 空状态），**70 条**。
  - `clickthrough_people_ui.py`：熟人登记 + 候选卡片回归，**39 条**。
  - `verify_tpl_tabs_live.py`：登录 127.0.0.1:6185 → 重载插件 → 校验线上资源与 `identity/state`，**65 条**。
  - `probe_oss_shots.py` + `fetch_oss_state.py`：渲染 `docs/` 里那两张图（用线上 `tpl_defaults`，所以图里是内置默认文案）。
- **版本号三处联动**：`metadata.yaml` 的 `version`、git tag、本机备份库 `Ushio155/astrbot-backup`。README **不写更新记录**（首次公开发布起就不留 changelog，历史看 `git log` 与 tag）。
- **发布通道**：插件市场已迁到 `https://cloud.astrbot.app/publish`（旧的 `AstrBot_Plugins_Collection` 仓库标了 DEPRECATED）。发布要 AstrBot Cloud 账号，压缩包上限 16MB。

## 3. 测试与运行指令

| 命令 | 档位 | 实测耗时 | 前置条件 |
|---|---|---|---|
| `node --check views/identity/app.js` | L0 | <1 s | 无 |
| `python -c "import json;json.load(open('_conf_schema.json'))"` | L0 | <1 s | 无 |
| `clickthrough_tpl_tabs.py` | L2 | ~25 s | 本机 Chrome |
| `clickthrough_people_ui.py` | L2 | ~20 s | 本机 Chrome |
| `verify_tpl_tabs_live.py` | L3 | ~40 s | AstrBot 在 127.0.0.1:6185 跑着，**会重载插件** |

风险提示：`verify_tpl_tabs_live.py` 会真的调 `/api/v1/plugins/reload` —— 正在回复的会话可能被打断；其余脚本只读，不碰线上配置。

## 4. AI 工作流红线

1. **不许把任何真实 QQ / 群号 / 人名写进仓库**（含 README 示例、schema 默认值、提交信息、`docs/` 截图）。历史一旦公开就删不干净；示例统一用 `123456789` / `345678901` / `阿岚` / `阿泽`。
2. **改完开发副本要同步过来，别直接在本仓库改**，否则下次同步会被覆盖；同步后 `git status` 应只看到预期文件。
3. **不要把 `.git`、`__pycache__`、`data/`、`audit.log` 提交进来**：`.gitignore` 已列，但用 `git add -A -f` 会无视它 —— 提交前逐条看 `git status --porcelain`。
4. **`metadata.yaml` 里 `repo` 必须指回本仓库**，否则市场页的「源码」按钮会失效。
5. **发版前跑一次 `verify_tpl_tabs_live.py`**：它同时校验版本号与三档模板未被误改（0.8.4 那次就是它挡住的）。
6. **README 只写给使用者看**：不写更新记录 / 开发日志，不提作者自己的其他插件（世界书、口令验证那类分工是私人环境），也不留「0.x 起改了什么」的版本注记。这些放 `git log` 与提交信息里。
