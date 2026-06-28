// 配置类

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
        /** OAuth client_id */
        client_id: string,
        /** OAuth client_secret */
        client_secret: string,
    }
}
