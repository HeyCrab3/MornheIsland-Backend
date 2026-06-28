import express, { Request, Response } from 'express';

type RequestMethod = 'get' | 'post' | 'put' | 'delete'

// 快速创建新路由
export const createRouter = (routerPath: string, reqType: RequestMethod, cb: (req: Request, res: Response) => void) => {
    const router = express.Router();
    // 根据 reqType 参数选择相应的 HTTP 请求方法
    switch (reqType.toLowerCase()) {
        case 'get':
            router.get(routerPath, (req: Request, res: Response) => {
                cb(req, res);
            });
            break;
        case 'post':
            router.post(routerPath, (req: Request, res: Response) => {
                cb(req, res);
            });
            break;
        case 'delete':
            router.delete(routerPath, (req: Request, res: Response) => {
                cb(req, res);
            });
            break;
        case 'put':
            router.put(routerPath, (req: Request, res: Response) => {
                cb(req, res);
            });
            break;
        default:
            throw new Error('不受支持的路由类型  ' + reqType);
    }
    // 返回创建的路由
    return router;
};