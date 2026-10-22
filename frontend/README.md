# Knowrift 前端

React 页面、状态、组件和样式保存在 src/，Vite 配置、HTML 入口和 TypeScript 配置也属于本目录。依赖在本目录的 package.json 中声明，构建输出为 dist/。

先在工程根目录执行 npm ci，再在根目录执行：

```powershell
npm run dev --workspace @knowrift/frontend
npm run build --workspace @knowrift/frontend
```

桌面开发使用根目录的 npm run desktop:dev。前端通过 window.zhixi 的 IPC 桥调用桌面服务；浏览器预览使用 Vite 服务端代理。学习业务与文件权限检查由 backend 提供，不在页面组件中执行。
