# Knowrift 后端

core/ 包含本地学习、模型调用、文件权限、记忆、提示词、导出与策略逻辑，对外通过 @knowrift/backend 导出 LearningService。cloud/ 包含可独立部署的 HTTP 邮件提醒服务。fixtures/ 为运行时使用的评测样例，tests/ 为后端测试。

先在工程根目录执行 npm ci，再在根目录执行：

```powershell
npm test --workspace @knowrift/backend
npm run start --workspace @knowrift/backend
npm run test:live --workspace @knowrift/backend
```

test:live 会真实调用配置的百炼模型。提醒服务默认仅监听 127.0.0.1:4319，数据保存在工程根目录 .data/cloud；DATA_DIR 可覆盖。部署详见 cloud/DEPLOY.md。
