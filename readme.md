# EasyEval

EasyEval 是一个面向 **AI Agent 单轮会话**的评测平台。用一批样本和一条规则评估 Agent，在批次结果里找出低分样本，再顺着调用轨迹查看模型回答了什么、调用了哪个工具，以及哪些步骤影响了得分。

一条规则可以定义自己的评分 JSON，同一条样本可以有一个总分和多个独立指标。例如，「过程质量」规则分别评估步骤拆解、工具选择、参数填写和工具执行。结果页可以按某个指标筛选样本，查看该次评分的理由和证据。

## 当前可以用什么

| 模块 | 当前能力 |
| --- | --- |
| 浏览器演示 | 体验任务管理、四步创建向导、批次结果和轨迹下钻。评分、模型调用和轨迹使用演示数据。 |
| 数据与规则 API | 导入 CSV 和 Excel 工作表，保存数据集、场景、规则与任务的冻结版本，支持筛选、复制和归档。 |
| 运行与结果 API | 创建、查询和取消运行批次，防止重复提交。对已写入的评分记录提供批次汇总、独立指标、样本筛选和明细。 |
| 账号与存储 | 后端使用 PostgreSQL 17，按个人会话校验资源归属。本地开发可用命令行签发会话。 |

前端与 API 的连接、面向用户的登录页面、自动执行评测的 Runner，以及 DeepSeek Harness 和 Coze Loop 裁判的真实调用均在开发中。当前创建运行可以得到批次记录，自动推理与评分尚待接入。

## 体验演示

克隆仓库，用 Chrome 打开本地的 `demo/index.html`，即可体验完整界面。打开「过程质量回归评测」的历史批次 `RUN-002`，可以看到五条固定样本和批次均分 `37.5%`。从低分样本进入详情，可以同时查看各指标判定和对应的轨迹。[演示文件](demo/index.html)

## 启动后端

需要 Node.js 24、npm 和 PostgreSQL 17。下面的命令使用 Docker Compose 在本机启动数据库。从仓库根目录安装依赖并复制配置模板。

```sh
npm ci
cp -n .env.example .env
```

在 `.env` 中，将 `POSTGRES_PASSWORD` 和 `DATABASE_URL` 里的 `REPLACE_WITH_PASSWORD` 设为同一个随机十六进制密码，再启动服务。

```sh
docker compose up -d --wait db
npm start
```

如果已有 PostgreSQL 实例，把 `DATABASE_URL` 指向平台专用数据库，直接运行 `npm start` 即可。后端会自动执行迁移，默认监听本机 8080 端口。打开另一个终端检查连接。

```sh
curl -fsS http://127.0.0.1:8080/api/health
# {"status":"ok","database":"postgresql"}
```

### 导入第一份数据集

签发一个有效期为 24 小时的本地测试会话，然后导入两条样本。重复提交相同版本和内容会返回已有记录，可以安全重试。

```sh
EVAL_TOKEN="$(npm run --silent session:create -- demo-user)"
curl -fsS http://127.0.0.1:8080/api/imports/dataset \
  -H "Authorization: Bearer $EVAL_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"support-demo","version":"v1","name":"客服示例","queryColumn":"query","csv":"query\n怎么申请退款？\n在哪里查看物流？"}'

curl -fsS http://127.0.0.1:8080/api/imports/dataset/support-demo/v1/rows \
  -H "Authorization: Bearer $EVAL_TOKEN"
```

第一次请求保存数据集版本，第二次返回两行原始样本。模型凭据和数据库连接串均由后端管理。

## 开发与验证

```sh
npm run typecheck
npm test
```

要运行 PostgreSQL 集成测试，请将 `TEST_DATABASE_URL` 设置为专用测试库的连接串，然后执行 `npm run test:postgres`。测试会创建并清理临时 schema。

产品需求、交互规范和开发计划分别记录在 [PRD](prd.md)、[界面设计](design.md) 和 [开发计划](plan.md)。项目改动需在[更新记录](update.md)中注明日期、作者和验证结果。

首个计划接入的被测 Agent 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，评估器和轨迹服务计划接入 [Coze Loop](https://github.com/coze-dev/coze-loop)。两者均为独立项目。
