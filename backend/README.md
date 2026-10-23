# Knowrift 后端

渐进重构新增 `java/`（JDK 17、Spring Boot、SQLite 项目与模型配置管理）和 `agent/`（独立虚拟环境中的 Python Agent、三类模型协议连接测试）。工程根目录提供 `services:setup`、`test:java`、`test:agent`，具体启动与接口见 [首批重构实施与验收](../docs/首批重构实施与验收.md) 和 [第二批模型配置实施与验收](../docs/第二批模型配置实施与验收.md)。下述 npm workspace 命令仍对应现有 Node.js 实现。

core/ 包含本地学习、模型调用、文件权限、记忆、提示词、导出与策略逻辑，对外通过 @knowrift/backend 导出 LearningService。cloud/ 包含可独立部署的 HTTP 邮件提醒服务。fixtures/ 为运行时使用的评测样例，tests/ 为后端测试。

先在工程根目录执行 npm ci，再在根目录执行：

```powershell
npm test --workspace @knowrift/backend
npm run start --workspace @knowrift/backend
npm run test:live --workspace @knowrift/backend
```

test:live 会真实调用配置的百炼模型。提醒服务默认仅监听 127.0.0.1:4319，数据保存在工程根目录 .data/cloud；DATA_DIR 可覆盖。部署详见 cloud/DEPLOY.md。
