import fs from 'fs';
import path from 'path';
import { log } from '../util/log.ts';
import { fileURLToPath } from 'url';
import { pathToRegexp } from 'path-to-regexp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const routerWhiteList = [
  '/',
  /^\/assets\/.*/,
  /^\/v1\/ci\/.*/,              // ClassIsland 集控公开端点（客户端无需 JWT）
];

// 递归扫描路由目录并添加到白名单列表中
async function scanRoutes(routerDir: string) {
    try {
        const files = await fs.promises.readdir(routerDir);
        for (const file of files) {
            const filePath = path.join(routerDir, file);
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile() && (file.endsWith('.js') || file.endsWith('.ts'))) {
                const routes = await import("file:///" + filePath);
                if (routes && routes.default && routes.default.stack && routes.default.stack.length > 0) {
                    const routePath = pathToRegexp(routes.default.stack[0].regexp, []).source.replace(/^\^|\$$/g, '');
                    const normalizedPath = routePath.split('\\').join(''); // 将反斜杠转换为斜杠
                    routerWhiteList.push(normalizedPath.replace('/?', ''));
                    log(`路由添加到白名单: ${normalizedPath.replace('/?', '')}`, 'info', 'whitelist');
                }
            } else if (stat.isDirectory()) {
                // 如果是子文件夹，则递归调用scanRoutes
                await scanRoutes(filePath);
            }
        }
        log("获取到路由白名单：" + routerWhiteList.join(', '), 'info', 'whitelist');
    } catch (error: any) {
        log(error, 'error')
        log("扫描路由出错：" + error, 'error', 'whitelist');
    }
    if (routerWhiteList[2] == '/v1/user/auth') delete routerWhiteList[2]
}

// 调用函数来扫描路由并添加到白名单列表中
(async () => {
    const routerAuthDir = path.join(__dirname, '../', 'router', 'user', 'login');
    await scanRoutes(routerAuthDir);
})();

export { routerWhiteList };
