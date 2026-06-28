import express from "express";
import jwt from "jsonwebtoken";
import Axios from "axios";
import { log } from "../../../../util/log.ts";
import { config } from "../../../../config.ts";
import { ObjectId } from "mongodb";

const router = express.Router();

const ssoAuthRouter = router.post("/v1/user/sso/login", async (req, res) => {
  try {
    const data = req.body;
    const db = req.db;
    const collection = db.collection("user");
    const collection1 = db.collection("state");
    const collection2 = db.collection("ticket");
    const ticket = await collection2.findOne({ ticket: data.ticket });
    const stateInfo = await collection1.findOne({ state: data.state });
    log(`获取到票据信息 ${data.ticket}`, "info", "auth");
    log(`获取到状态信息 ${data.state}`, "info", "auth");
    if (stateInfo.used == true)
      res
        .json({ code: 418, msg: "State 不匹配。您可能是 CSRF 攻击的受害者。" })
        .status(418);
    else {
      log(`连接单点登录系统...`, "info", "auth");
      Axios({
        url: "https://id.crabapi.cn/api/login/oauth/access_token",
        method: "POST",
        data: {
          grant_type: "authorization_code",
          client_id: config.sso?.client_id || "",
          client_secret: config.sso?.client_secret || "",
          code: data.code,
        },
      })
        .then((r) => {
          const accessToken = r["data"]["access_token"];
          Axios(
            `https://id.crabapi.cn/api/get-account?accessToken=${accessToken}`,
          )
            .then(async (r1) => {
              collection1.updateOne(
                { state: data.state },
                { $set: { used: true } },
              );
              const userName = r1["data"]["name"];
              const user = await collection.findOne({ userName: userName });
              if (user) {
                const token = jwt.sign(
                  {
                    userId: user._id,
                    userName: user.userName,
                    admin: user.admin,
                  },
                  config.jwt.secret,
                  { expiresIn: "30d" },
                );
                if (ticket) {
                  collection2.updateOne(
                    { ticket: data.ticket },
                    { $set: { accessToken: token } },
                  );
                }
                log(
                  `${userName} 登陆成功，当前时间 ${new Date().toLocaleString()}`,
                  "info",
                  "auth",
                );
                res.json({ code: 0, msg: "登陆成功", data: token });
              } else {
                const data1 = {
                  _id: new ObjectId(),
                  userName: userName,
                  passWord: null,
                };
                collection.insertOne(data1);
                const token = jwt.sign(
                  { userId: data1._id, userName: data1.userName, admin: false },
                  config.jwt.secret,
                  { expiresIn: "30d" },
                );
                if (ticket) {
                  collection2.updateOne(
                    { ticket: data.ticket },
                    { $set: { accessToken: token } },
                  );
                }
                log(
                  `${userName} 登陆成功，当前时间 ${new Date().toLocaleString()}`,
                  "info",
                  "auth",
                );
                res.json({ code: 0, msg: "登陆成功", data: token });
              }
            })
            .catch((e1) => {
              log(`未知错误（SSO登录，Step 2）${e1}`, "error", "auth");
              res
                .json({ code: 500, msg: "获取用户信息失败：" + e1 })
                .status(500);
            });
        })
        .catch((e) => {
          log(`未知错误（SSO登录，Step 1）${e}`, "error", "auth");
          res
            .json({ code: 500, msg: "与单点登录服务器通讯失败：" + e })
            .status(500);
        });
    }
  } catch (error) {
    log(`未知错误（SSO登录）${error}`, "error", "auth");
    res.json({ code: 500, msg: "内部服务器错误：" + error }).status(500);
  }
});

export default ssoAuthRouter;
