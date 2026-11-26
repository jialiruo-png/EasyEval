# 项目更新记录

任何 Agent 只要修改本项目，就必须在本文件末尾追加该次记录。这条规则覆盖代码、文档、配置、数据契约、依赖、迁移和上游源码版本，也覆盖项目副本内的 DeepSeek Harness 埋点、Coze Loop 扩展及回退操作。修改本文件时，同一次记录可以包含本文件。

## 记录与回退规则

1. 开工前读 [项目说明](readme.md)、[产品需求](prd.md)、[plan.md](plan.md) 和最近的更新记录。交付前检查实际变更范围，在同次改动中提交或交付这条记录。多 Agent 同时工作时分别写记录，合并时保留各自条目。
2. 每条至少写明 Agent 实名或可追溯标识、日期（Asia/Shanghai）和改了什么。也写明原因、影响范围、验证命令或观察结果、代码或上游引用及回退步骤。涉及迁移、调度或上游资源时，写清代码回退与运行数据恢复的区别。
3. 已有记录按时间追加。需要更正时另写记录并指向原条目。对未验证项写明实际状态；对未提交变更注明未提交并列出涉及路径。已有 Git 提交用 PR、分支及基线或可解析提交定位，可在后续记录补充合并后的提交引用。
4. 回退时先停止受影响的调度和新提交，根据记录定位变更。已提交代码优先对明确提交做 Git revert 并保留历史。涉及 PostgreSQL、历史 SQLite 或 Coze Loop 数据时，确认备份和前后版本兼容性后再决定恢复；新产生的记录另行保留和核对。恢复完成后追加一条回退记录，注明撤销对象、验证和数据影响。
5. 更新日志只写可共享的信息。真实会话内容、Token、API Key 或个人连接信息使用项目本机约定的凭据或样本存储。

## 记录模板

### YYYY-MM-DD · 变更标题

- Agent：产品或运行名，必要时附任务 ID 或分支。
- 日期：YYYY-MM-DD HH:mm（Asia/Shanghai，可省略时间）。
- 改动：文件、接口、上游版本或用户行为。
- 原因与影响：对应计划阶段、用户决策、运行或数据影响。
- 验证：已执行的检查和结果，标明未验证项。
- 变更引用：分支、提交、PR 或明确的未提交文件。
- 回退：具体基线、步骤和数据兼容性。

## 记录

### 2026-11-20 · 项目准备和依赖基线

- Agent：Codex，本轮架构与文档整理。
- 日期：2026-11-20（Asia/Shanghai）。
- 改动：在评测目录新建 `coze-loop-eval-platform`，编写 [readme.md](readme.md)、[plan.md](plan.md)、[update.md](update.md)，记录本地轻量应用与 Coze Loop 的集成方案。独立拉取 [Coze Loop](https://github.com/coze-dev/coze-loop/tree/7a5ab1633eb30396928cd51017a63b456d117985) v1.5.1 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb) 的桌面基线。
- 原因与影响：明确首个目标为 DeepSeek Harness，使用隔离评测 Profile 和无副作用测试工具。创建只保存，支持手动或到点正式运行。数据源按负责人选择采用飞书 Excel／CSV 导出与 SQL 结果 CSV。Coze Loop 的运行环境定为本机 Docker Compose。
- 验证：比对两份 checkout 的 HEAD、状态和基线来源，核查源码内的 Trace／实验／评估器及 Harness SDK 契约，检查交付文档的内部链接。服务启动、权限、评估器打分及全链路留待 P1 验证。
- 变更引用：Coze Loop `7a5ab1633eb30396928cd51017a63b456d117985`。DeepSeek Harness `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`。平台文档未提交。
- 回退：初始基线的变更集中在新目录。若需撤销本次准备，可先归档整个新目录；后续工作可按上述 commit 重新取得上游源码。本次无运行数据或迁移。

### 2026-11-20 · 第四板块结果页与规则输出

- **Agent**　Codex，结果页需求评审与 TRD 修订。
- **日期**　2026-11-20（Asia/Shanghai）。
- **改动与决策**　负责人确认每个任务选一条规则，规则输出一个总分、多个独立指标并自定义 JSON。在 [plan.md](plan.md) 加入独立结果页 TRD、读取接口草案，以及规则编辑、同次裁判输出留存、统计和验收要求。P5 区分取消本批、停用定时和归档任务。
- **依据**　在 Chrome 阅读负责人指定的飞书仪表盘、Trace 列表与调用链章节，采用从批次进入样本、从样本核对实际调用的交互。抖店过程质量规则用作嵌套 JSON、四项三态判定和空分的验收实例。样本等权均分、指标筛选和 API 路径属于本轮设计约定。
- **验证**　核对 Coze Loop v1.5.1 的公开评分结构与裁判模型 span 实现，检查计划中 14 处本地链接。用 A、B、C 三个有效输出复算 0.75、0、null，批次均分 37.5%。D 和 E 为待实施的失败用例。Coze Loop 的认证、完整 JSON 回读和端到端评分留在 P1 实测。
- **变更引用**　本次未提交，涉及 `plan.md` 与本条日志。无数据库迁移或运行数据变更。
- **回退**　移除本次在计划 P0 前加入的「四、结果输出」整节、P1 第 4 项的两个子条目，以及 P2、P4、P5、P6 中分别以「规则版本冻结」「每个任务在第 3 步」「实现独立批次结果页」「执行『过程质量』的 A–E 五条样本」（文中用直角引号）起头的新增条目。P5 原调度条目全文如下。保留本条历史，实际回退时追加记录。

  > 手动以请求 ID 防重复提交；调度建议使用任务 ID 与计划时间作为幂等键，并记录 Shanghai 时区、下一触发和错过／跳过原因。建议同一任务已有执行时跳过本次定时，取消或归档后不触发未来执行。

### 2026-11-20 · 新增 UI 设计规范

- **Agent**　Codex，设计要求整理。
- **日期**　2026-11-20（Asia/Shanghai）。
- **改动**　新增 [design.md](design.md)，定义 Ant Design 风格、白底、主操作蓝 `#1664FF`、直角平铺列表、表单行分隔、统一页边距与图标来源。在 [readme.md](readme.md) 的接手说明中加入设计规范入口。
- **原因与影响**　将负责人的视觉要求转为前端实现与验收规则。分隔线色值 `#F0F0F0`、桌面端 `24px` 页边距和实心蓝按钮使用纯文字为本轮补充的实施约定。
- **验证**　核对 RGB 与十六进制色值换算、文档链接和交付检查项。界面验收待前端实现。
- **变更引用**　本次未提交，涉及 `design.md`、`readme.md` 与本条日志。
- **回退**　移除新建设计规范和 `readme.md` 新增的设计规范入口句，保留本条历史并追加回退记录。

### 2026-11-20 · 可点击的纯前端演示

- **Agent**　Codex，交互演示与浏览器验证。
- **日期**　2026-11-20（Asia/Shanghai）。
- **改动**　新增 [demo/index.html](demo/index.html)，在一份 HTML 内实现三 Tab 管理、四步创建、样本预览、字段映射和试评分、手动运行、独立结果页、指标筛选及 Agent／裁判轨迹。在 [readme.md](readme.md) 新增演示入口和验收路线。
- **原因与影响**　按 [design.md](design.md) 和 [plan.md](plan.md) 的第四板块做本机交互验证。内置虚构样本，CSV 与 `.xlsx` 由浏览器读取。Agent 执行、裁判评分、AI 建规则与定时配置为模拟交互。浏览器存储可用时保留草稿和演示数据。
- **验证**　执行 JavaScript 语法检查和 Chrome 本地文件端到端测试。覆盖筛选分页、复制归档、四步向导回退、三条轨迹预览、两条试评分、手动运行、取消本批与停用定时、CSV 和多工作表 XLSX 导入、规则新版本与历史结果、`37.5%` 均分、指标下钻及工具参数定位。核对桌面页面截图与 390px 视口页面宽度。
- **变更引用**　本次未提交，涉及 `demo/index.html`、`readme.md` 与本条日志。
- **回退**　移除 `demo/index.html` 和 `readme.md` 的本地交互演示节，保留历史并追加回退记录。演示在浏览器侧使用独立存储键 `coze-loop-eval-demo-v1`。

### 2026-11-20 · 确认个人账号隔离

- **Agent**　Codex，个人账号需求与开发计划修订。
- **日期与决策**　2026-11-20（Asia/Shanghai）。负责人确认一期采用个人账号，每人只能访问自己的内容，团队协作在本期范围之外。
- **改动**　[PRD](prd.md#个人账号与数据归属) 定义各类资源、衍生结果和定时执行的归属，更新创建人筛选与双账号验收。[设计规范](design.md#个人账号与页面状态) 增加登录态、空列表和旧链接提示。[开发计划](plan.md) 在 P1、P2、P3、P5、P6 加入上游访问边界、会话、服务端归属校验、后台任务和双账号验证。
- **设计约定**　计划以服务端会话识别账号，未登录返回 401，他人资源与缺失资源统一返回 404。账号开通和登录方式仍待选型。
- **验证**　已核对各文档的账号归属表述、验收入口与本地链接，在临时副本验证三份文档可恢复至改动前内容。登录、后端校验及双账号验收须在开发阶段实跑。
- **变更与回退**　本次未提交，仅涉及上述三份文档与本条记录。工作期间生成的本机临时反向补丁为 `/private/tmp/coze-account-docs-quz7huwg/revert-account-docs.patch`，可在项目根目录用 `patch -p1 --dry-run -i <补丁路径>` 检查后应用。后续提交后可按该提交回退，保留本条并追加回退记录。本次没有数据迁移。

### 2026-11-21 · P1 阻塞期的独立 Git 基线与结果契约参考实现

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-21 21:09（Asia/Shanghai）。
- **改动**　在项目根目录建立平台独立 Git 仓库（`main`），新增 `.gitignore` 排除 `upstream/` 两份单独管理的源码 checkout、本机凭据/临时文件、`.workbuddy/` 与依赖目录；以 `c97f044` 提交 P0 基线。新增 `src/result-contract/contract.ts`、`fixtures.ts`、`contract.test.ts`，把 plan.md 第四板块 TRD 固化为可执行契约：嵌套路径与数组按键取值（顺序无关、重复键报歧义）、三态/布尔/数值指标校验、总分复算、失败时保留原文与全部出错字段、尝试保留与最终尝试选择、批次汇总与样本明细筛选。固定样本 A–E 与异构 JSON 规则一并加入。修订 [plan.md](plan.md) 状态和 P1「并行准备轨道」，说明阻塞输入与后续接续点。
- **原因与影响**　P1 实机验证依赖本机 Docker Compose、独立 workspace、目标与评估模型配置及受控样本，当前均未就绪，按计划约束不启动服务、不装依赖、不调模型，也不臆造验证结果。改走不依赖这些输入的可准备工作，先把 P4/P5 与结果页共用的取值和统计口径确定下来。本轮不改变已确认的产品行为，不修改 `upstream/` 两份源码，不产生数据库迁移或运行数据。
- **验证**　`node --test src/result-contract/contract.test.ts`：13/13 通过。覆盖 A=0.75（参数填充 Fail、数组乱序不变）、B=0 计入均分、C 全 NA 合法 null、D 证据缺失并保留阶段与 Trace 引用、E 损坏 JSON 评分失败；整批 5 条、2 条数值总分、1 条全 NA、2 条评分失败，均分 `0.375`（页面显示 `37.5%`）；各指标独立分母与 NA 单列；非法枚举、重复业务键、缺字段、总分不匹配、数值越界与非全 NA 空分均返回具体字段错误；重试保留两次尝试且仅用最终尝试；异构规则按不同键名和嵌套层级取值。运行命令仅需 Node 22 内置类型剥离与 `node:test`。实机链路、鉴权与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：`c97f044`（P0 基线）、`445ff18`（契约代码、`fixtures`、测试与 plan.md 修订）；本条记录随下一次提交入库。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与验收无法实测；Coze Loop 认证、原生实验能否复用已执行数据、完整裁判 JSON 回读与 Trace 到期后的本地读取仍待实测。本轮契约只覆盖结果取值与汇总，尚未接入 HTTP 接口、数据库与工作区隔离。
- **回退**　对 `445ff18` 执行 `git revert` 即可移除契约代码与 plan.md 并行准备轨道；如需连同 P0 基线一起撤销，再 revert `c97f044`，或在确认无保留价值后删除项目内 `.git`（不影响桌面父仓库和两份上游 checkout）。契约模块为纯新增文件，删除 `src/result-contract/` 不影响 `demo/index.html` 与四份文档。无迁移和运行数据，回退不需要数据恢复。

### 2026-11-21 · P1 阻塞期的三条结果读取接口骨架

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-21 22:06（Asia/Shanghai）。
- **改动**　新增 `src/result-api/store.ts`、`handlers.ts`、`handlers.test.ts`，把 plan.md「结果读取接口（拟定）」的三条 GET 固化为 HTTP 无关的纯函数：`getResults`（批次元数据、版本、状态计数、均分与指标汇总）、`listSamples`（指标/状态/总分区间筛选与分页）、`getSample`（完整回答、各尝试评分、脱敏原文、业务 JSON、解析错误与 Trace 引用）；另提供 `resultReadRoutes` 与 `createResultReadApi` 供后续挂载。只读存储 `InMemoryReadStore` 在访问边界同时限定账号与批次 ID。在 [plan.md](plan.md) 的 P1 并行准备轨道追加本增量说明。未改 PRD：本轮只实现已确认的读取契约，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需本机 Docker Compose、独立 workspace、目标／评估模型配置与受控样本，本轮继续推进不依赖这些输入的接口层。取值、校验、尝试选择与统计全部调用 `src/result-contract/`，避免结果页与契约口径分叉。未启动服务、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，不产生数据库迁移或运行数据。
- **验证**　`node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts`：23/23 通过（契约 13 + 接口 10）。接口覆盖 A–E 整批均分 `0.375`／`37.5%` 与各状态计数；指标筛选命中 A，状态与总分区间分别命中 E、D、B；分页 total 保持 5 且批次统计不随筛选变化；A 详情含完整回答、业务 JSON 与 Trace 引用；E 解析失败保留原文与 `INVALID_JSON` 字段错误；D 保留 `tool_execution_collect` 阶段与 Trace；Trace 到期仍返回本地评分且标记 `scoringFromLocalHistory`；未登录 401、他人批次与不存在批次统一 404，三条接口一致；重试保留两次尝试且最终尝试用于评分；三条路由路径与计划一致。仅用 Node 22 内置能力。实机链路、真实 HTTP 挂载、鉴权会话与 SQLite 持久化仍未验证。
- **变更引用**　`main`：`8d4bbce`（接口骨架、测试与 plan.md 修订）；本条记录随下一次提交入库。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；接口尚未挂到 node:http，会话身份目前由调用方传入的 `accountId` 模拟；存储为内存实现，尚未落 SQLite 迁移；Coze Loop 认证、完整裁判 JSON 回读与 Trace 到期后的上游读取仍待实测。
- **回退**　对 `8d4bbce` 执行 `git revert` 即可移除 `src/result-api/` 与 plan.md 本轮修订，保留 `445ff18` 的结果契约和 P0 基线；三个文件均为纯新增，删除目录不影响 `demo/index.html`、四份文档与 `src/result-contract/`。更彻底回退可继续 revert `445ff18`、`c97f044`。无迁移、无运行数据，回退不需要数据恢复。

### 2026-11-21 · P1 阻塞期的三条结果读取接口 HTTP 挂载

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-21 23:09（Asia/Shanghai）。
- **改动**　新增 `src/result-api/http.ts` 与 `src/result-api/http.test.ts`。用 `node:http` 把 `getResults` / `listSamples` / `getSample` 挂到计划中的三条 GET 路径；`InMemorySessionStore` 由服务端签发随机会话令牌，支持 `Cookie: eval_session=...` 与 `Authorization: Bearer ...` 传输，`invalidate` 立即使会话失效。请求中的 `accountId` 查询参数、`x-account-id` 请求头一律不参与鉴权；筛选参数统一校验，未知路径 404、非 GET 405 并带 `Allow: GET`、非法筛选 400；所有响应 `Cache-Control: no-store`。在 [plan.md](plan.md) 的 P1 并行准备轨道补记本增量。未改 PRD：本轮只实现已确认接口的传输与身份边界，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、模型配置与受控样本，继续推进不依赖这些输入的接口层。上轮 handler 的账号来自调用方参数，本轮把账号来源收敛到服务端会话，补上「未登录 401、越权与不存在 404、退出后旧会话不可用」的可复现验证。未启动 Docker、未安装依赖、未调用模型、未改 `upstream/` 两份源码，无数据库迁移与运行数据。
- **验证**　`node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts`：31/31 通过（契约 13 + handler 10 + HTTP 8）。HTTP 测试在 127.0.0.1 临时端口起停服务：无会话/伪造令牌三条接口均 401；会话 A 的批次概览均分 `0.375`／`37.5%`，指标筛选命中 A、分页 total 保持 5，样本详情含尝试与业务 JSON，异构规则样本按同接口取值 88；会话 B 访问 A 的批次与不存在批次得到相同 404，自报 `accountId` 不能切换身份；会话失效后 401；非法筛选 400、POST 405、未知路径 404；响应禁止缓存。首次运行曾因测试模块初始化早于 `before` 钩子导致令牌快照为 `undefined`，已改为调用时取令牌，重跑全绿。真实登录方式、SQLite 持久化与上游对接仍未验证。
- **变更引用**　`main`：本轮代码与 plan.md 修订、本条日志随后提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；会话为内存实现，重启即失效且尚未接入真实登录；存储仍为内存，SQLite 迁移未落地；上游认证、完整裁判 JSON 回读与 Trace 到期后的上游读取待实测。
- **回退**　对承载本轮的提交执行 `git revert` 即可删除 `src/result-api/http.ts`、`src/result-api/http.test.ts` 与 plan.md 本轮修订；`handlers.ts` 与 `src/result-contract/` 不受影响。若需回到无接口状态，再 revert `8d4bbce`。纯新增文件，无迁移、无运行数据，回退不需要数据恢复。

### 2026-11-22 · P1 阻塞期的 SQLite 迁移与结果读取持久化

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-22 14:06（Asia/Shanghai）。
- **改动**　新增 `src/storage/migrations.ts`、`src/storage/sqlite-store.ts`、`src/storage/migrate.ts` 与 `src/storage/sqlite-store.test.ts`。以 Node 22 内置 `node:sqlite` 落地两步前向幂等迁移：`schema_migrations` 记录版本，`runs` 保存运行元数据与冻结规则快照，`samples` 与 `judge_attempts` 按序号保存样本、全部裁判尝试、原始响应和业务 JSON；区分「业务 JSON 缺省」与「合法 null」。`SqliteReadStore` 实现同一 `ReadStore` 接口，在 SQL 的 `id + owner_account_id` 条件中限定归属，三条读取 handler 与 HTTP 层无需改动即可换用持久化存储。`migrate.ts` 提供 `EVAL_DB_PATH=<本机路径> node src/storage/migrate.ts` 入口。`.gitignore` 排除本机 SQLite 文件与 `data/`。[plan.md](plan.md) 的状态行与 P1 并行准备轨道补记本增量；未改 PRD，本轮不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖这些输入的可准备工作。上一轮会话与存储均为内存实现，重启即丢失；本轮把运行索引、规则版本和裁判证据落盘，为 Trace 到期后的本地历史读取与应用重启恢复提供可验证基础。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码；未接入真实登录，会话仍是内存实现。
- **验证**　`node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts`：38/38 通过（原 31 + 新增 7）。迁移测试验证账本 0→2、重复执行返回空、表集合正确且账本版本高于代码时拒绝运行；写入后关闭并重开同一文件，运行记录逐字段一致，三条接口仍给出 A–E 均分 `0.375`／`37.5%`、指标筛选命中 A；归属测试在 SQL 边界确认 `WHERE id=? AND owner_account_id=?` 不返回他人记录、账号 B 不可见 A 的任何尝试行；重试样本保留两次尝试并按 `effectiveAttemptId` 取最终尝试；异构规则在 SQLite 读出后仍按映射得到 88 与 `tone=Pass`；三条接口与内存实现响应逐字节一致。迁移 CLI 连续两次执行输出 `from 0 → to 2, applied [1,2]` 与 `from 2 → to 2, applied []`。仅用 Node 22 内置能力。实机链路、真实登录、会话持久化与上游对接仍未验证。
- **变更引用**　`main`：`3c62fa6`（迁移、存储、CLI、测试、plan.md 与 .gitignore）；本条日志随后提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；会话仍为内存且未接真实登录；本轮只覆盖结果读取的写入与查询，运行队列、定时任务与 P2 其余数据模型尚未迁移；Coze Loop 认证、完整裁判 JSON 回读与 Trace 到期后的上游读取待实测。
- **回退**　对 `3c62fa6` 执行 `git revert` 可删除 `src/storage/`、还原 plan.md 与 .gitignore，保留 `9207225` 的内存存储与之前全部接口；再对承载本条日志的提交执行 revert 即回到上轮记录状态。本轮未产生运行数据，测试数据库仅位于系统临时目录；若曾按 CLI 指向本机路径建库，回退代码后按备份策略自行处理该 SQLite 文件，勿直接删除仍在使用的库。

### 2026-11-23 · P1 阻塞期的服务端会话持久化

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-23 21:05（Asia/Shanghai）。
- **改动**　在 [migrations.ts](src/storage/migrations.ts) 增加前向幂等的迁移版本 3（`sessions` 表：`token_hash`、`account_id`、`created_at`、`expires_at`、`revoked_at`），与既有账本连续编号。新增 [sqlite-session-store.ts](src/storage/sqlite-session-store.ts)：`SqliteSessionStore` 实现 `src/result-api/http.ts` 的 `SessionStore` 接口，`openSqliteSessionStore(filePath, options)` 提供与结果存储同形的入口；令牌由服务端用 `node:crypto` 随机数签发，数据库只存 SHA-256 摘要，支持默认 24 小时有效期、可注入时钟、退出撤销与重复撤销幂等。新增 [sqlite-session-store.test.ts](src/storage/sqlite-session-store.test.ts)（5 项），并把 [sqlite-store.test.ts](src/storage/sqlite-store.test.ts) 的迁移版本与表集合断言更新到版本 3。[plan.md](plan.md) 状态行与 P1 并行准备轨道补记本增量。未改 PRD：本轮只持久化已确认的会话边界，不引入登录路由，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需本机 Docker Compose、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖这些输入的可准备工作。上一轮会话仍是内存实现，应用重启即丢失；本轮把服务端签发的会话落盘，使「重启后旧链接仍可识别登录态」「退出后旧会话立即 401」可复现验证，对齐 P2 的会话失效与双账号验收要求。令牌不明文落库，降低库文件泄露带来的冒充风险。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码；会话创建／撤销仍由服务端代码调用，真实登录方式待负责人选型。
- **验证**　`node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts`：43/43 通过（原 38 + 新增 5）。新增覆盖：账本 0→3、重复执行返回空、降级版本仍被拒绝；库文件不含明文令牌且摘要为 64 位十六进制；关闭后重开同一文件，未撤销会话仍有效、已撤销会话不可恢复、重复撤销不报错；注入时钟下过期会话返回 undefined 而其他会话不受影响；跨账号令牌各解析到签发账号、撤销只标记不删除；HTTP 集成在「重启」后以 Bearer／Cookie 携带旧令牌读到 37.5% 均分与指标筛选命中 A，他人令牌 404，退出后令牌 401。迁移 CLI 连续两次执行输出 `from 0 → to 3, applied [1,2,3]` 与 `from 3 → to 3, applied []`。仅用 Node 22 内置能力。实机链路、真实登录、上游对接与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试、plan.md 修订与本条日志随后提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；真实登录入口、会话清理（过期行回收）与跨设备并发会话管理尚未实现；运行队列、定时任务与 P2 其余数据模型仍未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮的提交执行 `git revert` 可删除 `src/storage/sqlite-session-store.ts` 与测试、把迁移回退到版本 2；注意 revert 不会自动删除已建好的 `sessions` 表，如需清理须在确认无在用会话后手工 `DROP TABLE sessions`。更早的契约、接口与结果持久化不受影响。本轮未产生运行数据，测试库仅位于系统临时目录；若曾对指向本机路径的库签发过会话，回退代码后旧会话将失效，属于预期行为，不要在仍在使用的库上直接删表。

### 2026-11-23 · P2 阻塞期的版本化资源领域契约

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-23 22:10（Asia/Shanghai）。
- **改动**　新增 `src/domain/resources.ts` 与 `src/domain/resources.test.ts`（8 项）。把 P2 独有的数据模型契约先固化为纯逻辑：场景配置、数据集版本、规则版本、任务配置均为带所有者的不可变版本，内容由键顺序无关的 SHA-256 摘要标识，同键同内容幂等、同键改内容拒绝，快照深冻结防外部改写；`ResourceCatalog` 的 get/list 按账号限定，越权与不存在统一返回 undefined，内部 peek 仅供服务端绑定校验区分「不存在」与「他人资源」。`createTaskConfig` 在写入时校验场景／数据集／规则三引用存在且归属同一账号，校验定时时区（Asia/Shanghai）、启用定时的 cron、变量映射完整性与占位符唯一性，全部通过才冻结绑定；`validateRunBindings` 复核运行声明版本与任务已冻结绑定一致且仍属同一账号，否则给出 `TASK_NOT_FOUND`／`BINDING_MISMATCH`。数据集快照校验覆盖缺列、重复列、查询列缺失、行 ID 重复、行数不符与缺校验值。[plan.md](plan.md) 状态行与新增 P2 并行准备轨道、本条日志已同步。未改 PRD：本轮只固化已确认的归属与引用边界，不改变产品行为，不落库、不接 HTTP。
- **原因与影响**　P2 整体依赖 P1 实机验证与负责人确认开工，但其数据模型契约不依赖 Docker／workspace／模型输入。按每轮有界推进约定，先把 P2 关键路径上「版本绑定写入时验证归属和引用关系」固化，供后续 P2 落库与 P4/P5 绑定复用，避免各阶段口径分叉。仅用 Node 22 内置 `node:crypto` 与 `structuredClone`；未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，无数据库迁移与运行数据。
- **验证**　`node --test src/domain/resources.test.ts`：8/8 通过；全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts`：51/51 通过（原 43 + 新增 8），无回归。新增覆盖：稳定序列化键顺序无关、哈希随内容／归属／版本变化时变化；版本幂等写入与改内容拒绝、快照深冻结后外部改写无效；越权／未登录／不存在在 get 层一致查不到、list 只返回本人；数据集快照六类非法输入被拒且不留记录；任务创建成功时绑定冻结且重复同内容幂等、改定时内容被拒；缺失引用／他人资源／缺 cron／重复占位符／非法时区均返回具体字段错误且不落库；运行绑定一致时通过，任务越权、数据集版本漂移均被拒并定位到字段。实机链路、真实登录、上游对接与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试、plan.md 修订与本条日志随后提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置、受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；本轮资源目录为内存实现，尚未落 SQLite 迁移，也未接任务/数据集管理接口与创建向导；场景配置、数据集版本、规则版本、任务配置的持久化与视图、真实登录入口仍待推进；运行队列、定时任务与 P2 其余数据模型未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮的提交执行 `git revert` 即可删除 `src/domain/resources.ts`、`src/domain/resources.test.ts` 及 plan.md 本轮修订，更早的契约、接口、HTTP、结果持久化与会话持久化均不受影响。两个文件为纯新增，删除 `src/domain/` 不影响 `demo/index.html`、四份文档与 `src/` 其余模块。无迁移、无运行数据，回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的版本化资源 SQLite 持久化

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 09:52（Asia/Shanghai）。
- **改动**　在 [migrations.ts](src/storage/migrations.ts) 增加迁移版本 4：`resource_versions` 表以 `resource_kind + id + version` 为主键，保存 `owner_account_id`、`snapshot_json`、`content_hash`、`created_at`，并建 `(resource_kind, owner_account_id, id)` 索引。把 [resources.ts](src/domain/resources.ts) 的内部版本表抽象为可注入的 `VersionStore` 接口，`ResourceCatalog` 同时接受内存实现与存储实现，`createTaskConfig`／`validateRunBindings` 校验逻辑保持唯一；新增 [sqlite-resource-store.ts](src/storage/sqlite-resource-store.ts) 的 `SqliteVersionStore` 与 `SqliteResourceCatalog`／`openSqliteResourceCatalog` 入口，四类版本的写入、归属读取、冻结快照与绑定复核全部落盘。新增 [sqlite-resource-store.test.ts](src/storage/sqlite-resource-store.test.ts)（8 项），并把既有迁移版本断言更新到 4。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只持久化已确认的资源归属与引用边界，不引入管理接口或视图，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但其关键路径上的「版本绑定写入时验证归属和引用关系」已由上一轮固化为纯逻辑；本轮解决该目录重启即丢失的问题，使任务冻结绑定与运行复核可在应用重启后继续按同一口径执行。SQLite 实现与内存实现共用绑定校验代码，避免落盘后口径分叉。仅用 Node 22 内置 `node:sqlite`／`structuredClone`；未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未接真实登录与上游接口。
- **验证**　`node --test src/storage/sqlite-resource-store.test.ts`：8/8 通过；全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts`：59/59 通过（原 51 + 新增 8），无回归。新增覆盖：账本 0→4 与幂等重跑、非法资源种类被 CHECK 拒绝；四类版本落盘且哈希为 64 位十六进制、读出快照深冻结、按账号列表与越权返回；同键同内容（键顺序不同）幂等、改内容与换归属拒绝；跨账号／缺失引用失败不落任务行；关库重开后四类资源与冻结绑定逐字段一致、运行复核一致、版本漂移与任务越权分别返回 `BINDING_MISMATCH`／`TASK_NOT_FOUND`；SQL 边界不返回他人行；内存与 SQLite 目录对同一批数据的读取响应一致。迁移 CLI 连续两次输出 `from 0 → to 4, applied [1,2,3,4]` 与 `from 4 → to 4, applied []`。测试中曾发现冲突分支误用带账号过滤的回读导致换归属时报「无法读取」，已改为回读原行后按哈希与归属判断，重跑全绿。上游实机链路、真实登录与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；本轮只提供版本存储与目录，任务/数据集管理接口、四步向导、视图、真实登录入口与会话过期行清理未做；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 可移除 `src/storage/sqlite-resource-store.ts`、测试与迁移版本 4，并把 `resources.ts` 恢复为内部版本表；随后 revert 本条日志提交。注意 revert 不会自动删除已建好的 `resource_versions` 表，确认无在用数据后按备份策略另行处理，不要在仍在使用的库上直接删表。测试库仅在系统临时目录；本轮未产生运行数据，代码回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的资源列表、详情与写入接口骨架

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 11:03（Asia/Shanghai）。
- **改动**　新增 `src/resource-api/handlers.ts` 与 `src/resource-api/handlers.test.ts`（12 项）。把场景配置、数据集、规则、任务配置四类资源的列表、详情、写入固化为 HTTP 无关的 handler：账号只来自服务端 `AuthContext`，请求体自称的 `ownerAccountId` 一律不读；读取经 `ResourceCatalog` 按账号限定，越权与不存在统一 404；写入复用同一份领域校验、内容哈希与任务绑定复核，返回新版本 201、同键同内容幂等 200 且 `replayed: true`、改内容或换归属 409、绑定/输入错误 422 并带逐字段 `issues`；列表与详情按 `id + version` 稳定排序，快照沿用领域层深冻结。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只暴露已确认的归属与不可变边界，不引入管理页视图、复制/归档或真实登录，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但上一轮已把四类版本落盘；本轮补齐关键路径上「服务端写入归属、读取限定账号」的可执行写接口，让三 Tab 管理页后续可直接挂接同一 handler。内存与 SQLite 目录共用一份实现，避免落盘后错误码和归属口径分叉。仅用 Node 22 内置能力；未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移，未接 HTTP 或上游接口。
- **验证**　`node --test src/resource-api/handlers.test.ts`：12/12 通过；全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts src/resource-api/handlers.test.ts`：71/71 通过（原 59 + 新增 12），无回归。新增覆盖：未登录三操作 401 且目录不变；列表只含本人且稳定排序、新账号空列表；详情本人可读且快照改写被拒、越权与不存在同为 404；创建场景归属取自会话、自称归属被忽略；同一写接口创建数据集与规则；键顺序不同的重写幂等 200、改内容与换归属 409；非法数据集快照 422 且不落库；任务三引用齐全时冻结绑定、详情按账号限定；他人数据集引用、缺 cron、规则缺失分别返回 `OWNER_MISMATCH`／`binding.schedule.cron`／`RULE_NOT_FOUND` 且不落任务；任务幂等与改绑定 409；缺 id/version、非对象、未知种类 400；写接口直接作用于 SQLite 目录，关库重开后任务列表与详情逐字段一致、他人列表为空、重复提交仍幂等。测试库仅在系统临时目录。上游实机链路、真实登录、HTTP 挂载与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；本轮 handler 尚未挂 HTTP，未接管理页视图、搜索筛选候选、分页计数、复制与归档；真实登录入口未做，会话过期行清理未做；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `src/resource-api/` 与 plan.md 本轮修订，交易口、结果读取、会话与版本化资源持久化均不受影响。两个文件为纯新增，无新迁移、无 HTTP 路由变更；测试库仅位于系统临时目录并在测试结束时删除，代码回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的资源接口 HTTP 挂载

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 13:43（Asia/Shanghai）。
- **改动**　新增 `src/resource-api/http.ts` 与 `src/resource-api/http.test.ts`（10 项）。把四类资源的列表、详情、写入挂到 `node:http`：`GET /api/resources/:kind`、`GET /api/resources/:kind/:id/:version`、`POST /api/resources/:kind`。身份复用 `src/result-api/http.ts` 的 `SessionStore` 与 `sessionAccountFromRequest`，支持服务端签发的 Cookie／Bearer 令牌；请求体 `ownerAccountId` 与查询参数 `accountId` 均不参与鉴权。POST 只接受 `application/json`、默认 1 MiB 上限，非法编码／空体／非对象／错误媒体类型／超限分别返回 400／400／400／415／413；越权与不存在统一 404，写入错误码及逐字段 `issues` 原样透出，幂等重放以 `x-replayed: true` 响应头暴露，所有响应 `Cache-Control: no-store`。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：只暴露已确认的资源归属与不可变边界，不引入视图或登录方式，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但上一轮已固化 HTTP 无关的写接口；本轮补齐其传输与身份边界，使三 Tab 管理页后续可直接请求与结果读取接口同一套会话语义的服务。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移；会话仍由服务端代码签发，真实登录入口未做。
- **验证**　`node --test src/resource-api/http.test.ts`：10/10 通过；全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：81/81 通过（原 71 + 新增 10），无回归。新增覆盖：未登录／伪造令牌对列表、详情、写入均 401 且自报账号无效；列表按账号限定并稳定排序、新账号为空；四类资源详情可读、他人资源与不存在资源响应完全一致；写入归属取自会话且自称归属被忽略；乱序同内容 200 + `x-replayed`、改内容与换归属 409；非法数据集与越界任务绑定 422 并给出逐字段 `issues` 且不落库；含斜杠 ID 编码后可读写；405 带 `Allow`、未知路径 404、坏 JSON 400、错误媒体类型 415、空体 400、数组体 400、超限 413；撤销会话立即 401、`no-store` 生效；SQLite 目录经 HTTP 写入四类资源后关库重开，列表与详情逐字段一致且他人列表为空。首次运行曾因 Node 22 strip-only 模式不支持构造参数属性、以及测试未从新模块导入 `InMemorySessionStore` 报错，均已修正后全绿。测试仅监听 127.0.0.1 临时端口，测试库在系统临时目录。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；未接管理页视图、搜索筛选候选、分页计数、复制与归档；真实登录入口与会话过期行清理未做；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `src/resource-api/http.ts`、`src/resource-api/http.test.ts` 与 plan.md 本轮修订；`src/resource-api/handlers.ts`、结果读取 HTTP、会话与版本化资源持久化均不受影响。两个文件为纯新增，无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的配置副本接口

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 14:10（Asia/Shanghai）。
- **改动**　在 `src/resource-api/handlers.ts` 新增 `copyManagedResource`，在 `src/resource-api/http.ts` 挂 `POST /api/resources/:kind/:id/:version/copy`，并在两个测试文件补充 6 项测试。源按账号限定，越权与不存在统一 404；副本生成新 ID（可显式指定，省略时用 `randomUUID` 短段生成），场景／数据集／规则整份沿用源快照，任务整份沿用已冻结绑定，归属改写为会话账号，请求体自称归属被忽略。副本只经写入接口落配置，不触发运行；复用源 ref 返回 400，同键同内容幂等 200 且 `x-replayed: true`。复制请求体可选，空体可用；GET 该路径 405 且 `Allow: POST`。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改 PRD：本轮落实 [readme.md](prd.md#管理页) 已确认的「复制生成带新 ID 的配置副本」，不改变未确认行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但管理页验收标准第 1 条明确要求「复制生成新 ID，且任务复制不会发起正式运行」。本轮把它固化为与写入共用校验的可复现接口，供后续三 Tab 管理页直接挂接。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`node --test src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：27/27 通过；全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：89/89 通过（原 81 + 新增 8），无回归。新增覆盖：场景／任务副本 201 且 ID 改变、快照与冻结绑定逐字段一致、请求体自称归属被忽略、源版本不变；服务端生成 ID 符合 `ds-support-copy-*` 格式、显式 ID 重复提交幂等 200；他人源与不存在源同 404、同 ref 400、空 id 与数组体 400、未登录 401；HTTP 副本归属隔离、空请求体可复制、GET 405 带 `Allow: POST`、任务副本不产生运行记录。修复了测试中将 AuthContext 对象当作账号字符串传入目录、内容哈希断言（哈希含 ref.id 故副本哈希应不同）、以及源任务未在 fixture 中创建三处测试错误；并修正 HTTP 路由方法判定，避免 GET 命中复制路径时误返源详情。仅 Node 22 内置能力，临时端口与临时库。
- **变更引用**　`main`：本轮改动随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；未接管理页视图、搜索筛选候选与分页计数、归档与引用任务提示；真实登录入口与会话过期行清理未做；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可删除 `copyManagedResource` 与复制路由及测试，restore plan.md 本轮修订；既有列表／详情／写入接口不受影响。本轮无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-24 · 会话过期行清理

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 14:04（Asia/Shanghai）。
- **改动**　在 [sqlite-session-store.ts](src/storage/sqlite-session-store.ts) 给 `SqliteSessionStore` 增加 `purgeExpired(): number`：按注入时钟以 `expires_at <= now` 删除已过期会话行，返回删除行数便于运维观察，重复调用返回 0。只删除过期行；未过期会话和其撤销标记保留，维持「撤销后不可恢复」与退出审计语义；过期行本就被 `accountFor` 拒绝，删除不改变授权可见行为。新增 [sqlite-session-store.test.ts](src/storage/sqlite-session-store.test.ts) 两项测试，覆盖「只删过期行、保留仍有效会话、幂等、清理前后授权一致、重开库后仍有效」与「未过期撤销标记先保留、过期后才回收」。[plan.md](plan.md) P1 并行准备轨道补记本增量。未改 PRD：本轮只回收已失效会话的磁盘行，不改变登录／退出／归属边界，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、模型配置与受控样本，继续推进不依赖输入的可准备工作。上一轮已把服务端会话落盘并支持撤销与到期失效，但失效行永不回收会持续增长；本轮补上可运维、可幂等验证的过期清理，不接真实登录、不改变会话签名与鉴权口径。仅用 Node 22 内置 `node:sqlite`／`node:crypto`；未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移（复用现有 `sessions` 表）。
- **验证**　`node --test src/storage/sqlite-session-store.test.ts`：7/7 通过（原 5 + 新增 2）。稳定文件集 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts`：61/61 通过（原 59 + 新增 2），无回归。新增覆盖：注入时钟下过期两枚与仍有效两枚共存时 `purgeExpired` 恰好删除 2 行、重复调用为 0、行数由 4 降到 2；清理前后有效令牌仍解析本人、过期与撤销令牌仍为 undefined；重开库后有效会话仍可用且再次清理为 0；未过期撤销令牌其 `revoked_at` 不被清理删除，过期后才回收到 0 行。首次运行曾因测试时间线让 `survivor` 在推进时钟前签发而误过期，已改为推进时钟后再签发，重跑全绿。说明：验证时 `src/resource-api/` 下有并发 Agent 正在修改（资源复制功能，未提交），本轮测试刻意不含这些文件，也未提交它们；待其稳定后需单独全量回归。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。仅 `src/storage/sqlite-session-store.ts` 与其测试、plan.md 本轮修订属于本轮。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；真实登录入口未做，`purgeExpired` 目前需服务端主动调用、尚未接入定时回收；`src/resource-api/` 下并发的资源复制改动未纳入本轮验证与提交；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `purgeExpired()` 与两项测试，会话的签发／撤销／过期判定与既有 5 项测试均不受影响。本轮未新增迁移，无需删表；未产生运行数据，测试库仅位于系统临时目录并在结束时删除，代码回退不需要数据恢复。

### 2026-11-24 · 更正：配置副本轮次的测试计数

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 14:12（Asia/Shanghai）。
- **更正对象**　上条「P2 阻塞期的配置副本接口」的「验证」与「回退」两行。
- **更正内容**　本轮实际新增 6 项测试（handler 3 + HTTP 3），另有并行轮次的会话过期清理新增 2 项，故资源接口两文件为 `28/28`、全量九文件为 `89/89`（81 + 并行 2 + 本轮 6）。原文「27/27」「原 81 + 新增 8」的归因不准确，以此条为准；测试本身均通过，无失败项。回退行中的「restore plan.md 本轮修订」应为「还原 plan.md 本轮修订」。
- **并行说明**　会话过期清理由另一 Agent 于 14:04–14:05 独立提交（`d765350`、`6720135`），其日志条目已保留在本文件末尾；本轮提交为 `7bee417`（代码+计划）与 `780008a`（日志），两者均已确认共存于 `main`，无文件冲突。

### 2026-11-24 · P2 阻塞期的列表搜索筛选、稳定排序与分页

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 15:06（Asia/Shanghai）。
- **改动**　在 `src/resource-api/handlers.ts` 扩展 `listManagedResources`：新增可选第四参数 `ResourceListQuery`（`q` 名称/ID 模糊且不区分大小写、`name` 与 `id` 精确、`ownerAccountId` 创建人、`sortBy` 为 id/name/createdAt、`order` 为 asc/desc、`page` 1 起始、`pageSize` 上限 200 默认 50）。筛选一律在 `ResourceCatalog` 账号限定后的集合上进行，创建人筛选只接受会话账号、他人账号直接得到空集合；排序主键相同时依次以 id、version 兜底且方向跟随 order，保证确定；`total` 为筛选后命中总数、不受分页影响；响应新增 `query` 回显生效的排序与分页。无查询参数时保持既有 id/version 升序全量返回，旧调用方零改动。新增 `resourceDisplayName`（场景/数据集/规则取快照 name，任务回退 ID）、排序/页大小校验辅助与 `MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE` 常量。在 `src/resource-api/http.ts` 增加 `parseListQuery`，把列表 GET 的查询串透传到同一 handler：未知参数忽略，数值参数无法解析时交给 handler 统一 400，不另立校验口径。两个测试文件共新增 8 项测试。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮固化 [readme.md](prd.md#管理页) 已确认的「按 ID／名称／创建时间／创建人筛选、稳定排序、分页」，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但列表筛选/排序/分页是管理页验收标准第 1 条的关键路径，且不依赖 Docker／workspace／模型／样本。本轮把它固化为内存与 SQLite 共用的一份逻辑，避免落盘后筛选口径分叉。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移，未接管理页视图与真实登录。
- **验证**　`node --test src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：36/36 通过（原 28 + 新增 8）。全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：97/97 通过（原 89 + 新增 8），无回归。新增覆盖：q 大小写不敏感匹配名称或 ID、name/id 精确匹配、他人同名场景经账号限定后不出现；createdAt/name 升降序与主键相同时的 id+version 兜底、无参时既有排序不变；分页 total 不随页码变化、页越界返回空、query 回显准确；创建人筛选他人账号为空；sortBy/order/page/pageSize/q 非法值 400；展示名回退；HTTP 层查询串透传、未知参数忽略、400 错误码稳定。HTTP 筛选测试自建独立 catalog 与 127.0.0.1 临时端口，不依赖共享状态。仅用 Node 22 内置能力，未起 Docker、未装依赖、未调模型。上游实机链路、真实登录与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；未接管理页视图、归档与引用任务提示；真实登录入口未做；运行队列、定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `listManagedResources` 的查询参数与筛选/排序/分页、`parseListQuery`、8 项测试及 plan.md 本轮修订，既有列表/详情/写入/复制接口不受影响；随后 revert 本条日志提交。本轮无新迁移与运行数据，测试库仅位于系统临时目录并在结束时删除，代码回退不需要数据恢复。

### 2026-11-24 · 修复管理列表、任务名称和复制校验

- **Agent**　Codex，2026-11-24（Asia/Shanghai）。
- **改动**　任务、数据集、规则列表默认按实际创建时间倒序。HTTP 列表支持按上海日期筛选，包含起止日，支持单边查询。演示页对反填日期显示提示，保留上次查询结果。新建任务校验名称，列表和详情返回同一展示名。复制时要求副本使用独立 ID。
- **历史数据**　旧版 SQLite 无名任务按 ID 展示、搜索，原请求可幂等重放。复制这类任务时用源 ID 作为新副本名称。原版本及其内容哈希保留。本次无需数据库迁移。
- **验证**　修复前用回归测试复现默认排序错误、无名新任务被接受。修复后运行 `node --test src/{domain,resource-api,result-api,result-contract,storage}/*.test.ts`，全部 100 项通过。覆盖真实 HTTP、SQLite 重启读取、上海午夜边界、跨账号筛选和历史副本。浏览器实测 11 月 20 日同日筛选返回两条演示任务，刷新后反填日期提示错误并保留六条初始结果。真实 Agent 调用、裁判评分和前后端联调仍待验证。
- **变更引用与回退**　基线为 `main` 的 `5aeb2d3`。代码、回归测试、计划和本条记录在提交 `Fix management list filters, task names and copy IDs` 中。对该提交执行 `git revert <提交号>`，复跑上述测试并追加回退记录。已保存的任务可继续按原 SQLite 格式读取。

### 2026-11-24 · P2 阻塞期的 CSV 导入快照契约

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 16:20（Asia/Shanghai）。
- **改动**　新增 `src/domain/imports.ts` 与 `src/domain/imports.test.ts`（12 项）。把 [plan.md](plan.md) P2「显式选查询字段、冻结列名／行 ID／行顺序／内容校验值和来源元数据、固定文件／行数／单元格大小限制、验证缺列／重复列／非文本／空值／多行 CSV／UTF-8 BOM／Excel 公式」中不依赖上游的部分固化为纯函数 `parseDatasetCsv`：CSV 解析支持 UTF-8 BOM 剥除、CRLF/LF、带引号字段、跨行字段与 `""` 转义；行 ID 按行序稳定生成（`R000001` 起）并深冻结，内容校验值由列名、行 ID、行顺序、逐行文本、查询列与来源做稳定 SHA-256；来源限定 `excel`／`csv`／`feishu`／`sql` 四值，与 `DatasetSnapshot.source` 对齐；上限可由调用方覆盖，默认 5 MiB／10000 行／4000 字符。失败返回可定位的 `code`／`field`／1 起始行号，覆盖空文件、超字节、超行、空表头、空列名、重复列、查询列缺失或为空、行宽不一致、单元格超限、控制字符非文本、Excel 公式（纯数值负号／小数不误判）；只读取有明确列映射的文本值，公式不求值不缓存。成功产出的 `DatasetSnapshot` 无需改写即可交 `ResourceCatalog.putDataset`，同内容幂等、改动即新校验值。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只落实已确认的「显式查询字段、冻结版本、来源标记、字段级报错」，未引入 Excel 工作表选择等未定行为，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但数据集导入是首条验收链路的入口且完全不依赖 Docker／workspace／模型／样本。此前 `DatasetSnapshot` 只有结构校验，缺少「从文件到快照」的可复现取值口径；本轮先把 CSV 文本路径固化，使后续导入界面与 SQLite 快照写入共用一份校验与哈希，避免口径分叉。仅用 Node 22 内置 `node:crypto`／`structuredClone`；不读取文件、不访问网络、不启动 Docker、不安装依赖、不调用模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`node --test src/domain/imports.test.ts`：12/12 通过。全量 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/storage/sqlite-resource-store.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：112/112 通过（原 100 + 新增 12），无回归。覆盖：正常 CSV 产出冻结快照并可直接写入版本目录（越权账号查不到）、同内容重复解析校验值一致而行序或单元格改动校验值变化、BOM 不污染表头且 CRLF 与 LF 等价、跨行与 `""` 转义引号还原、空文件／空表头／缺列／重复列逐项报错、查询列缺失或空值按行号定位、行宽不一致与非文本控制字符定位、公式单元格拒绝且负数小数保留、四来源元数据与未知来源拒绝、可覆盖上限强制执行、同键同内容幂等且改内容被版本目录以「不可变」拒绝、导入数据与规则版本同轴可用。首次运行曾因用改 `rowCount` 触发快照自身行数校验而非版本目录不可变校验，改为改合法 `name` 后全绿。仅 Node 22 内置能力，无临时端口与临时库。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；Excel `.xlsx`（工作表选择与公式缓存值）解析、导入接口与界面、飞书／SQL 上传链路未做；管理页视图、归档与引用任务提示、真实登录入口、运行队列／定时任务与 P2 其余数据模型尚未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `src/domain/imports.ts`、`src/domain/imports.test.ts` 与 plan.md 本轮修订，随后 revert 本条日志提交；既有 `resources.ts` 领域契约、资源接口与结果读取接口不受影响。两个文件为纯新增，无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的导入行内容持久化

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 20:45（Asia/Shanghai）。
- **改动**　新增 `src/domain/dataset-rows.ts` 与 `src/domain/dataset-rows.test.ts`（6 项），把 CSV 导入的逐行单元格固化为与数据集版本绑定的不可变行集合：`DatasetRowSet` 以 `VersionRef` 定位并携带与 `DatasetSnapshot.contentChecksum` 对齐的校验值，`datasetRowsHash` 覆盖校验值与全部行；`InMemoryDatasetRowStore` 实现同键同内容幂等、改内容或换归属拒绝、读取按账号限定、快照深冻结；`importDataset` 把一次 `parseDatasetCsv` 结果同时写入 `ResourceCatalog` 与行存储，写入前复核快照校验值／行数／行 ID 与导入一致、任一侧漂移即拒绝，不产生「有元信息、无单元格」的半成品。新增 SQLite 迁移版本 5（`dataset_row_sets` 头表 + `dataset_rows` 单元格表，外键级联、行 ID 唯一、归属索引）与 `src/storage/sqlite-dataset-rows.ts`、`src/storage/sqlite-dataset-rows.test.ts`（5 项）：`SqliteDatasetRowStore` 实现同一 `DatasetRowStore` 语义，归属在 SQL WHERE 限定，行按 ordinal 读出、关库重开后逐字段一致，内存与 SQLite 响应一致。三个既有存储测试的迁移断言更新到版本 5。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只持久化已确认的「冻结行 ID／行顺序／内容校验值与来源」，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但导入是首条验收链路入口，且完全不依赖 Docker／workspace／模型／样本。上一轮只固化了「文件→快照」的元信息取值，快照不含单元格，若仅写版本目录则查询与回答文本全部丢失，后续 Runner 与结果核对无从按行取值。本轮补齐这一缺口，使导入快照在数据层完整可用。仅用 Node 22 内置 `node:sqlite`／`node:crypto`／`structuredClone`；不读取文件、不访问网络、不启动 Docker、不安装依赖、不调用模型、未修改 `upstream/` 两份源码；未接导入接口／界面与真实登录。
- **验证**　`node --test src/domain/dataset-rows.test.ts`：6/6；`node --test src/storage/sqlite-dataset-rows.test.ts`：5/5。全量 12 个测试文件 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/domain/dataset-rows.test.ts src/storage/sqlite-resource-store.test.ts src/storage/sqlite-dataset-rows.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts`：123/123 通过（原 112 + 新增 11），无回归。覆盖：行内容哈希随校验值／单元格变化、写入后按账号读取且深冻结、重复键同内容幂等与改内容／换归属拒绝、非法行集合（空／重复行 ID、非对象 cells、非文本值）拒绝、importDataset 写元信息与行且重放幂等、校验值／行数／行 ID 不符与任一侧漂移都拒绝且不产生半成品；迁移 0→5 与幂等、头表／单元格表结构与外键拒绝悬空行、关库重开后中文与跨行与转义引号单元格逐字段一致、越权 SQL 条件过滤、冲突不改已有行、内存与 SQLite 逐字段一致。迁移 CLI 连续两次输出 `from 0 → to 5, applied [1,2,3,4,5]` 与 `from 5 → to 5, applied []`。仅 Node 22 内置能力，临时端口无、临时库在系统临时目录并自动清理。上游实机链路、真实登录与完整裁判 JSON 回读仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；导入接口与界面、飞书／SQL 上传链路、Excel `.xlsx` 工作表选择与公式缓存值未做；行存储尚未挂 HTTP，管理页视图、归档与引用任务提示、真实登录入口、运行队列／定时任务与 P2 其余数据模型未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 可移除 `src/domain/dataset-rows.ts`、其测试、`src/storage/sqlite-dataset-rows.ts`、其测试、迁移版本 5 与 plan.md 本轮修订，并把三个存储测试的迁移断言还原到版本 4；既有 `imports.ts`、`resources.ts`、资源接口与结果读取接口不受影响。注意 revert 不会自动删除已建好的 `dataset_row_sets`／`dataset_rows` 表，确认无在用数据后按备份策略另行处理，不要在仍在使用的库上直接删表。本轮未产生运行数据，测试库仅位于系统临时目录，代码回退不需要数据恢复。

### 2026-11-24 · P2 阻塞期的数据集导入接口与行读取

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-24 21:57（Asia/Shanghai）。
- **改动**　新增 `src/import-api/handlers.ts` 与 `src/import-api/http.ts`，把 `parseDatasetCsv` 与 `importDataset` 串为一次可复现的导入：`POST /api/imports/dataset` 解析 CSV 后同时写入数据集版本目录与行集合，`GET /api/imports/dataset/:id/:version/rows` 读回该版本的冻结行。请求体字段为 `id`／`version`／`name`／`queryColumn`／`csv`，可选 `source` 与 `limits`；账号只来自服务端会话（Cookie／Bearer），`ownerAccountId` 自报值被忽略。解析错误 422 带列／数据行号／原因的 `issues`，形状或上限非法 400，媒体类型错误 415，体积超限 413，内容变更或换归属 409，同键同内容 200 + `x-replayed`，未知路径 404、错误方法 405 带 `Allow`，全部响应 `no-store`。新增 `handlers.test.ts`（7 项）与 `http.test.ts`（6 项）。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只暴露已确认的「显式查询字段、冻结版本、来源标记、逐行内容落盘」链路，未接上传界面与未确认的 Excel 行为，不改变产品行为。
- **原因与影响**　P2 整体仍依赖 P1 实机验证与负责人确认开工，但导入是首条验收链路入口，且不依赖 Docker／workspace／模型／样本。上一轮已把 CSV 解析与行内容持久化分别固化，缺少把它们串起来并对外可用的写入与读取边界；本轮补齐后可经 HTTP 复现「文件文本 → 冻结快照 + 真实单元格 → 按账号读回」，内存与 SQLite 共用一份 handler，避免落盘后口径分叉。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移（复用版本 5 的表）。
- **验证**　`node --test src/import-api/handlers.test.ts src/import-api/http.test.ts`：13/13 通过。全量 14 个测试文件 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/domain/dataset-rows.test.ts src/storage/sqlite-resource-store.test.ts src/storage/sqlite-dataset-rows.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts src/import-api/handlers.test.ts src/import-api/http.test.ts`：136/136 通过（原 123 + 新增 13），无回归。新增覆盖：一次写入两侧且归属取自会话、自报归属无效、行内容不落到他人账号；重复导入 200 幂等且逐字段一致；空查询／公式单元格／超限行返回 422 与定位信息且不落库；同版本改名 409 且原快照与行不变；未登录 401、形状错误 400；行读取越权与不存在同 404、深冻结不可改写；HTTP 层坏 JSON 400、空体 400、数组体 400、错误媒体类型 415、超限 413、解析问题 422、版本冲突 409、撤销会话后立即 401、编码 ID 与 405/404；SQLite 关库重开后重放仍 200 + `x-replayed`、中文／跨行／转义引号单元格逐字段一致、另一账号 404。首次运行两项测试失败：伪造令牌含非 ASCII 字符导致 fetch 头报错、体积上限设得高于测试载荷，均改为 ASCII 令牌与 120 字节上限后全绿。仅用 Node 22 内置能力，临时端口仅监听 127.0.0.1，临时库在系统临时目录并自动清理。真实登录、上传界面与上游实机链路仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；上传接口界面、Excel `.xlsx` 工作表选择与公式缓存、飞书／SQL 上传链路未做；导入接口尚未接真实登录（会话由服务端代码签发）；运行队列／定时任务与 P2 其余数据模型未落库；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `src/import-api/` 与 plan.md 本轮修订，随后 revert 本条日志提交；既有 `imports.ts`、`dataset-rows.ts`、资源接口与结果读取接口不受影响。四个文件为纯新增，无新迁移与运行数据；若曾把接口指向本机库写入过导入数据，回退代码不影响已落盘的 `dataset_row_sets`／`dataset_rows` 行，确认无需保留后按备份策略处理。代码回退不需要数据恢复。

### 2026-11-25 · P2 阻塞期的 Excel 工作簿读取边界

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25 12:52（Asia/Shanghai）。
- **改动**　新增 `src/domain/xlsx.ts` 与 `src/domain/xlsx.test.ts`（8 项）。只用 Node 22 内置 `node:zlib` 直接读取真实 OOXML/ZIP 容器：`inspectXlsx` 列出全部工作表名供界面显式选择；`readXlsxSheet` 按名称或 1 起始序号读取选定工作表，解析共享字符串、`inlineStr`、数字、布尔、错误与公式缓存文本，补齐稀疏行列后返回深冻结文本网格，含 `<f>` 的单元格保留缓存值并标记 `hasFormula`，本层不求值、不改 CSV 路径「公式单元格不参与导入」的既有决策。文件字节／解压字节／条目／行列／单元格字符均有上限，坏容器、坏 XML、缺失部件、未知工作表与下标越界分别返回 `EMPTY_FILE`／`NOT_ZIP`／`MALFORMED_ZIP`／`ENTRY_TOO_LARGE`／`MISSING_PART`／`MALFORMED_XML`／`SHEET_NOT_FOUND`／`INVALID_CELL` 等可定位问题（含行列号）。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：本轮只固化已确认的「显式选 Excel 工作表与查询字段、公式缓存值、只读取明确可用的值」中的文件边界，不改变产品行为；未接数据集快照校验与 HTTP 导入接口。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖这些输入的可准备工作。此前 `source: 'excel'` 已在四来源中，但只有 CSV 文本解析路径，Excel 导入验收链路缺少「文件→工作表→文本网格」的可复现边界；本轮补上该边界并按既有 CSV 的冻结与上限口径设计，使后续 `parseDatasetXlsx` 与导入接口可复用同一份取值语义。测试夹具在测试内生成含中央目录、CRC 与 deflate 条目的真实最小 `.xlsx` 字节，不用第三方库；不读取本机文件、不访问网络、不安装依赖、不调用模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`node --test src/domain/xlsx.test.ts`：8/8 通过。全量 15 个测试文件 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/domain/dataset-rows.test.ts src/domain/xlsx.test.ts src/storage/sqlite-resource-store.test.ts src/storage/sqlite-dataset-rows.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts src/import-api/handlers.test.ts src/import-api/http.test.ts`：144/144 通过（原 136 + 新增 8），无回归；开轮基线亦为 136/136。新增覆盖：中文、逗号、换行与实体解码逐格一致；多表按名称／序号／默认选择且表名含 `&`；共享字符串与 `xml:space` 空格保留；公式标记与数字／字符串／布尔／错误／空单元格分类；稀疏列与 AA 列映射的矩形补齐；结果深冻结；空文件、非 ZIP、缺部件、未知表、非法 sheet 参数；文件／条目／解压／行数／列数／单元格上限与坏 XML。仅用 Node 22 内置能力，无临时端口、无临时库。真实 Excel 文件手选工作表、飞书／SQL 链路与上游实机链路仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；工作簿网格尚未接入 `parseDatasetXlsx` 与 `POST /api/imports/dataset`，Excel 工作表选择界面、上传链路、飞书／SQL 导入、归档与引用提示、真实登录入口、运行队列／定时任务仍未做；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可删除 `src/domain/xlsx.ts`、`src/domain/xlsx.test.ts` 与 plan.md 本轮修订，随后 revert 本条日志提交；`imports.ts`、`dataset-rows.ts`、资源接口、导入接口与结果读取接口不受影响。两个文件为纯新增，无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-25 · P2 阻塞期的 Excel 网格接入导入快照

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25 13:53（Asia/Shanghai）。
- **改动**　在 `src/domain/imports.ts` 新增 `parseDatasetXlsx(bytes, options)` 与 `ParseXlsxOptions`：按显式工作表名或 1 起始序号调用 `readXlsxSheet`，把冻结文本网格跳过完全空行后无损归一为带引号 CSV 字段（引号 `""` 转义、行间 CRLF），再交 `parseDatasetCsv` 完成列名、查询列、行 ID、内容校验值与上限校验，产出可直接写入版本目录和行存储的 `DatasetImport`。来源默认 `excel`；`ImportIssue` 新增可选列号，`ImportIssueCode` 并入 xlsx 文件层错误码，文件层问题连同行列与部件字段原样映射。公式单元格以 `hasFormula` 为权威标记一律拒绝并按列字母／数据行号（表头公式无数据行号）报错；为 `ParseCsvOptions` 增加可选 `formulaDetection: 'prefix' | 'external'`，xlsx 路径传 `external` 关闭文本前缀判定，避免同一单元格重复报错。新增 `src/domain/xlsx-import.test.ts`（9 项）。[plan.md](plan.md) 状态行与 P2 并行准备轨道已同步。未改 PRD：只落实已确认的「显式选工作表与查询字段、冻结校验值、公式单元格不参与导入」，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、模型配置与受控样本，继续推进不依赖输入的可准备工作。上一轮只把 `.xlsx` 文件读成文本网格，尚未产出导入契约；本轮把网格接到既有导入链路并刻意复用 CSV 校验实现，避免 Excel 与 CSV 两条路径的校验值、行 ID 和错误码分叉。Excel 的公式缓存值不作为评分输入证据；未修改 CSV 既有默认口径。仅用 Node 22 内置能力，不读本机文件、不访问网络、不安装依赖、不调用模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`node --test src/domain/xlsx-import.test.ts`：9/9 通过。全量 16 个测试文件 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/domain/dataset-rows.test.ts src/domain/xlsx.test.ts src/domain/xlsx-import.test.ts src/storage/sqlite-resource-store.test.ts src/storage/sqlite-dataset-rows.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts src/import-api/handlers.test.ts src/import-api/http.test.ts`：153/153 通过（原 144 + 新增 9），无回归。覆盖：来源为 excel 的冻结快照可直接写入版本目录且越权查不到；同网格 Excel/CSV 行列与逐行文本一致、仅来源改变校验值、重复解析幂等；按名称／序号／默认选表；中文、逗号、跨行、引号与 `&` 逐格一致且空行不生成幽灵行；公式单元格（含缓存值看似普通文本）按列与数据行号拒绝、表头公式同样拒绝；缺列／重复列／空查询沿用 CSV 报错；`SHEET_NOT_FOUND`／`NOT_ZIP` 映射；文件／解压／行数／单元格上限透传；与 `importDataset` 串联写入两侧且重放幂等、行内容不丢。首次运行两项失败：测试夹具把 `&#10;`／`&amp;` 二次转义，以及公式缓存值同时触发 CSV 前缀规则造成重复报错，分别改为原始字符与 `formulaDetection: 'external'` 后全绿。真实 Excel 文件手选工作表、导入 HTTP 入口、飞书／SQL 链路与上游实机链路仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；工作簿网格尚未挂到 `POST /api/imports/dataset`（Excel 入口需传文件字节、表名与显式查询列），工作表选择界面、上传链路、飞书／SQL 导入、归档与引用提示、真实登录入口、运行队列／定时任务仍未做；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `parseDatasetXlsx`、`ParseXlsxOptions`、`ImportIssue.column`、XLSX 错误码并入、`formulaDetection` 与新增测试，并把 plan.md 还原；`imports.ts` 的 CSV 默认行为、`xlsx.ts`、`dataset-rows.ts` 与导入接口不受影响。随后 revert 本条日志提交。本轮无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-25 · P2 阻塞期的 Excel 导入 HTTP 入口

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25 15:09（Asia/Shanghai）。
- **改动**　在 `src/import-api/handlers.ts` 新增 `importDatasetFromXlsx`、`DatasetXlsxImportInput` 与私有校验 `decodeBase64`／`parseSheet`；在 `src/import-api/http.ts` 挂 `POST /api/imports/dataset/xlsx`，`ParsedRoute` 增加 `xlsx-import`，POST 判定改为按路由类别取允许方法。Excel 工作簿字节以 base64 文本字段 `xlsxBase64` 提交，显式选表 `sheet` 接受工作表名或 1 起始正整数、省略读第一张，来源默认 `excel`；handler 严格校验 base64 字符集／长度与选表形状，再交 `parseDatasetXlsx` 归一，复用与 CSV 完全相同的 `importDataset` 写入、同键同内容幂等 200 + `replayed` 与改内容／换归属 409 路径。身份只来自服务端会话（Cookie／Bearer），请求体自称 `ownerAccountId` 被忽略；错误码与逐字段 `issues` 原样透出，所有响应 `no-store`。新增测试夹具 `src/import-api/xlsx-test-fixture.ts`（测试内生成真实最小 OOXML/ZIP 字节并返回 base64），两测试文件共新增 6 项。[plan.md](plan.md) 状态行与 P2「Excel 网格接入导入快照」后新增本增量说明。未改 PRD：本轮只把已确认的「显式选工作表／查询字段、来源标记、冻结快照与逐行落盘」经 HTTP 入口暴露，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖输入的可准备工作。上一轮已把 Excel 网格归一为与 CSV 同口径的导入契约，但未挂 HTTP，文件字节无法经接口进入导入链路；本轮补齐该入口，使 Excel 与 CSV 两条路径共用同一份写入、归属、幂等与错误映射，避免落盘后口径分叉。仅用 Node 22 内置 `node:zlib`／`node:crypto`；不读本机文件、不访问网络、不启动 Docker、不安装依赖、不调用模型、未修改 `upstream/` 两份源码，未新增迁移（复用版本 5 的表）。
- **验证**　`node --test src/import-api/handlers.test.ts src/import-api/http.test.ts`：19/19 通过（原 13 + 新增 6）。全量 16 个测试文件 `node --test src/result-contract/contract.test.ts src/result-api/handlers.test.ts src/result-api/http.test.ts src/storage/sqlite-store.test.ts src/storage/sqlite-session-store.test.ts src/domain/resources.test.ts src/domain/imports.test.ts src/domain/dataset-rows.test.ts src/domain/xlsx.test.ts src/domain/xlsx-import.test.ts src/storage/sqlite-resource-store.test.ts src/storage/sqlite-dataset-rows.test.ts src/resource-api/handlers.test.ts src/resource-api/http.test.ts src/import-api/handlers.test.ts src/import-api/http.test.ts`：159/159 通过（原 153 + 新增 6），无回归；开轮基线亦为 153/153。新增覆盖：Excel 一次写入快照与行、来源 excel、归属取自会话且自报归属无效、行读取逐字段一致；同内容重放 200 + `x-replayed` 且按工作表名／序号选不同表内容不同；公式单元格与缺列返回 422 且不落库、非法 base64／空表名／序号 0 返回 400、未登录 401；同版本改内容 409 保留原数据；HTTP 层 Excel 201/200 幂等、`no-store`、选表读回、未登录与伪造令牌 401、撤销后 401、错误 base64 400、公式 422、GET 405 带 `Allow: POST`。首次运行一项失败：把 handler 级形状错误误断言为 HTTP 级 `BAD_REQUEST`，实际为 `INVALID_INPUT`，已修正后全绿。仅用 Node 22 内置能力，临时端口仅监听 127.0.0.1，测试库在系统临时目录并自动清理。工作表候选接口、上传界面、真实登录与上游实机链路仍未验证。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、目标／评估模型配置与受控匿名样本未就绪，P1 第 1–5 项与端到端验收无法实测；工作表候选 `inspectXlsx` 接口与手选界面、上传链路、飞书／SQL 导入、归档与引用提示、真实登录入口、运行队列／定时任务仍未做；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert` 即可移除 `importDatasetFromXlsx`、`DatasetXlsxImportInput`、`decodeBase64`／`parseSheet`、`POST /api/imports/dataset/xlsx` 路由、`xlsx-test-fixture.ts` 与新增测试，并把 plan.md 还原；`imports.ts` 的 `parseDatasetXlsx`、`xlsx.ts`、`dataset-rows.ts`、CSV 导入接口与结果读取接口不受影响。随后 revert 本条日志提交。本轮无新迁移与运行数据；若曾把该入口指向本机库写入过导入数据，回退代码不影响已落盘的 `dataset_row_sets`／`dataset_rows` 行，确认无需保留后按备份策略处理。代码回退不需要数据恢复。

### 2026-11-25 · 平台代码复审与裁判模型接入说明

- **Agent**　Codex，2026-11-25（Asia/Shanghai）。基线为 `main` 上的 `fe05d49`。
- **数据导入**　修复 CSV 不完整引号、仅有表头、Excel 无缓存公式和表头占用数据行额度。Excel 与 CSV 共用表格校验，解压阶段限制输出大小。调整 JSON 请求体上限以容纳 base64 编码后的工作簿。演示页同步提示 CSV 引号和所选工作表中的公式错误。
- **存储与复制**　导入时复算单元格校验值，在同一 SQLite 文件的写事务内保存元信息和样本行，失败可回滚。已有同库双连接调用沿用原入口。复制已导入的数据集时同时复制冻结样本行，历史元信息记录仍可读。复制规则时给新副本独立的版本标识。历史无名规则可读、可重放、可复制，新建规则要求名称。迁移在取得写锁后读取版本账本。
- **隔离与结果**　任务引用校验按当前账号读取资源。历史规则字段路径损坏、裁判返回可解析但不合规的 JSON、全 NA 判定、自定义分制、样本等待或取消状态分别按对应契约处理。百分比字段仅用于 0–1 规则，批次接口同时返回原始均分和量程。详情保留已取得的裁判 JSON 与耗时。SQLite 批量读取一个批次的尝试记录，校验进度上下限。
- **工程检查**　资源和导入接口共用 HTTP JSON 读写，存储冲突按错误类型映射。新增 npm 测试和严格类型检查入口，锁定开发依赖。README 记录 Coze Loop 内注册裁判模型、在 Prompt 评估器选模型并发布版本的接入位置，计划同步更新当前状态。
- **验证**　Node.js v24.14.1，`npm run typecheck` 通过，`npm test` 共 170 项全部通过。HTTP 回归覆盖 SQLite 重启后复制数据集、读取全部行、同请求重放与账号隔离。另用 6 个进程同时在新建临时库导入同一版本，得到一次 201、五次 200，每个进程均读到两行。检查演示页脚本可编译，实测 CSV 转义及三类错误引号。未调用真实模型，Coze Loop 与 Harness 的端到端验证仍在 P1。
- **变更引用与回退**　提交标题为 `Fix dataset integrity, scoring contracts and API validation`。对该提交执行 `git revert <提交号>`，再运行回退版本的测试、追加回退记录。数据库仍为迁移版本 5，本次测试使用临时库。回退会恢复旧的读写及分数展示行为，保留已写入的版本、样本和评分原文。

### 2026-11-25 · P2 阻塞期的 Excel 工作表候选接口

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25 16:33（Asia/Shanghai）。
- **改动**　新增 `POST /api/imports/dataset/xlsx/sheets`：`src/import-api/handlers.ts` 增 `inspectDatasetXlsxSheets`／`XlsxInspectionInput`／`XlsxInspectionData`，严格解码 base64 工作簿、校验可选上限后调用 `inspectXlsx`，按工作簿顺序返回全部表名；只列候选，不解析单元格、不写版本目录与行存储。身份只取服务端会话（Cookie／Bearer），请求体自称 `ownerAccountId` 被忽略。`src/import-api/http.ts` 增加 `xlsx-inspect` 路由并复用会话、体积限制与错误映射，坏容器／超限为 422 且带 `issues`，非法 base64／上限为 400，未登录 401、撤销后 401、错误方法 405 带 `Allow: POST`，响应 `no-store`。`src/domain/imports.ts` 把 `xlsxIssuesToImport` 导出，候选与导入共用同一 issues 口径。两测试文件新增 5 项。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改 PRD：本轮只暴露已确认的「显式选 Excel 工作表」，不改变产品行为。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖这些输入的可准备工作。上一轮 Excel 导入接口已上线，但调用方必须预先知道工作表名；本轮补上候选查询，使界面可让用户显式确认工作表后再导入，避免默认第一张代替确认。未启动 Docker、未安装依赖、未调用模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`npm run typecheck` 通过；导入接口两文件 `node --test src/import-api/handlers.test.ts src/import-api/http.test.ts` 24/24（原 19 + 新增 5），全量 `npm test` 175/175（原 170 + 新增 5），无回归。新增覆盖：多表（含中文与 `&`）按序返回且冻结、自称归属被忽略、目录与行存储零写入；坏容器 422 带 `NOT_ZIP`／`MALFORMED_ZIP`、非法 base64／非对象／未登录分别 400／400／401；`maxFileBytes` 超限 422 与非法值 400；HTTP 层 200/`no-store`/无 `x-replayed`、行读取仍 404、401（未登录／伪造／撤销）、405 带 `Allow`、415、400、422 与 Bearer 令牌可用。测试仅监听 127.0.0.1 临时端口，无临时库写入。首次类型检查误用 `ResourceCatalog.list`，改用 `listDatasets`／`getDataset` 后通过。
- **变更引用**　`main`：本轮代码、测试与 plan.md 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、模型配置与受控样本仍缺，P1 第 1–5 项与端到端验收无法实测；工作表选择界面、上传链路、飞书／SQL 导入、归档与引用任务提示、真实登录、运行队列／定时任务仍未做；Coze Loop 认证与完整裁判 JSON 回读待实测。
- **回退**　对承载本轮代码的提交执行 `git revert`，移除 `inspectDatasetXlsxSheets`、新路由、`xlsxIssuesToImport` 导出与 5 项测试，并还原 plan.md 本轮修订；`parseDatasetXlsx`、`xlsx.ts`、`dataset-rows.ts` 与 CSV／Excel 导入接口不受影响。随后 revert 本条日志提交。本轮无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-25 · P2 阻塞期的归档领域契约与持久化（进行中）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」的约定，先在 [readme.md](prd.md#管理页) 写明归档后端契约（按冻结版本标记、被活跃任务引用时拒绝、归档后不可新建绑定或新运行、历史仍可读），在 [plan.md](plan.md) 状态行与 P2 轨道补记本增量，并在本文件追加开工条目后才写代码。
- **改动**　`src/domain/resources.ts` 新增 `ArchiveStore`／`InMemoryArchiveStore`／`ArchivedResource`／`TaskReference`／`ArchiveResult`，扩充 `BindingErrorCode` 与 `ResourceCatalogOptions.archives`；`ResourceCatalog` 新增 `getArchive`／`listArchived`／`listReferencingTasks`／`archiveResource`。归档按 `kind + id + version` 标状态、同键同归属幂等、换归属拒绝，越权与不存在统一查不到；数据集／规则被未归档任务引用时返回 `ACTIVE_TASK_REFERENCE` 与引用任务摘要，已归档任务先归档即可释放引用；归档数据集／规则触发 `DATASET_ARCHIVED`／`RULE_ARCHIVED`，归档任务在 `validateRunBindings` 触发 `TASK_ARCHIVED`，已归档版本仍可按原归属读取详情，没有删除版本、样本行或历史运行。`src/storage/migrations.ts` 新增前向幂等迁移版本 6（`archived_resources`，资源类型 CHECK、主键与归属索引）；`src/storage/sqlite-resource-store.ts` 新增 `SqliteArchiveStore` 并注入 `SqliteResourceCatalog`，归档写入落在 SQL WHERE 限定归属，原有四类版本读取与绑定校验不变。既有四个存储测试文件的迁移断言从 5 更新到 6。`src/domain/resources.test.ts` 新增 7 项、`src/storage/sqlite-resource-store.test.ts` 新增 3 项测试。未改 CSV／Excel 导入、结果读取、资源写入与复制行为，未挂 HTTP。
- **原因与影响**　P1 第 1–5 项仍需 Docker、独立 workspace、目标／评估模型配置与受控样本，继续推进不依赖这些输入的可准备工作。readme.md 原把归档列为「建议删除」，但 P2 验收要求「已引用数据集的归档限制有效」；此前只有不可变版本目录，没有归档状态与引用检查，界面即使做出来也无法阻止归档仍被引用的数据集／规则。本轮把已写入 PRD 的契约落成领域与存储实现，供后续管理页归档开关、删除确认和引用提示直接调用。归档定义为按冻结版本标记而非删除，任务历史与旧快照仍可读，符合「历史仍持有曾使用的版本和运行详情」。只使用 Node 22 内置 `node:sqlite`／`node:crypto`／`structuredClone`；未启动 Docker、未安装依赖、未调用真实模型、未修改 `upstream/` 两份源码。
- **验证**　`npm run typecheck` 通过；`node --test src/domain/resources.test.ts src/storage/sqlite-resource-store.test.ts` → 26/26；全量 `npm test` → 185/185（原 175 + 新增 10），无回归。新增覆盖：未引用数据集归档幂等与深冻结、只改状态不删版本、越权读不到；活跃任务引用时数据集／规则同返回 `ACTIVE_TASK_REFERENCE` 并带任务 ID／版本／名称；任务归档后释放引用、旧任务不能发起新运行而配置仍可读；多任务版本仅剩活跃引用时仍拒绝归档；已归档数据集／规则新建任务失败且不落任务行；越权、不存在、非归档类型与空引用不写状态；内存归档存储换归属拒绝、幂等与账号限定；迁移 0→6 与重跑幂等、归档表结构与 CHECK 约束；关库重开后归档记录逐字段一致、重放不刷新时间、账号隔离、SQL 行内容一致；SQLite 活跃引用与任务归档语义、归档后旧任务运行校验被拒而任务行不变；内存与 SQLite 归档响应逐字段一致。首次运行四项失败：测试预期只收 `DATASET_ARCHIVED` 但归档规则后还返回 `RULE_ARCHIVED`、`node:sqlite` 返回 null 原型行对象、一致性测试漏放场景配置、严格类型检查不接受故意传入的非法归档类型，分别按真实多字段错误、行对象转普通对象、补场景、`as ArchivableResourceKind` 修正后全绿。无临时端口；测试库仅位于系统临时目录并自动清理。真实登录、管理页与上游实机链路仍未验证。
- **变更引用**　`main`：本轮 PRD／计划／代码与测试为 `eb63e26`，本条日志为 `9c454a8`，提交号更正另见后续日志提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　Docker、独立 workspace、模型配置与受控样本仍缺，P1 第 1–5 项与端到端验收无法实测；归档未挂 HTTP，管理页删除确认、归档开关与引用任务提示界面未做；归档按冻结版本生效，整逻辑 ID（含所有版本）的一次性归档、运行中任务与定时触发的归档时机仍待产品确认；归档状态检查与任务引用扫描在内存与 SQLite 上均为「先读后写」，未放在同一 SQLite 写事务内，单机单实例下可用，多进程并发需要后续加事务；飞书／SQL 上传链路、真实登录、运行队列／定时任务未做；上游认证与完整裁判 JSON 回读待实测。
- **回退**　先 `git revert` 本条日志提交，再 revert 承载 PRD／计划／代码与测试的提交：移除 `archived_resources` 迁移版本 6、`ArchiveStore` 与全部归档方法／测试，并把四个存储测试的迁移断言还原到版本 5；`resources.ts` 的不可变版本、绑定校验与运行结果读取、`resource-api`／`import-api` 不受影响；`readme.md`／`plan.md` 还原为归档「建议」文本。注意 revert 不会自动删除已建的 `archived_resources` 表，确认无在用归档记录后再按备份策略处理。本轮无运行数据，测试库仅在系统临时目录，代码回退不需要数据恢复。

### 2026-11-25 · P2 阻塞期的归档与引用任务 HTTP 接口

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-25（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」的约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮 HTTP 契约（归档 POST、状态 GET、引用任务 GET、409 带引用任务、会话限定归属），并在本文件追加开工条目后才写代码。[readme.md](readme.md) 的「归档后端契约」已在上轮固化，本轮只暴露既有行为，不改产品决策。
- **原因与变更范围**　上轮归档领域规则与 SQLite 状态没有 HTTP 入口，管理页无法查询归档状态或引用任务。本轮在 `src/resource-api/handlers.ts` 新增 `archiveManagedResource`、`getManagedArchiveStatus`、`listResourceReferences` 三个 HTTP 无关 handler 及 `ArchiveItem`／`ArchiveStatusData`／`ResourceReferencesData` 响应类型；`ResourceError` 增加可选的 `references`，错误码增加 `ACTIVE_TASK_REFERENCE`。`src/resource-api/http.ts` 新增 `GET/POST /api/resources/:kind/:id/:version/archive` 与 `GET /api/resources/:kind/:id/:version/references`，路由解析抽出版本路由公共函数，读取请求体改为按路由需要统一处理；归档与复制的空请求体可用，写入仍要求 JSON 对象。归属只来自服务端会话，请求体 `ownerAccountId` 被忽略；越权与不存在统一 404，数据集／规则仍被未归档任务引用时 409 并回带引用任务，场景配置归档 400。两个测试文件补充 4 项 handler 与 2 项 HTTP 回归。未新增迁移，未改 `src/domain/resources.ts` 与 `src/storage/`。
- **验证**　`npm run typecheck` 通过；`node --test src/resource-api/handlers.test.ts` → 30/30（原 26 + 4）；`node --test src/resource-api/http.test.ts` → 18/18（原 16 + 2）；全量 `npm test` → 191/191（原 185 + 6），无回归。覆盖归档任务幂等与归档时间不刷新、状态回显、活跃任务阻塞数据集归档并返回引用任务（含归档标记）、任务归档后释放引用、已归档数据集不能新建绑定、引用列表按账号限定与越权 404、未登录 401、405 与 `Allow`、场景归档 400、媒体类型 415、SQLite 关库重开后状态/引用/历史详情逐字段一致。测试只监听 127.0.0.1 临时端口、临时库在系统临时目录；未起 Docker、未装依赖、未调用模型。
- **代码或上游引用**　本轮代码与 [plan.md](plan.md) 修订为提交 `075ee0e`；本条日志单独提交。未触碰 `upstream/` 两份源码。
- **未解决问题**　P1 实机验证仍缺 Docker、独立 workspace、目标／评估模型配置与受控样本；上游认证与完整裁判 JSON 回读未实测。管理页归档确认、归档开关和引用任务提示界面未做；整逻辑 ID 归档与运行中／定时归档时机仍待产品确认；引用扫描与归档写入未放入同一 SQLite 写事务（单机单实例可用）。
- **回退**　先 `git revert` 本条日志提交，再 revert `075ee0e`：移除三个 handler、三条路由与 6 项测试并还原 [plan.md](plan.md) 状态行；上轮归档领域契约、SQLite 迁移版本 6、资源写入／复制／导入接口不受影响。无新迁移与运行数据，代码回退不需数据恢复；若曾对本机库归档过资源，回退代码不影响已落盘的 `archived_resources` 行，按备份策略处理。

### 2026-11-26 · P2 阻塞期的运行索引领域契约（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」的约定，先在本文件追加本条目，并在 [plan.md](plan.md) 状态行与 P2 轨道写明运行索引契约与边界后才写代码。[readme.md](readme.md) 与 plan.md 已确认「重复提交同一触发不会生成多次正式运行」「手动和定时运行均归任务所有者」「取消本批只停止本批剩余执行」「调度按上海时区与任务 ID／计划时间去重」，本轮只把这些边界固化为可执行逻辑，不改变产品决策。
- **计划改动**　新增 `src/domain/runs.ts` 与 `src/domain/runs.test.ts`：运行记录冻结任务与三个版本引用、样本 ID 与状态；手动／定时幂等、同任务执行时跳过定时、状态流转与有限重试、按账号取消本批及账号限定读取；存储通过可注入接口提供内存实现。本轮不新增迁移、不挂 HTTP、不改资源与导入接口。
- **原因与影响**　P2 已有资源版本、导入行、归档与结果读取，但 P5 所需的运行／定时索引仍无契约。此前「重复触发去重」「同任务跳过定时」「取消只停本批」只写在计划里，管理页与调度无法调用。本轮把它们固化为不依赖上游输入的领域规则与可注入 `RunStore`，供后续 SQLite 迁移、HTTP 接口与 Runner 直接复用；不改变已确认产品行为。未启动 Docker、未安装依赖、未调用真实模型、未修改 `upstream/` 两份源码，未新增迁移。
- **验证**　`npm run typecheck` 通过；`node --test src/domain/runs.test.ts` → 14/14；全量 `npm test` → 205/205（原 191 + 新增 14），无回归。覆盖：手动／定时创建冻结批次与深冻结、手动按账号加请求 ID 幂等、定时按任务 ID 加计划时间幂等、同任务活跃批次跳过而别的任务不受阻、批次结束后可再定时触发、上海墙上时间与请求 ID 非法输入字段级报错且不落库、他人任务／版本漂移／归档任务拒绝且不落库、样本 ID 与冻结行一致性与空数据集、批次 ID 跨账号冲突、状态流转与未结束样本不能结束批次、按阶段样本流转与部分失败、Agent／评分失败重试递增尝试次数、取消只影响本批剩余样本且保留已完成样本、归属限定读取与越权统一查不到、共用存储重启后历史与幂等语义仍在。首次运行三处失败分别因测试把 `evidence_missing` 从错误阶段直接流转、排队批次先被状态守卫拒绝导致样本未找到断言错位、以及跳过分支的断言写反；另把「失败可重试」与「可作为本批终态」区分后才放行部分失败，均按真实契约修正测试与判定后全绿。仅用 Node 22 内置能力，无临时端口与临时库。
- **代码或上游引用**　`main`：本轮代码、测试与 [plan.md](plan.md) 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。本轮期间另有并行 Agent 修改 `package.json`／`package-lock.json` 增加 `pg` 依赖，提交时只暂存本轮四个文件，不混入该并行改动。
- **未解决问题**　P1 实机验证仍缺 Docker、独立 workspace、目标／评估模型配置与受控样本；运行索引尚未落 SQLite、未挂 HTTP、未接真实 Runner 与调度回收，定时触发点、错过补跑与运行中归档时机仍待负责人确认；上游认证与完整裁判 JSON 回读未实测。
- **回退**　先 `git revert` 本条日志提交，再 revert 承载代码与计划的提交：移除 `src/domain/runs.ts`、`src/domain/runs.test.ts` 与 plan.md 本轮两段说明；资源、导入、归档与结果读取接口不受影响。纯新增文件、无新迁移与运行数据，代码回退不需要数据恢复；并行 Agent 的 `pg` 依赖改动不属于本轮回退范围。

### 2026-11-26 · 运行索引增量提交号补记

- 本轮代码与 [plan.md](plan.md) 修订为提交 `76b66c8`，本条变更记录提交为 `62aa8a5`。并行 Agent 的 `package.json`／`package-lock.json` 改动未纳入这两个提交。

### 2026-11-26 · 平台业务数据库切换为 PostgreSQL

- Agent 为 OpenAI Codex，日期为 2026-11-26（Asia/Shanghai）。负责人确定按个人账号隔离的多人部署，平台数据库统一使用 PostgreSQL 17。
- 新增 PG 连接池、带版本的事务迁移、资源与归档存储、数据集行、会话和评分结果存储。统一 API 使用服务端会话确定归属。资源列表由 PG 筛选和分页。同一账号的写入在数据库事务内串行，同版本重放保持幂等。CSV、Excel 和数据集副本在同一事务写入元信息和样本行。
- 增加本机 Compose 数据库与命名卷、后端入口、示例配置和独立 PG 集成测试。更新 PRD、计划及执行索引的后续落库目标。浏览器演示、执行侧内存索引和上游模型配置维持各自原有行为。前端接入、正式登录和真实 Agent／裁判联调仍待开发。
- 验证通过 `npm run typecheck` 和全部 205 项原有回归测试。独立 PostgreSQL 17.12 实例通过 6 组集成场景，覆盖双账号隔离、并发重放、行写入失败回滚、分页、Excel、任务归档及会话撤销。另验证命令行迁移、签发会话和实际 HTTP 请求。已启动本机 Compose 实例及 API，健康检查返回 `{"status":"ok","database":"postgresql"}`，业务库 `eval_platform` 迁移版本为 1。
- 数据影响与回退。仓库内未发现旧业务数据库文件。本机新建开发库和仅本机使用的忽略文件 `.env`，集成测试使用独立临时库。代码基线为 `51bee58`，本次独立提交以 `Use PostgreSQL for the evaluation platform backend` 定位。回退时停止 API 写入，备份 PG 数据，撤销本提交并保留命名卷。旧版本使用先前的存储适配器，若要在旧版本读取 PG 期间新增的数据，需要另行转换并核对。

### 2026-11-26 · 运行索引落 PostgreSQL（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」的约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮 PG 落盘契约后才写代码。[readme.md](readme.md) 与 plan.md 已确认「重复提交同一触发不会生成多次正式运行」「同一任务已有执行时跳过定时」「取消本批只停止本批剩余执行」「队列、定时与运行索引使用同一个 PG 库并按个人账号隔离」；本轮只持久化既有领域规则，不改变产品决策。
- **计划改动**　新增 PG 迁移版本 2（`run_index`：全局批次 ID 主键、`(owner_id, idempotency_key)` 唯一、任务 ID／状态／触发方式与完整冻结文档），新增 PG 运行索引适配层：写操作在按账号加锁的单个事务内加载本次涉及的版本与运行记录，复用 `RunIndex` 同步领域规则，成功后写回新增／变更文档；读取按账号限定。新增 PostgreSQL 集成场景覆盖手动与定时幂等、活跃批次跳过、状态流转与取消、跨账号隔离、关库重开后可读。不新增 HTTP 入口、不接 Runner 与调度。
- **原因与影响**　上一轮只交付了运行索引的领域契约与内存实现，实例重启后丢失，且无法在多人部署里按账号共享。PG 切换后计划明确运行索引与队列使用同一业务库；本轮把它落盘，供后续 HTTP 触发接口、Runner 与调度直接调用。未启动 Docker、未安装依赖、未调用真实模型、未修改 `upstream/` 两份源码；只连接本机已有的 PostgreSQL 实例运行独立 schema 的集成测试。
- **验证与回退**　完成交付后在同日记录中追加 `npm run typecheck`、全量 `npm test` 与 `npm run test:postgres` 的结果及回退信息。回退先 revert 日志提交，再 revert 承载代码与迁移的提交；注意 revert 不自动删除 `run_index` 表，确认无在用运行记录后再按备份策略处理。

### 2026-11-26 · 运行索引落 PostgreSQL（完成）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **变更范围**　新增 `src/storage/postgres/002-run-index.sql`（`run_index`：批次 ID 主键、按账号的 `(owner_id, idempotency_key)` 唯一、任务 ID／状态／触发方式／完整冻结文档，CHECK 保证文档与列一致）；`src/storage/postgres/database.ts` 把迁移登记为版本 2；`src/storage/postgres/catalog.ts` 导出 `catalogForRuns`，供运行事务只加载本次涉及的任务／数据集／规则／场景版本；新增 `src/storage/postgres/run-index.ts`，提供 `postgresRunIndex(pool)` 的 `requestRun`／`transitionRun`／`cancelRun`／`setSampleStatus`／`getRun`／`listRuns`／`listRunsForTask`。写操作在按账号加 `pg_advisory_xact_lock` 的单个事务内用 `RunIndex` 同步领域规则与 `InMemoryRunStore` 完成校验、幂等和流转，成功后仅写回新增／变更文档；读取走只读事务并按账号限定。`tests/postgres.test.ts` 新增一个集成子测试（七场景）。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改 PRD：只持久化已确认的手动／定时幂等、活跃跳过、取消与本批隔离行为。
- **验证**　`npm run typecheck` 通过；全量 `npm test` → 205/205（无新增单元测试，无回归）；`npm run test:postgres` 在已有本机 PostgreSQL 17.12 上以独立 schema 运行 → 8/8，新增场景覆盖手动按请求 ID 幂等且库内只留一行、定时按任务 ID＋上海时间幂等、活跃批次跳过定时、批次流转与逐样本四段流转、未结束样本不能结束批次、取消只停本批且重放幂等、悬空任务拒绝且不落库、A/B 账号读取与列表隔离、无账号读取为空、换连接池重开后文档逐字段一致且旧请求仍幂等。迁移在集成测试内重复执行三次且幂等。首次运行因测试在手动批次仍 queued 时预期定时创建成功而失败，按「同一任务已有执行即跳过」的真实契约把定时场景移到批次结束后，重跑全绿。未启动 Docker、未安装依赖、未调用真实模型、未修改 `upstream/` 两份源码；测试连接的是既有本机实例，只创建并清理独立 schema。
- **变更引用**　`main`：代码、迁移、测试与 [plan.md](plan.md) 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　P1 实机验证仍缺 Docker workspace、目标／评估模型配置与受控样本；运行索引尚未挂 HTTP，真实 Runner、定时回收与错过补跑未接；定时触发点、运行中归档时机仍待负责人确认；写事务内「加载涉及版本＋按账号串行＋整文档写回」依赖事务锁，多实例部署的扩展需后续评估；上游认证与完整裁判 JSON 回读未实测。
- **回退**　先 `git revert` 本条日志提交，再 revert 承载代码与迁移的提交：移除迁移版本 2、`run_index` 适配层、`catalogForRuns` 与集成子测试，并把数据库迁移列表还原为仅 `001-platform.sql`。注意 revert 不自动删除已建的 `run_index` 表，确认无在用运行记录后再按备份策略处理。集成测试使用独立临时 schema 并自动清理；本机业务库在下一轮服务启动前仍为迁移版本 1，代码回退不需要数据恢复。

### 2026-11-26 · 运行索引增量提交号

- 本轮代码、迁移、测试与 [plan.md](plan.md) 修订为提交 `a115f70`，本条变更记录提交为 `2272c97`。

### 2026-11-26 · 运行索引 HTTP 入口（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮 HTTP 契约后才写代码。readme.md 与 plan.md 已确认「重复提交同一触发不会生成多次正式运行」「同一任务已有执行时跳过定时」「取消本批只停止本批剩余执行」「队列与运行索引使用同一个 PG 库并按个人账号隔离」；本轮只暴露既有运行索引领域与 PG 适配层行为，不改变产品决策。
- **计划改动**　新增 `src/run-api/handlers.ts`（HTTP 无关）与 `src/run-api/http.ts`，把 PG 运行索引挂到 `POST /api/runs`（手动触发）、`POST /api/runs/:runId/cancel`（取消本批）、`GET /api/runs/:runId`（批次状态）、`GET /api/runs`（本人列表，可按 taskId 过滤）。账号只从服务端会话取得，请求体 `ownerAccountId`／查询 `accountId` 不参与鉴权；未登录 401、越权与不存在统一 404、输入与领域错误 422 带 issues、批次 ID 冲突 409、幂等／取消重放 `x-replayed: true`、响应 no-store。server.ts 按路径形状分流运行索引与既有结果读取路由。不新增迁移、不接 Runner／调度／真实登录。
- **回退与验证计划**　完成后在同条记录追加 `npm run typecheck`、`npm test` 全量与 PG 集成结果。回退先 revert 日志提交，再 revert 代码提交；无新迁移，代码回退不需要数据恢复。

### 2026-11-26 · 运行索引 HTTP 入口（完成）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **变更范围**　新增 `src/run-api/handlers.ts`：定义 `RunIndexAccessor` 抽象（同步领域 RunIndex 与异步 PG 适配层共用），实现 `requestManagedRun`／`cancelManagedRun`／`getManagedRunStatus`／`listManagedRuns` 四个 HTTP 无关 handler。账号只取 `AuthContext.accountId`，请求体 `ownerAccountId` 不参与鉴权；手动触发的请求体经形状校验后交领域复核，归属／绑定漂移与状态流转错误映射为 422 逐字段 issues，批次 ID 冲突 409、未登录 401、越权与不存在统一 404，幂等与取消重放以 `replayed` 标记。新增 `src/run-api/http.ts`：把四类操作挂到 `POST /api/runs`、`POST /api/runs/:runId/cancel`、`GET /api/runs/:runId`、`GET /api/runs`（?taskId），复用结果读取接口的服务端会话（Cookie／Bearer），405 带 Allow、坏 JSON 400、媒体类型 415、空体 400、no-store；导出 `isRunIndexRoute` 与既有 `/api/runs/:runId/results|samples` 路径形状互斥。`src/server.ts` 按该判定分流运行索引与结果读取，并接入 `postgresRunIndex(store.pool)`。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改 PRD、未新增迁移、未触碰 `upstream/` 两份源码、未接 Runner／调度／真实登录。
- **原因与影响**　上一轮已把运行索引落 PG，但没有 HTTP 入口，管理页与未来的手动运行／取消按钮无法调用；此前 `/api/runs/:runId` 路径段被结果读取接口独占。本轮补齐触发、取消、详情与列表的可复现 HTTP 入口，并显式分离两类路由，供后续管理页与 P5 运行页挂接。所有写入仍走 PG 适配层的按账号事务锁与领域规则，不改变手动／定时幂等、活跃跳过、取消只停本批的产品行为。仍不启动 Docker、不安装依赖、不调用真实模型；PG 集成测试只连接本机已有实例并创建独立 schema。
- **验证**　`npm run typecheck` 通过；`npm test` → 222/222（原 205 + 新增 17，含 handler 10 与 HTTP 7），无回归。新增覆盖：手动触发冻结批次且请求体自报账号无效、requestId 幂等重放仅一批、未登录四类操作 401、六类形状错误 400 且不落库、绑定漂移 422 不落库、runId 冲突 409、取消保留已完成样本且重放不刷新时间、越权与不存在统一 404、列表 taskId 过滤与冻结快照；HTTP 层覆盖路由分流互斥、伪造／撤销会话 401、Bearer、no-store、x-replayed、405/415/400/空体、跨账号隔离。PG 集成 `TEST_DATABASE_URL` 指向本机 PostgreSQL 17.12 的独立 schema → 8/8 子场景（原 7 + 新增 1），新场景经真实 `createPlatformServer` HTTP 走完触发→重放→详情→列表→取消，验证自报账号无效、run_index 只有一行、跨账号 404 与不存在 404 响应一致、结果读取路径未被遮蔽。集成 schema 结束时自动清理。首次 handler 测试三处期望写错（成功触发返回体无 `run` 字段、样本 ID 形状合法但不匹配应 422 而非 400）按真实契约修正；HTTP 测试一处用 B 令牌配 A 绑定应为 422 已改为用 B 自己的资源断言归属。
- **未解决问题**　P1 实机验证仍缺 Docker workspace、目标／评估模型配置与受控样本；运行索引尚未接真实 Runner、定时回收与错过补跑，定时触发点、运行中归档时机仍待负责人确认；真实登录方式未选型（当前会话由服务端签发）；上游认证与完整裁判 JSON 回读未实测。
- **变更引用**　`main`：本轮代码、测试、迁移无关与 [plan.md](plan.md) 修订随后提交；本条日志在其后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **回退**　先 `git revert` 本条日志提交，再 revert 承载代码与测试的提交：移除 `src/run-api/` 全部文件、还原 `src/server.ts` 的分流与 `tests/postgres.test.ts` 的新增子测试、还原 plan.md 本轮两段说明；`src/domain/runs.ts`、PG 适配层与迁移版本 2、资源／导入／结果读取接口不受影响。无新迁移与运行数据，代码回退不需要数据恢复；若本机业务库在运行期间通过新 HTTP 入口创建过批次，回退代码不影响已落盘的 `run_index` 行，按备份策略另行处理。

### 2026-11-26 · 运行索引 HTTP 入口提交号

- 本轮代码、`plan.md` 修订与测试为提交 `7b9f9a0`，本条与完成记录的变更日志提交为 `215bbaf`。

### 2026-11-26 · EasyEval 首次 GitHub 公开发布

- Agent 为 OpenAI Codex。公开仓库为 [jialiruo-png/EasyEval](https://github.com/jialiruo-png/EasyEval)。首页说明当前实现、演示入口、PostgreSQL 启动方法，以及使用个人会话导入两行 CSV 的可运行示例。
- 原首页的产品需求单独保存在 [prd.md](prd.md)。计划、设计与历史条目的文档链接已调整，公开说明中的上游代码指向固定版本。开发目录内的旧提交继续保留，首次公开提交取自已核对的项目快照。
- 发布验证在全新导出的代码副本中进行。`npm ci`、类型检查、222 项常规测试及 PostgreSQL 测试（9 项）通过。使用临时数据库验证了 README 示例中的健康检查、会话签发、重复导入和两条中文样本的读取。
- 发布前本地基线为 `912f848`。文档提交以 `Prepare EasyEval documentation for its public release` 定位。本地开发分支为 `main`，公开发布分支为 `public`，对应远端 `github/main`。后续可在本地 `public` 上 cherry-pick 审核过的改动，再执行 `git push github public:main`。回退文档时撤销对应变更并发布新的修订提交，本次未修改运行数据或迁移。

### 2026-11-26 · P2/P3 阻塞期的草稿与预览领域契约（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「若某一步结果要求改变产品行为，先更新 PRD／计划与变更记录」的约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮契约并追加本条目后才写代码。[prd.md](prd.md) 已确认「草稿和试跑按账号归属」「刷新可恢复草稿、确认取消整份草稿」「预览最多三条且配置变化后不复用旧结果」「试评分最多两条」「草稿与正式运行标识、存储和测试数据分开」；本轮只把这些边界固化为纯逻辑，不改变产品决策。
- **计划改动**　新增 `src/domain/drafts.ts` 与 `src/domain/drafts.test.ts`：草稿按账号隔离、ID 带 `draft:` 前缀、默认 24 小时到期但时钟可注入、revision 乐观并发、取消与按幂等键确认可重放；预览最多三条，签名覆盖草稿 ID、Agent 场景版本、数据集版本、样本 ID 与查询映射，相同签名复用、配置变化丢弃旧结果，按条状态流转与重试。纯逻辑与内存实现，不新增迁移、不挂 HTTP、不接 Runner 与真实登录。
- **回退与验证计划**　完成后追加 `npm run typecheck` 与全量 `npm test` 结果。回退先 revert 本条日志提交，再 revert 承载代码与计划的提交；纯新增文件，无迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-26 · P2/P3 阻塞期的草稿与预览领域契约（完成）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **变更范围**　新增 `src/domain/drafts.ts` 与 `src/domain/drafts.test.ts`（11 项）。`DraftRecord` 持有账号、步骤、场景／数据集／规则冻结引用、查询列、最多三条预览样本与变量映射；`InMemoryDraftStore` 写入读出均深冻结，草稿 ID 固定 `draft:` 前缀，与正式运行批次分属不同存储。创建／更新按账号复核资源版本、归档状态、查询列与冻结行，更新以 `expectedRevision` 防丢失修改；到期草稿可展示但拒绝写入；取消幂等重放并停止未结束预览，确认以幂等键返回同一份冻结任务配置载荷，不写任务版本和运行。`DraftManager` 的预览缓存按草稿＋签名＋样本隔离，签名为草稿 ID、场景版本、数据集版本、查询列、映射内容与样本的稳定 SHA-256（映射数组顺序无关）；同签名复用旧条目，配置变化即丢弃旧结果，按条记录 pending／running／succeeded／failed／canceled、尝试次数与可选 trace 引用，失败／取消可重试并递增次数。plan.md 状态行与 P2 轨道已同步。未改 PRD、未新增迁移、未挂 HTTP、未触碰 `upstream/` 两份源码。
- **原因与影响**　P1 实机验证仍缺 Docker workspace、模型配置与受控样本。P3/P4 的向导草稿、刷新恢复、取消到期、三条预览与「配置变化不复用旧结果」在管理页实现前需要可执行契约；本轮把这些已确认边界固化为纯逻辑，供后续 PG 落盘、HTTP 与 Runner 直接复用，不改变产品行为。未启动 Docker、未安装依赖、未调用真实模型。
- **验证**　`npm run typecheck` 通过；`node --test src/domain/drafts.test.ts` → 11/11；全量 `npm test` → 233/233（原 222 + 新增 11），无回归。覆盖草稿归属隔离、深冻结、ID 前缀与冲突、版本归属／查询列／样本上限／重复占位符的字段级错误、revision 冲突与数据集切换时样本复核、到期后各写入路径拒绝、取消幂等与预览终止、确认载荷冻结与幂等重放、不写任务版本、确认前规则与归档校验、签名各输入变化与映射顺序无关性、同签名复用与配置变化丢弃旧结果、三条上限、按条状态流转与重试、存储重启后 revision／确认／预览复核。首次四项失败按真实契约修正测试：把 belongs-to-A 的数据集误当作越权用例、映射顺序无关却断言签名变化、重启后 revision 期望多算一次预览获取，修正后全绿。仅用 Node 内置能力，无临时端口与临时库。
- **变更引用**　`main`：开工前文档为 `2a615f3`，本轮代码与测试为 `39dc42e`，本条日志随后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　P1 实机验证仍缺 Docker workspace、目标／评估模型配置与受控样本；草稿与预览尚未落 PostgreSQL、未挂 HTTP、未接管理页向导与 Runner；试评分最多两条及其缓存、定时回收与真实登录未做；运行中归档时机仍待负责人确认；上游认证与完整裁判 JSON 回读未实测。
- **回退**　先 `git revert` 本条日志提交，再 revert `39dc42e` 与 `2a615f3`：移除 `src/domain/drafts.*` 并还原 plan.md 状态行与 P2 轨道；资源、导入、归档、运行索引与结果读取不受影响。纯新增文件与文档修订，无新迁移与运行数据，代码回退不需要数据恢复。

### 2026-11-26 · 草稿与预览索引落 PostgreSQL（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「结果要求改变产品行为则先更新 PRD／计划／变更记录」约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮 PG 落盘契约后才写代码。[readme.md](readme.md) 与 plan.md 已确认「草稿和正式运行标识、存储和测试数据分开」「刷新可恢复草稿、确认取消整份草稿」「预览最多三条且配置变化后不复用旧结果」「预览按条状态与重试」「草稿与运行索引使用同一个 PG 库并按个人账号隔离」；本轮只持久化既有领域规则，不改变产品决策。
- **计划改动**　新增 PG 迁移版本 3（`drafts`：草稿 ID 主键、按账号隔离、状态／revision／整份冻结文档与 CHECK；`draft_previews`：账号＋草稿＋样本为键、按账号＋草稿索引、签名／状态／尝试次数与文档）；新增 `src/storage/postgres/drafts.ts` 的 `postgresDrafts(pool)`，把 `DraftManager` 的创建／读取／列表／更新／取消／确认与预览获取／流转／重试在按账号加事务锁的单个事务内落盘，写前只加载本次涉及的草稿、预览与冻结版本，成功后仅写回新增或变更文档；读取按账号限定。新增 PostgreSQL 集成场景覆盖草稿归属隔离、revision 冲突、取消／确认幂等、签名变化丢弃旧预览、按条重试、关库重开后可读与失败事务回滚。不新增 HTTP 入口、不接 Runner 与调度、真实登录。
- **原因与影响**　上一轮草稿与预览只有内存实现，实例重启后丢失，且无法在多人部署里按账号共享。PG 切换后计划明确队列、草稿与运行索引使用同一业务库；本轮把它们落盘，供后续向导 HTTP 接口、Runner 与调度直接复用。未启动 Docker、未安装依赖、未调用真实模型、未修改 `upstream/` 两份源码；只连接本机已有的 PostgreSQL 实例运行独立 schema 的集成测试。
- **验证与回退**　完成交付后在同日记录中追加 `npm run typecheck`、全量 `npm test` 与 `npm run test:postgres` 的结果及回退信息。回退先 revert 日志提交，再 revert 承载代码与迁移的提交；注意 revert 不自动删除 `drafts`／`draft_previews` 表，确认无在用草稿后再按备份策略处理。

### 2026-11-26 · 草稿与预览索引落 PostgreSQL（完成）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **变更范围**　新增迁移版本 3：`drafts`（`(owner_id,id)` 主键、步骤／状态／revision 与整份冻结文档 CHECK、账号创建时间索引）与 `draft_previews`（键的 base64 作主键、账号＋草稿＋样本唯一、签名／状态／尝试次数／原因／trace 引用，账号＋草稿索引）；预览键含 NUL 不能直接入库，改存 `base64url` 并在读回时用领域 `previewKey` 还原，领域只把 `previewKey` 由私有改为导出（行为不变）。`database.ts` 迁移列表登记版本 3；`catalog.ts` 导出 `catalogForDrafts`，只加载本次草稿涉及的场景／数据集／规则版本与归档。新增 `src/storage/postgres/drafts.ts` 的 `postgresDrafts(pool)`：创建／读取／列表／加载／更新／取消／确认与预览获取／流转／重试／列表均走按账号事务，写操作先加 `pg_advisory_xact_lock`、加载该账号草稿与预览，用 `DraftManager` 同步领域规则完成校验、revision 并发、幂等与签名比对，成功后仅把新增或变更的文档 upsert、删除消失的预览，失败事务整体回滚；读取走只读事务并按账号限定。确认仍只产出冻结任务配置载荷、不写任务版本与运行；无账号时返回领域失败且不触碰数据库。`tests/postgres.test.ts` 新增一个集成子测试。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改产品需求、未挂 HTTP、未接 Runner 与调度、未触碰 `upstream/` 两份源码。
- **验证**　`npm run typecheck` 通过；全量 `npm test` → 233/233（无新增单元测试，无回归）；`npm run test:postgres` 在已有本机 PostgreSQL 17.12 上以独立 schema 运行 → 8/8 子场景（原 7 + 新增 1），迁移重复三次幂等。新增场景覆盖：草稿创建冻结且字段级校验生效、归属隔离（B 读不到 A 的草稿／预览／列表）、同 ID 重放拒绝、revision 冲突与成功更新、预览获取复用／running→succeeded／成功不可重试、失败预览按条重试递增尝试、签名变化丢弃旧预览后重建、确认产出冻结载荷且幂等重放一致、确认不写任务版本、取消停止未结束预览且幂等、取消后更新拒绝、换连接池重开后草稿／预览／幂等逐字段一致、失败事务（CHECK 拒绝）回滚且不影响既有草稿。首次三处失败：测试用 `reused.value.replayed` 应为结果层的 `replayed`、误以为此前子测试未建任务而把任务总数写死为 1、以及把 CHECK 抛错当作领域失败结果（应为 reject 且事务回滚），均按真实契约修正后全绿。未启动 Docker、未安装依赖、未调用真实模型；测试只连接既有本机实例并创建独立 schema。
- **变更引用**　`main`：代码、迁移、测试与 [plan.md](plan.md) 修订为提交 `101503c`，本条日志随后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　P1 实机验证仍缺 Docker workspace、目标／评估模型配置与受控样本；草稿与预览尚未挂 HTTP、未接管理页向导与 Runner，试评分最多两条及其缓存、定时回收与真实登录未做；运行中归档时机仍待负责人确认；写事务「加载该账号全部草稿＋按账号串行＋整文档 upsert」在多实例部署的扩展性待评估；上游认证与完整裁判 JSON 回读未实测。本机业务库在下次服务启动前仍为迁移版本 2，版本 3 届时应用。
- **回退**　先 `git revert` 本条日志提交，再 revert `101503c`：移除迁移版本 3、`drafts`／`draft_previews` 表定义、`postgresDrafts` 适配层、`catalogForDrafts`、`previewKey` 导出与集成子测试，并把迁移列表还原为两个文件；运行时索引、资源、导入、归档与结果读取不受影响。注意 revert 不自动删除 `drafts`／`draft_previews` 表，确认无在用草稿后再按备份策略处理。集成测试使用独立临时 schema 并自动清理；本机业务库尚无草稿数据，代码回退不需要数据恢复。

### 2026-11-26 · 草稿与预览 HTTP 入口（开工前）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **开工前变更**　按「若某一步结果要求改变产品行为，先更新 PRD／计划与变更记录」约定，先在 [plan.md](plan.md) 状态行与 P2 轨道写明本轮 HTTP 契约后才写代码。[readme.md](readme.md) 与 plan.md 已确认「草稿刷新可恢复、取消与确认可重放」「预览最多三条、签名相同复用且配置变化不复用旧结果」「按条状态与重试」「账号只来自服务端会话」；本轮只暴露既有领域与 PG 契约，不改变产品决策。
- **计划改动**　新增 `src/draft-api/handlers.ts`、`http.ts` 与内存夹具、两处测试文件，把草稿创建／列表／详情／更新／取消／确认与预览列表／获取／流转／重试挂到 `node:http`；`src/server.ts` 用 `postgresDrafts` 分流 `/api/drafts`。未登录 401、越权与不存在 404、revision 或 ID 冲突 409、形状错误 400、领域与流转错误 422，幂等响应头 `x-replayed`，`no-store`。不接 Runner、调度、真实登录与上游。
- **验证与回退计划**　完成后追加 `npm run typecheck`、全量 `npm test` 与 PG 集成测试结果；回退先 revert 本条日志提交，再 revert 承载代码与计划的提交。纯新增 HTTP 层与路由，无新迁移；若本机业务库经新入口写入草稿，代码回退不影响已落盘文档，需按备份策略单独处理。

### 2026-11-26 · 草稿与预览 HTTP 入口（完成）

- **Agent**　WorkBuddy 自动化（每轮有界推进）。
- **日期**　2026-11-26（Asia/Shanghai）。
- **变更范围**　新增 `src/draft-api/handlers.ts`、`http.ts`、`draft-test-fixture.ts`、`handlers.test.ts`（10 项）与 `http.test.ts`（7 项）。`DraftAccessor` 让同步 `DraftManager` 与异步 `postgresDrafts` 共用 HTTP 无关校验；创建／列表／详情／revision 更新／取消／确认／预览列表／获取／流转／重试十类操作只从 `AuthContext` 取账号，请求体自报账号无效。形状错误 400，未登录 401，越权与不存在统一 404，revision 与 ID 冲突 409，领域校验及非法预览流转 422；幂等重放 `x-replayed: true`，全部响应 `no-store`。HTTP 层暴露 `POST/GET /api/drafts`、`GET/PATCH /api/drafts/:draftId`、cancel、confirm、previews 列表／获取与 `transition`／`retry` 动作，405 带 `Allow`，JSON 体积与媒体类型按既有口径映射；URL 路径段解码后交同一 handler。`src/server.ts` 用 `postgresDrafts(store.pool)` 按 `/api/drafts` 前缀分流。[plan.md](plan.md) 状态行与 P2 轨道已同步。未改 PRD、未新增迁移、未接 Runner／调度／真实登录、未触碰 `upstream/` 两份源码。
- **原因与影响**　上一轮草稿与预览已落 PG 但只有适配层 API，向导前端无法调用。本轮补上可复现 HTTP 入口，归属、乐观并发、签名复用与按条重试继续由领域与 PG 事务负责，不改变已确认产品行为。未启动 Docker、未安装依赖、未调用真实模型。
- **验证**　`npm run typecheck` 通过；新增两文件 17/17；全量 `npm test` → 250/250（原 233 + 17），无回归。覆盖自报账号无效、401/404/405/400/415/413/409/422、URL 编码 ID、列表归属与总数、revision 冲突与递增、确认载荷冻结且不写任务版本、取消幂等、同签名预览复用、最多三条、配置变化丢弃旧预览、失败重试与成功不可重试、撤销会话。新增 `tests/postgres.test.ts` 子场景经 `createPlatformServer` 走创建→冲突→更新→预览获取/复用/流转/重试→确认/重放，并检查 `drafts`/`draft_previews` 行数与跨账号隔离；**该 PG 集成场景本轮未执行**：本机 PostgreSQL 127.0.0.1:5432 返回 `ECONNREFUSED`，未启动 Docker 或 Database 服务，不臆造结果，待数据库恢复后补跑。
- **变更引用**　`main`：代码、测试与 [plan.md](plan.md) 修订为提交 `54db2fd`；本条日志随后单独提交。上游 Coze Loop 仍为 `7a5ab1633eb30396928cd51017a63b456d117985`，DeepSeek Harness 仍为 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，二者均未改动。
- **未解决问题**　P1 实机验证仍缺 Docker workspace、模型配置与受控样本；草稿接口未接向导界面、Runner 与调度，试评分最多两条及其缓存、定时回收与真实登录未做；PG 集成子场景待本机数据库恢复后补跑；上游认证与完整裁判 JSON 回读未实测。
- **回退**　先 `git revert` 本条日志提交，再 revert `54db2fd`：移除 `src/draft-api/` 全部文件、还原 `src/server.ts` 分流与 `tests/postgres.test.ts` 新增子测试，并还原 plan.md 状态行与 P2 轨道；草稿领域、迁移版本 3、`postgresDrafts` 适配层，以及资源／导入／运行／结果读取接口不受影响。无新迁移与运行数据，纯代码回退不需要数据恢复；若本机业务库曾通过新入口写入草稿，已落盘文档按备份策略单独处理。

### 2026-11-26 · 草稿与预览 HTTP 入口提交号

- 本轮代码、`plan.md` 修订与测试为提交 `54db2fd`，完成记录为 `135cf25`，本条仅补记提交号。回退时先 revert 本条与 `135cf25`，再 revert `54db2fd`。
