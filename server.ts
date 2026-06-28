// @ts-nocheck

import { config } from './config'
import { log } from './util/log'
import express from 'express'
import process, { exit } from 'node:process';
import { expressjwt } from 'express-jwt'
import { client } from './util/db';
import chokidar from 'chokidar';
import { routerWhiteList } from './middleware/router_whitelist';
import * as fs from 'fs'
import path from 'node:path';
import { resolve } from 'path';
import { spawn } from 'node:child_process';
import { uuid } from './util/uuid'
import session from 'express-session';

const app = express()

app.use(express.json())

// 设置路由目录
const routerDir = config.router_dir;

// 连接数据库
async function connectDB() {
    log('正在连接数据库');
    try {
        await client.connect();
        log('成功连接数据库');
    } catch (e) {
        log('无法连接数据库，程序将会退出：' + e, 'fatal');
        exit(1);
    }
}

// 初始化数据库连接
connectDB();

// 监听路由文件变化并重新加载路由
const watcher = chokidar.watch(routerDir);
watcher.on('change', async (path) => {
    log(`检测到对路由 ${path} 的更改，正在重启...`);
    const script = process.argv[1];
    loadRoutes(routerDir)
});

async function loadRoutes(routerDir) {
    try {
        // 遍历每个子目录
        const subDirs = await fs.promises.readdir(routerDir);
        for (const subDir of subDirs) {
            const subDirPath = routerDir.includes(resolve('./')) ? path.join(routerDir, subDir) : path.join(resolve('./'), routerDir, subDir);
            const stat = await fs.promises.stat(subDirPath);
            // 如果是目录，则递归调用loadRoutes函数
            if (stat.isDirectory()) {
                await loadRoutes(subDirPath);
            } else if (stat.isFile() && (subDir.endsWith('.js') || subDir.endsWith('.ts'))) {
                // 如果是文件，则加载路由文件
                const routerPath = path.join(subDirPath);
                try {
                    // 动态导入模块
                    const { default: router } = await import("file:///" + routerPath);
                    if (router && router.stack) {
                        // 添加新的路由
                        app.use('/', router);
                        log("已注册路由 " + routerPath, 'info', 'routes')
                    }
                } catch (error) {
                    log(`无法加载路由 ${routerPath}：${error}`, "error", 'routes')
                }
            }
            else{
                log("正在跳过 " + path.join(subDirPath), 'info', 'routes')
            }
        }
    } catch (error) {
        log(`扫描路由目录 ${routerDir} 出错：${error}`, "error", 'routes');
    }
}

loadRoutes(routerDir)


// 异常处理中间件
app.use((error, _req, _res, next) => {
    log(`发生异常事件 ${error}`, 'error')
    next()
});

// 数据库连接中间件
app.use((req, _res, next) => {
    req.db = client.db(config.db_name); // Attach the database to the request object
    next();
});

// JWT 鉴权中间件
app.use(expressjwt(config.jwt).unless({path: routerWhiteList}))

// 请求日志中间件
app.use((req, res, next) => {
    const db = client.db(config.db_name)
    const req_uuid = uuid()
    const collection = db.collection("request_log")
    collection.insertOne({
        ip: req.ip,
        url: req.originalUrl,
        path: req.path,
        method: req.method,
        uuid: req_uuid,
        time: new Date().toLocaleString(),
        ts: new Date().getTime()
    })
    res.header('X-CrabCity-Request-ID', req_uuid)
    log(`${req.ip} => (${req.protocol}) ${req.originalUrl} (干净路径 ${req.path}) (${req.method}) 请求ID ${req_uuid}`, 'info', 'access');
    next();
});

// 根路由
app.get('/', (_req, res) => {
  res.json({'code': 0, 'msg': 'ok'});
});

app.use('/assets', express.static('assets'))

app.get("/v1/user/auth",async  (req, res) => {
    try{
        res.json({ code: 0, 'msg': 'ok', data: req.auth })
    }
    catch{
        res.status(401).json({ code: 401, 'msg': 'unauthorized' })
    }
});

// 错误处理中间件
app.use((err,req,res,_next)=>{
    if(err.name==='UnauthorizedError'){
        return res.json({
            code: 401,
            msg: '请先登录'
        });
    }
    else{
        return res.json({code: 500, msg: '服务器内部错误 ' + err}).status(500);
    }
});

app.use(session({
    secret: config.session_secret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// 启动服务器
const server = app.listen(config.port, () => {
    if (process.env.DOCKER_ENV){
        log("正在 Docker 中运行，请注意添加容器端口映射（7000->any）。");
    }
    else{
        log("以普通方式运行");
    }
    log('日志系统已初始化');
    log('服务器正在运行在端口 ' + config.port);
});

// 退出处理
process.on('exit', (code) => {
    log(`程序以错误码 ${code} 退出`);
});

// 当关闭服务器时，停止监听文件更改
process.on('SIGINT', () => {
    watcher.close();
    server.close();
    log('服务器已关闭');
    process.exit(0);
});

export { server }