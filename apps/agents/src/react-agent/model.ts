import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "moonshot-v1-128k",
  configuration: {
    apiKey: process.env.MOONSHOT_API_KEY,
    baseURL: "https://api.moonshot.cn/v1",
  },
});

/**
 * Load a chat model from a fully specified name.
 */
export async function loadChatModel(): Promise<ChatOpenAI> {
  return model;
}
