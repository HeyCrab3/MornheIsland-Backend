<!--markdownlint-disable MD001 MD033 MD041 MD051-->

<div align="center">

# MornheIsland-Backend

MornheIsland · 莫宁岛 后端服务

[![GitHub Repo size](https://img.shields.io/github/repo-size/HeyCrab3/MornheIsland-Backend?style=flat-square&color=3cb371)](https://github.com/HeyCrab3/MornheIsland-Backend)
[![GitHub Repo Languages](https://img.shields.io/github/languages/top/HeyCrab3/MornheIsland-Backend?style=flat-square)](https://github.com/HeyCrab3/MornheIsland-Backend/search)

</div>

---

## 技术栈

Express · TypeScript · MongoDB · JWT · express-jwt · log4js

## 快速开始

```bash
cp config.ts.example config.ts   # 编辑数据库连接和密钥
pnpm install
pnpm start                        # 默认端口 7000
```

## 项目结构

```
├── server.ts                     # 入口：Express 初始化、中间件、路由加载
├── config.ts                     # 配置（需自行创建，已 gitignore）
├── config.ts.example             # 配置模板
├── router/
│   ├── ci/                       # ClassIsland 客户端公开端点（无需鉴权）
│   │   ├── manifest.ts           #   GET  /v1/ci/:classId/manifest.json
│   │   ├── classplan.ts          #   GET  /v1/ci/:classId/classplan.json
│   │   ├── timelayout.ts         #   GET  /v1/ci/:classId/timelayout.json
│   │   ├── subjects.ts           #   GET  /v1/ci/:classId/subjects.json
│   │   ├── settings.ts           #   GET  /v1/ci/:classId/settings.json
│   │   └── policy.ts             #   GET  /v1/ci/:classId/policy.json
│   ├── console/ci/               # 管理后台端点（需 JWT 鉴权）
│   │   ├── class.ts              #   班级 CRUD
│   │   ├── classplan.ts          #   课表资源 CRUD
│   │   ├── timelayout.ts         #   时间表资源 CRUD
│   │   ├── subjects.ts           #   科目资源 CRUD
│   │   ├── settings.ts           #   设置资源 CRUD
│   │   ├── policy.ts             #   策略资源 CRUD
│   │   ├── history.ts            #   历史版本 + 恢复
│   │   └── devices.ts            #   设备追踪
│   └── user/                     # 用户相关
│       ├── login/sso/            #   CrabCity SSO 登录
│       └── delete.ts             #   账户注销
├── middleware/
│   └── router_whitelist.ts       # JWT 白名单（CI 端点 + 资源路由自动扫描）
├── util/
│   ├── db.ts                     # MongoDB 连接
│   ├── log.ts                    # log4js 日志
│   ├── ci_resource.ts            # 资源通用 CRUD + 历史版本 + 引用校验
│   ├── ci_public.ts              # 公开端点 ObjectId/identity 查找
│   └── uuid.ts                   # UUID 生成
└── types/
    ├── ConfigProvider.ts         # 配置类型定义
    └── ExpressExpander.d.ts      # Express Request 扩展（db, auth）
```

## API 概览

### ClassIsland 客户端端点（公开）

| 端点 | 说明 |
|---|---|
| `GET /v1/ci/:classId/manifest.json` | 集控清单（含版本号和子文件 URL） |
| `GET /v1/ci/:classId/classplan.json` | 课表 |
| `GET /v1/ci/:classId/timelayout.json` | 时间表 |
| `GET /v1/ci/:classId/subjects.json` | 科目 |
| `GET /v1/ci/:classId/settings.json` | 应用设置 |
| `GET /v1/ci/:classId/policy.json` | 策略 |

`:classId` 为班级的 MongoDB ObjectId。客户端配置中 `ManifestUrlTemplate` 使用 `{id}` 模板，ClassIsland 会自动替换。

### 管理后台端点（需 JWT）

| 端点 | 说明 |
|---|---|
| `POST /v1/console/ci/class` | 创建班级 |
| `GET /v1/console/ci/class/list` | 班级列表 |
| `GET /v1/console/ci/class/:id` | 班级详情（含关联资源） |
| `PUT /v1/console/ci/class/:id` | 更新班级 |
| `DELETE /v1/console/ci/class/:id` | 删除班级（不删关联资源） |
| `GET /v1/console/ci/:type/list` | 资源列表（type: classplan/timelayout/subjects/policy） |
| `POST /v1/console/ci/:type` | 创建资源 |
| `GET /v1/console/ci/:type/:id` | 资源详情（含用量信息） |
| `PUT /v1/console/ci/:type/:id` | 更新资源（自动版本号 +1，旧版存历史） |
| `DELETE /v1/console/ci/:type/:id` | 删除资源（检查引用，有引用则拒绝） |
| `GET /v1/console/ci/:type/:id/history` | 历史版本列表 |
| `GET /v1/console/ci/:type/:id/history/:ver` | 查看某版本 |
| `POST /v1/console/ci/:type/:id/restore/:ver` | 恢复到某版本 |
| `GET /v1/console/ci/devices` | 设备追踪 |
| `DELETE /v1/user/delete` | 注销账户（清除所有数据） |

### 通用响应格式

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

## 数据模型

```
ci_classes         # 班级（userId, identity, name, classplanId, timelayoutId, ...）
ci_classplans      # 课表资源（userId, name, version, data）
ci_timelayouts     # 时间表资源
ci_subjects        # 科目资源
ci_settings        # 设置资源
ci_policies        # 策略资源
ci_history         # 历史版本（resourceCollection, resourceId, version, name, data）
user               # 用户（CrabCity SSO 登录自动创建）
request_log        # 请求日志（用于设备追踪）
```

所有资源数据隔离通过 `userId` 字段实现，控制台端点从 JWT 提取 userId 过滤。

## 配置

参见 `config.ts.example`，需要配置：

- `db_url` — MongoDB 连接字符串
- `db_name` — 数据库名
- `port` — 监听端口（默认 7000）
- `jwt.secret` — JWT 签名密钥
- `session_secret` — Express Session 密钥
- `sso.client_id` / `sso.client_secret` — CrabCity OAuth 凭证

### 集控 gRPC

客户端用 ClassIsland 的集控模式长连接本服务，默认监听 `20722`（`grpc_port`）。
下发给客户端的地址由 `public_grpc_address` 决定，留空时前端按「控制台域名:grpc_port」推断。

部署要点：

- **建议启用 TLS**（`grpc_tls_cert` + `grpc_tls_key` 两项都填，证书放 `certs/`，该目录已 gitignore），
  对外地址写 `https://域名:20722`。
- **客户端开了系统代理就连不上，且这与 TLS 无关。** `Grpc.Net.Client` 的负载均衡层
  （`BalancerHttpHandler`）与 HTTP 代理不兼容：它把 subchannel 挂在 `HttpRequestMessage` 上，
  经代理时连接的初始请求是 `CONNECT` 隧道请求、读不到该选项，于是抛
  `HttpRequestException: Unable to get subchannel from HttpRequestMessage.`。
  明文 `http://` 则是另一个错法：`unable to establish HTTP/2 connection`。
  换 `https://` 只改变报错内容，**不能**修好。ClassIsland 用
  `GrpcChannel.ForAddress(addr)`（不传 options）建连接，客户端改不了这个行为，服务端也无解——
  上游已知限制，见 [grpc-dotnet#2254](https://github.com/grpc/grpc-dotnet/issues/2254)，无修复时间表。
  - 唯一办法：客户端**不走代理**连接该域名——把它加入系统代理例外，或关掉系统代理改用 TUN 模式。
  - 仅在代理软件里给该域名配「直连 / DIRECT」规则**无效**，流量仍会先进代理进程。
  - 校内局域网部署（`10.` / `172.16-31.` / `192.168.` 私有地址）能自动命中 Windows 默认代理例外，可绕开该问题。

## 许可

AGPLv3 License · Copyright © 2019-2026 Crab Studio
