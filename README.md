# astrbot_plugin_qq_identity · 身份识别与按人隔离

> 让模型知道**当前是谁在说话**，并且知道这个人**有什么权限**；顺带把群聊上下文按人拆开，避免「一群人共用一个脑子」。

<p align="center">
  <img src="docs/tpl-card.png" width="760" alt="身份块模板：三档切换 + 变量高亮" />
  <br />
  <img src="docs/preview-card.png" width="760" alt="预演：看模型这一轮实际读到什么" />
</p>

## 它解决什么

AstrBot 默认不把发送者 QQ 号写进上下文（`provider_settings.identifier` 默认关），于是人设里写「QQ 123456789 是开发者」模型永远匹配不上，写「只有开发者能让你长篇输出」模型也不知道谁是开发者，群里多人聊天还共用一份会话。本插件用三个钩子分别解决：

| 钩子 | 时机 | 干什么 |
|---|---|---|
| `event_message_type` | 消息进管线时 | 非开发者昵称里的敏感词就地打码；把群消息 `session_id` 改成 `{发送者}_{群号}` |
| `on_llm_request` | 请求模型前 | 把「当前发言人是谁 + 这个身份意味着什么」追加到 `system_prompt` 尾部（文案可编辑） |

## 快速开始

| 项 | 说明 |
|---|---|
| 要求 | AstrBot `>=4.26.0`；Python 版本跟随 AstrBot |
| 平台 | 只在 OneBot v11 / aiocqhttp（NapCat 等）实测过。核心逻辑只用 `sender_id` 与 `unified_msg_origin`，其他平台理论可用但未验证 |
| 依赖 | 无，不需要额外装包 |
| 安装 | 插件市场搜「身份识别」；或把仓库目录放进 `data/plugins/astrbot_plugin_qq_identity/` 后重载插件 |
| 起步 | 打开 WebUI → 插件 → 身份识别。`开发者 QQ 号` 留空就自动用 AstrBot 的 `admins_id` |
| 数据 | `data/plugin_data/astrbot_plugin_qq_identity/`：`people.json`、`candidates.json`、`audit.log` |

## 三档身份

| 档位 | 来源 | 放开什么 | 保留什么 |
|---|---|---|---|
| **开发者** | 只看配置 `master_qq` | 全放（含你的私人信息） | — |
| **熟人** | `people.json` 登记表 | 长篇 / 角色扮演 / 深入技术讨论 / 不用盘问来历 | 不透露开发者的私人信息，不被套话 |
| **陌生人** | 都没命中 | — | 全套防备条款 |

- 判定**只看 QQ 号**，由平台适配器给出，消息内容伪造不了；聊天里没人能把自己变成开发者。
- 登记表里**没有档位字段**，登记一个 QQ 永远不会让他成为开发者。
- 身份块只写进 `req.system_prompt` 尾部，**不进对话历史、不占缓存**。
- 开发者分支会显式声明「人设里那些防备条款对他不生效」，否则「讲个 200 字故事」也会被拒。
- 陌生人和熟人分支**不写开发者 QQ 号**：想写就把 `{masters}` 放进模板，页面会给出风险警告。

## 模板与变量

三档各一套模板，页面里切换编辑；留空 = 用内置默认。保存前会校验变量名，写错的段落会在页面标红。

| 变量 | 含义 |
|---|---|
| `{name}` | 发送者昵称（已打码） |
| `{qq}` | 发送者 QQ 号 |
| `{group}` | 「当前群号：xxx。」整行，私聊为空串 |
| `{label}` | 你对开发者的称呼（`master_label`） |
| `{address}` | 「（你平时称呼他「阿岚」。）」整句；称呼还是「开发者」时为空串 |
| `{masters}` | 开发者 QQ 名单（默认模板里**不用**，见上） |
| `{tier}` | `owner` / `known` / `stranger` |
| `{aliases}` `{relation}` `{note}` `{profile}` | 仅熟人档：称呼、关系、备注、整句登记内容 |

页面「预演」填一个 QQ 就能看到模型这一轮实际读到的全文、判定档位、打码后的昵称、隔离后的会话 ID。

## 熟人体系

- **登记**：聊天里 `/know QQ 称呼 [关系] [备注]`，或直接在页面表单里填（每行可编辑 / 移除）。称呼可用 `|` 分隔多个别名。
- **候选表**：自动记下「发过消息、不是开发者、也没登记」的 QQ（昵称 / 群号 / 首末露面 / 次数，上限 200）。**它不参与档位判定、也不进任何提示词**，只是观察名单；觉得该放宽就点「转为熟人」，不想留痕就「忽略」。关掉开关后一条都不记，也不建文件。
- **开发者专用工具**：`register_known_person` / `forget_known_person` / `list_known_people` 只在开发者自己发言的那一轮挂进请求，非开发者请求里根本没有这些工具名；handler 内部再验一次身份，也永远写不出开发者。
- 所有改动（命令、工具、页面）都写 `audit.log`，能分清来源。

## 昵称打码

陌生人把群名片改成「开发者」，模型就会同时收到「当前发言人：开发者（QQ 12345），不是你的开发者」两个矛盾信号。所以打码改的是**事件对象本身**——昵称里的敏感词在进入提示词前就被替换成 `＊`，内置 identifier、群聊上下文历史、其他插件读到的都是处理后的名字；原始值保留在 `event.get_extra("qq_identity_raw_name")`。打码词表可配，`master_label` 会自动并入。

## 按人隔离

把群消息的 `session_id` 改成 `{发送者}_{群号}`，与内置 `unique_session` 同构，但可以只对部分群、部分人生效：

| `isolate_mode` | 行为 |
|---|---|
| `all` | 生效群内所有人各用一份上下文 |
| `listed` | 只有 `isolate_qq` 里的人隔离，其他人共用群上下文 |
| `off` | 完全不改 `session_id` |

`isolate_groups` 留空 = 一个群都不隔离（私聊本来一人一会话，不受影响）。

## 健康模式瘦身

AstrBot 的「健康模式」是全局开关，打开后每轮都在 `system_prompt` 最前面塞一段 470 字符英文，且不认人、不管人设是中文。本插件不动全局开关，只改**这一轮请求**：

- 开发者发言 → 整块删掉；
- 其他人 → 换成配置 `safety_line` 的一句中文底线（默认约 70 字，可改）。
- 切块用首行 + 末句**双锚点**：AstrBot 改文案时最差是「不生效」，不会把人设一起切掉；没开健康模式则 no-op。

两个开关都能单独关掉。

## 页面

WebUI → 插件 → 身份识别，一页管完：开关、开发者名单（`admins_id` 一键填入）、开发者称呼、注入位置、昵称打码词表、三档模板编辑器（变量实时高亮、单档恢复默认）、熟人登记、熟人候选、按人隔离、只读预演。

## 指令

| 指令 | 作用 |
|---|---|
| `/know QQ 称呼 [关系] [备注]` | 登记或更新一个熟人（**仅开发者**），例如 `/know 234567890 阿泽\|小泽 朋友 常一起打游戏` |
| `/know list` | 开发者名单 + 登记表合并视图（**仅开发者**） |
| `/know del QQ` | 从登记表移除，之后按陌生人对待（**仅开发者**） |
| `/我是谁` | 任何人可用，只显示**自己**的档位、称呼、关系、备注 |
| `/ident` | 诊断：昵称 / QQ / 档位 / 当前会话 ID / 隔离后会话 ID / 隔离模式与生效群 |

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 插件总开关 |
| `inject_identity` | `true` | 是否每轮注入身份块 |
| `inject_target` | `system` | 写入位置：`system`（系统提示词尾部，权重最高）/ `user`（本轮用户消息临时块）/ `both` |
| `master_qq` | `[]` | 开发者 QQ 名单；留空回退到 `admins_id` |
| `master_label` | `开发者` | 你对开发者的称呼 |
| `isolate_mode` | `all` | `all` / `listed` / `off` |
| `isolate_groups` | `[]` | 启用按人隔离的群号 |
| `isolate_qq` | `[]` | `listed` 模式下的隔离名单 |
| `mask_enable` | `true` | 昵称打码总开关 |
| `mask_words` | `["开发者"]` | 要打码的词，`master_label` 自动并入 |
| `mask_char` | `＊` | 替换符（最多 4 个字符） |
| `tpl_owner` / `tpl_known` / `tpl_stranger` | `""` | 三档模板；空 = 内置默认 |
| `safety_owner_exempt` | `true` | 开发者发言时删掉 Safe Mode 整块 |
| `safety_compact_others` | `true` | 其他人换成一句中文底线 |
| `safety_line` | `""` | 那句中文底线；空 = 内置默认 |
| `owner_tools_enable` | `true` | 开发者发言时挂载登记工具 |
| `auto_candidates_enable` | `true` | 自动记录熟人候选 |
| `log` | `false` | 打印隔离 / 打码日志 |

## 数据与安全

- 身份块写进 `req.system_prompt` 尾部，不落对话历史，不占缓存。
- 身份判定只看 QQ 号，不认暗号、口令、自我介绍。
- 打码改的是事件对象，原始值只留在 `extra` 里，这一层不碰消息正文。
- 候选表只存 QQ / 昵称 / 群号 / 露面时间，**不进任何提示词**，也不会带来任何权限。
- 开发者工具只在本轮挂载，handler 内部二次校验，`DENIED` 也写审计。
- `/我是谁` 只显示调用者自己的登记内容。
- Web API 都在 Dashboard 鉴权之后；插件页跑在受限 iframe 里，拿不到 Cookie / JWT。

## 文件结构

```
astrbot_plugin_qq_identity/
├─ main.py                  # 打码 + 隔离 + 身份注入 + 模板 + 开发者工具 + Web API + 指令
├─ _conf_schema.json        # 插件配置项
├─ metadata.yaml
├─ .astrbot-plugin/i18n/    # 视图标题与描述
└─ views/identity/          # 可视化配置页（index.html + app.js + style.css）
data/plugin_data/astrbot_plugin_qq_identity/
├─ people.json              # 熟人登记表
├─ candidates.json          # 候选表（首次见到陌生人时创建）
└─ audit.log                # 登记表改动审计
```

## 与同类插件的区别

- `astrbot_plugin_maskoff`、`astrbot_plugin_uni_nickname` 解决「模型认错人」；本插件把「这个人是谁 → 该给多少权限 → 喂哪套提示词」串成一条链，按三档身份换整套模板。
- `astrbot_plugin_identity_strategy` 是按会话或用户往句前塞一段固定提示词；本插件把判定与渲染做成可视化编辑器 + 变量校验 + 预演。
- `astrbot_plugin_context_aware`、`astrbot_plugin_astrbot_enhance_mode` 做群聊场景与角色标签；本插件额外做群内按人隔离、熟人登记与候选观察。
- AstrBot 内置 `unique_session` 只有全群开或全关；本插件可以只对指定群、指定人生效。
- 多数同类会把「开发者 QQ 是多少」写进提示词；本插件默认反着来。

## License

[MIT](./LICENSE)
