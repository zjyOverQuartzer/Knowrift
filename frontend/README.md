# Knowrift 前端

桌面入口先读取后端模式：旧版继续挂载学习页面；Java 模式挂载独立项目与模型设置状态，使用有类型的项目 API 和模型设置 API。`npm run desktop:dev:java` 使用新版服务；此模式的 Vite 不初始化旧 Node.js 预览业务，直接浏览器访问会提示通过桌面打开。

新版“设置”由独立 `modelSettings` 能力开放。Java 管理非密钥配置，Electron 管理凭据，Python 执行连接测试；界面不读取已保存的密钥或本机服务令牌。模型设置按需加载，切换到项目管理时保留在途测试和表单状态。桌面验收命令为根目录的 `npm run test:e2e:models`。

React 页面、状态、组件和样式保存在 src/，Vite 配置、HTML 入口和 TypeScript 配置也属于本目录。依赖在本目录的 package.json 中声明，构建输出为 dist/。

先在工程根目录执行 npm ci，再在根目录执行：

```powershell
npm run dev --workspace @knowrift/frontend
npm run build --workspace @knowrift/frontend
```

桌面开发使用根目录的 npm run desktop:dev。前端通过 window.zhixi 的 IPC 桥调用桌面服务；浏览器预览使用 Vite 服务端代理。学习业务与文件权限检查由 backend 提供，不在页面组件中执行。
