// 配置类

import type { ClientOptions } from 'openai'

export interface ConfigProvider {
    /**
     * 配置类
     */
    /** 数据库Url */
    db_url: string,
    /** 数据库名 */
    db_name: string,
    /** 端口号 */
    port?: number | 7000,
    /** 日志文件导出位置 */
    log_path: string | './log',
    /** 路由位置 */
    router_dir: string | './router',
    /** JWT 相关配置 */
    jwt: {
        /** JWT 密钥 */
        secret: string,
        /** JWT 算法 */
        algorithms: string[]
    },
    /** Session 密钥 */
    session_secret: string,
    /** SSO 单点登录配置 */
    sso?: {
        /** OAuth client_id (CrabCity) */
        client_id: string,
        /** OAuth client_secret (CrabCity) */
        client_secret: string,
    },
    /** STCN 单点登录配置 */
    stcn?: {
        /** OAuth endpoint */
        endpoint: string,
        /** OAuth client_id */
        client_id: string,
        /** OAuth client_secret */
        client_secret: string,
        /** 应用标识 */
        application: string,
    }
    /** 腾讯云 SecretID / SecretKey（作息时间表、课程表OCR自动识别） */
    tcloud?: {
        /** SecretID */
        /**@see https://console.cloud.tencent.com/cam/capi */
        secretId: string,
        /** SecretKey */
        /**@see https://console.cloud.tencent.com/cam/capi */
        secretKey: string,
    },
    /** 引导插件（莫宁岛集控扩展）下载地址，插件页可覆盖 */
    bootstrap_plugin_url?: string,
    /** 客户端访问本服务的对外地址（如 https://ci.example.com），用于拼接插件下载地址；留空则按请求推断 */
    public_base_url?: string,
    /** 集控 gRPC 服务器监听端口，默认 20722（h2c 明文，客户端直连该端口） */
    grpc_port?: number,
    /**
     * 下发给客户端的 gRPC 地址，写进 ManagementPreset 的 ManagementServerGrpc。
     * 留空时前端按「控制台域名 + grpc_port」推断，这在只开放 443 或走了 gRPC 反向代理的环境下是错的，需显式配置。
     * 例：直连端口填 http://ci.example.com:20722；经 nginx 走 TLS 填 https://ci.example.com
     */
    public_grpc_address?: string,
    /** 大模型服务（OCR后处理） */
    llm?: {
        /** 服务地址（API Endpoint） */
        endpoint: string,
        /** API Key（请联系你的服务商获取） */
        apiKey: string,
        /** 模型名称（请联系你的服务商获取） */
        model: string,
        /** 附加参数（会在OpenAI SDK初始化时候被添加到参数末尾） */
        extraParams?: ClientOptions
    }
}
