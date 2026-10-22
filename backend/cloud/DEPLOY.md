# 知隙提醒服务部署

此服务只保存本人已验证邮箱、时间规则、预备邮件和执行记录，不调用学习模型。需要 Node.js 24，或 Docker 与 Compose；持续运行于在线服务器后才可在用户电脑关机时执行。

## Docker

在解压后的根目录，将 backend/cloud/.env.example 复制为 backend/cloud/.env，填写 SMTP_HOST、SMTP_PORT、SMTP_SECURE、SMTP_USER、SMTP_PASSWORD、MAIL_FROM。ALLOWED_EMAILS 填写允许试用的邮箱列表，以逗号分隔。

```sh
# Linux 服务器
cp backend/cloud/.env.example backend/cloud/.env
# 在服务器本地编辑 backend/cloud/.env 后执行
docker compose -f backend/cloud/compose.yaml up -d --build
docker compose -f backend/cloud/compose.yaml logs --tail 50
```

Windows PowerShell 复制配置使用：

```powershell
Copy-Item -LiteralPath 'backend/cloud/.env.example' -Destination 'backend/cloud/.env'
```

端口绑定服务器本地 127.0.0.1:4319，通过服务器上的 HTTPS 反向代理开放域名。桌面设置填写该 HTTPS 地址，验证本人邮箱并同步任务。容器持久化卷保存 /data/cloud.json，部署只启用单个调度实例。

## Node.js

在配置好 backend/cloud/.env 的根目录执行：

```sh
npm ci --workspace @knowrift/backend --include-workspace-root=false --omit=dev --ignore-scripts
node --env-file=backend/cloud/.env backend/cloud/server.mjs
```

默认监听 127.0.0.1:4319，数据保存于 .data/cloud。可通过 HOST、PORT、DATA_DIR 修改。应使用服务器自己的进程管理器保持运行。

## 检查

GET /health 应返回 ok=true；mailConfigured 仅说明存在邮件配置。通过桌面创建未来任务，确认同步后退出桌面，再检查邮件和云端执行记录。SMTP 接受仅表示已提交渠道，没有送达凭据时不能当作已送达。

本次在 Windows 上通过了真实本地 HTTP 与调度逻辑测试，邮件通道使用测试替身。Docker 引擎未启动，容器构建未执行；当前包未配置真实 SMTP，也没有部署到公网。密码只在服务器填写，不进入源码或项目仓库。
