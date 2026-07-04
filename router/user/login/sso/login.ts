import express from "express";
import jwt from "jsonwebtoken";
import Axios from "axios";
import { log } from "../../../../util/log.ts";
import { config } from "../../../../config.ts";
import { ObjectId } from "mongodb";

const router = express.Router();

function getSsoConfig(channel: number) {
  if (channel === 1) {
    return {
      tokenUrl: "https://id.crabapi.cn/api/login/oauth/access_token",
      userUrl: (accessToken: string) => `https://id.crabapi.cn/api/get-account?accessToken=${accessToken}`,
      clientId: config.sso?.client_id || "",
      clientSecret: config.sso?.client_secret || "",
    };
  }
  if (channel === 2) {
    return {
      tokenUrl: `${config.stcn?.endpoint}/api/login/oauth/access_token`,
      userUrl: (accessToken: string) => `${config.stcn?.endpoint}/api/get-account?accessToken=${accessToken}`,
      clientId: config.stcn?.client_id || "",
      clientSecret: config.stcn?.client_secret || "",
    };
  }
  return null;
}

const ssoAuthRouter = router.post("/v1/user/sso/login", async (req, res) => {
  try {
    const data = req.body;
    const db = req.db;
    const collection = db.collection("user");
    const collection1 = db.collection("state");
    const collection2 = db.collection("ticket");
    const ticket = await collection2.findOne({ ticket: data.ticket });
    const stateInfo = await collection1.findOne({ state: data.state });

    // 验证 loginChannel
    const loginChannel = parseInt(data.loginChannel) || 0;
    if (loginChannel !== 1 && loginChannel !== 2) {
      return res.status(400).json({ code: 400, msg: `无效的登录渠道：${data.loginChannel}` });
    }

    const sso = getSsoConfig(loginChannel);
    if (!sso) {
      return res.status(500).json({ code: 500, msg: "SSO 配置缺失" });
    }

    log(`获取到票据信息 ${data.ticket} channel=${loginChannel}`, "info", "auth");
    log(`获取到状态信息 ${data.state}`, "info", "auth");

    if (stateInfo.used == true) {
      return res.status(418).json({ code: 418, msg: "State 不匹配。您可能是 CSRF 攻击的受害者。" });
    }

    log(`连接单点登录系统 (channel ${loginChannel})...`, "info", "auth");

    const r = await Axios({
      url: sso.tokenUrl,
      method: "POST",
      data: {
        grant_type: "authorization_code",
        client_id: sso.clientId,
        client_secret: sso.clientSecret,
        code: data.code,
      },
    });

    const accessToken = r["data"]["access_token"];
    const r1 = await Axios(sso.userUrl(accessToken));

    collection1.updateOne({ state: data.state }, { $set: { used: true } });
    const userName = r1["data"]["name"];
    const user = await collection.findOne({ userName: userName });

    if (user) {
      const token = jwt.sign(
        { userId: user._id, userName: user.userName, admin: user.admin },
        config.jwt.secret,
        { expiresIn: "30d" },
      );
      if (ticket) {
        collection2.updateOne({ ticket: data.ticket }, { $set: { accessToken: token } });
      }
      log(`${userName} 登陆成功 (channel ${loginChannel})`, "info", "auth");
      res.json({ code: 0, msg: "登陆成功", data: token });
    } else {
      const data1 = { _id: new ObjectId(), userName: userName, passWord: null };
      collection.insertOne(data1);
      const token = jwt.sign(
        { userId: data1._id, userName: data1.userName, admin: false },
        config.jwt.secret,
        { expiresIn: "30d" },
      );
      if (ticket) {
        collection2.updateOne({ ticket: data.ticket }, { $set: { accessToken: token } });
      }
      log(`${userName} 登陆成功（新用户, channel ${loginChannel}）`, "info", "auth");
      res.json({ code: 0, msg: "登陆成功", data: token });
    }
  } catch (error) {
    log(`未知错误（SSO登录）${error}`, "error", "auth");
    res.status(500).json({ code: 500, msg: "内部服务器错误：" + error });
  }
});

export default ssoAuthRouter;
