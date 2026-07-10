import * as tencentcloud from "tencentcloud-sdk-nodejs";
import { config } from "../config.ts";
import { log } from "./log.ts";

// 初始化 OCR 客户端
const OcrClient = tencentcloud.ocr.v20181119.Client;

// 设置客户端配置
const clientConfig = {
  credential: {
    secretId: config.tcloud?.secretId,
    secretKey: config.tcloud?.secretKey,
  },
  profile: {
    httpProfile: {
      endpoint: "ocr.tencentcloudapi.com",
    },
  },
  region: "ap-guangzhou", // 默认地域，也可留空
};

export const getOcrResult = async (imageB64?: string, imageUrl?: string) => {
  // 两个参数都没有，扔掉
  if (!imageB64 && !imageUrl) {
    throw new Error("参数非法，必须在imageB64和imageUrl中至少提供一个参数");
  }
  try {
    const reqParams = imageB64 ? { ImageBase64: imageB64 } : { ImageUrl: imageUrl };
    /** 调高精OCR接口
        由于低调用量下成本差距不大，所以使用其它接口和使用高精的成本差不多，准确率更高
        计费参考：https://cloud.tencent.com/document/product/866/17619
        文档内有关免费额度的，每月一千次：
        通用文字识别、卡证文字识别、票据单据识别、特定场景识别、文档智能、文本图像增强、二维码和条形码识别等部分服务开通后即可享受1,000次/月的免费调用额度，
        以免费资源包的形式在每个月1号自动发放到您的腾讯云账号中，仅在当月有效。如果您开通了多项文字识别的服务，属于同一个共享资源包的接口共同享受1,000次/月的免费调用额度。
    **/
    const result = await new OcrClient(clientConfig).GeneralAccurateOCR(
      reqParams,
    );
    return result;
  } catch (e) {
    log(`服务错误: ${e}`, "error");
    throw new Error("服务错误：" + e);
  }
};
