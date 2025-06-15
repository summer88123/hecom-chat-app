import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { ConfigurationSchema, ensureConfiguration } from "./configuration.js";
import {
  Command,
  MessagesAnnotation,
  StateGraph,
  START,
  END,
  MemorySaver,
  interrupt,
} from "@langchain/langgraph";
import {
  ToolNode,
  HumanInterrupt,
  HumanInterruptConfig,
  ActionRequest,
  HumanResponse,
} from "@langchain/langgraph/prebuilt";
import { ToolCall } from "@langchain/core/messages/tool";
import { MCPClient } from "./client.js";
import { loadChatModel } from "./model.js";

const NODE_TOOL = "tools";
const NODE_HUMAN = "human-review";
const NODE_LLM = "call-model";

const mcpClient = new MCPClient();

await mcpClient.connectToServer();

const object_list = await mcpClient.getObjects();
const dept_list = await mcpClient.queryDeptList();
console.log("dept_list", dept_list);

// Define the function that calls the model
async function callModel(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig
): Promise<typeof MessagesAnnotation.Update> {
  /** Call the LLM powering our agent. **/
  const configuration = ensureConfiguration(config);
  // Feel free to customize the prompt, model, and other logic!
  const model = (await loadChatModel())?.bindTools(mcpClient.getTools());
  const systemPrompt = await configuration.systemPromptTemplate.format({
    system_time: new Date().toISOString(),
    object_list: object_list,
  });
  const response = await model.invoke([
    {
      role: "system",
      content: systemPrompt,
    },
    ...state.messages,
    {
      role: "user",
      content:
        "上面是工具调用的结果。用户看不到这些结果。如果你在回答中引用了这些结果，那么你需要向用户解释它们。从你上次结束的地方继续，不要重复之前的内容。",
    },
  ]);
  // We return a list, because this will get added to the existing list
  return { messages: [response] };
}

// Define the function that determines whether to continue or not
function routeModelOutput(state: typeof MessagesAnnotation.State): string {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];
  // If the LLM is invoking tools, route there.
  if ((lastMessage as AIMessage)?.tool_calls?.length || 0 > 0) {
    return NODE_HUMAN;
  }
  // Otherwise end the graph.
  else {
    return END;
  }
}

// Create a node that asks the human to confirm tool calls
async function humanConfirmToolCalls(
  state: typeof MessagesAnnotation.State
): Promise<Command> {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  const toolCall = lastMessage.tool_calls![lastMessage.tool_calls!.length - 1];

  if (toolCall.name === "create-user" && !toolCall.args.dept) {
    toolCall.args.dept = dept_list
      .slice(0, 2)
      .map((dept) => ({ name: dept.name, code: dept.code }));
  }

  const result: HumanResponse = interrupt<HumanInterrupt, HumanResponse>({
    action_request: {
      action: toolCall.name,
      args: toolCall.args,
    },
    config: {
      allow_accept: true,
      allow_edit: true,
      allow_ignore: false,
      allow_respond: false,
    },
    description: "请确认工具调用",
  });
  const humanReview = Array.isArray(result) ? result[0] : result;
  console.log("humanReview", JSON.stringify(humanReview, null, 2));
  const reviewAction = humanReview.type;
  const reviewData = humanReview.args;

  if (reviewAction === "accept") {
    return new Command({ goto: NODE_TOOL });
  } else if (reviewAction === "edit") {
    const updatedMessage = {
      role: "ai",
      content: lastMessage.content,
      tool_calls: [
        {
          id: toolCall.id,
          name: toolCall.name,
          args: reviewData?.args,
        },
      ],
      id: lastMessage.id,
    };
    return new Command({
      goto: NODE_TOOL,
      update: { messages: [updatedMessage] },
    });
  } else if (reviewAction === "response") {
    const toolMessage = new ToolMessage({
      name: toolCall.name,
      content: reviewData,
      tool_call_id: toolCall.id,
    });
    return new Command({
      goto: NODE_LLM,
      update: { messages: [toolMessage] },
    });
  }
  throw new Error("Invalid review action");
}

// Define a new graph. We use the prebuilt MessagesAnnotation to define state:
// https://langchain-ai.github.io/langgraphjs/concepts/low_level/#messagesannotation
const workflow = new StateGraph(MessagesAnnotation, ConfigurationSchema)
  // Define the nodes we will cycle between
  .addNode(NODE_LLM, callModel)
  .addNode(NODE_HUMAN, humanConfirmToolCalls, {
    ends: [NODE_TOOL, NODE_LLM],
  })
  .addNode(NODE_TOOL, new ToolNode(mcpClient.getTools()))
  // Set the entrypoint as `callModel`
  // This means that this node is the first one called
  .addEdge(START, NODE_LLM)
  .addConditionalEdges(NODE_LLM, routeModelOutput, [NODE_HUMAN, END])
  .addEdge(NODE_TOOL, NODE_LLM);

// Finally, we compile it!
// This compiles it into a graph you can invoke and deploy.
export const graph = workflow.compile({
  checkpointer: new MemorySaver(),
  interruptBefore: [], // Interrupt before the tools confirmation node
  interruptAfter: [],
});
