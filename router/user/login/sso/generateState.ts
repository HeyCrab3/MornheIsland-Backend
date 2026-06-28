import express from 'express';
import { log } from '../../../../util/log.ts';
import { uuid } from '../../../../util/uuid.ts';

const router = express.Router();

const generateStateRouter = router.get("/v1/user/sso/generateState",async  (req, res) => {
    try{
        const data = req.body;
        const db = req.db;
        const collection = db.collection('state');
        const uuid1 = uuid();
        log(`生成新的 State：${uuid1}`, 'info', 'auth')
        const data1 = { state: uuid1, used: false }
        collection.insertOne(data1)
        res.json({ code: 0, 'msg': 'ok', data: uuid1 })
    }
    catch (e){
        log(`未知错误（生成 State）${e}`, 'error', 'auth')
        res.json({ code: 500, 'msg': 'unknown error ' + e }).status(500)
    }
});

export default generateStateRouter;
