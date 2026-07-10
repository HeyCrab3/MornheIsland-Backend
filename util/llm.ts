// Copied from https://api-docs.deepseek.com/zh-cn/, edited by GitHub @HeyCrab3
// 大模型调用公共工具类
import OpenAI from "openai";
import { config } from "../config.ts";

const chatClient = new OpenAI({
    baseURL: config.llm?.endpoint,
    apiKey: config.llm?.apiKey,
    // 这里附加客户端附加参数
    ...config.llm?.extraParams
})

export const chat = async (messages: OpenAI.Chat.ChatCompletionMessage[], additionalParams?: OpenAI.Chat.ChatCompletionCreateParams | any) => {
    const completion = await chatClient.chat.completions.create({
        model: config.llm?.model || 'auto', // 不指定模型的情况下写自动参数，由Endpoint自行判断（报错自行处理）
        messages: messages,
        ...additionalParams
    })
    // 处理可能的流式传输请求
    if ('choices' in completion && Array.isArray(completion.choices)) {
        return completion.choices[0]?.message?.content ?? ''
    }

    // 消息无法被处理，抛出错误，业务侧处理
    throw new Error('Unexpected completion response shape')
}