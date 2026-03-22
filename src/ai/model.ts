/**
 * OpenAI chat model adapter implementing the Teams SDK IChatModel interface.
 * Bridges Teams SDK message types to OpenAI's chat completion API.
 */

import OpenAI from "openai";
import type {
  IChatModel,
  ChatSendOptions,
  Message,
  ModelMessage,
  Function as TeamsFunction,
} from "@microsoft/teams.ai";

type OpenAIMessage = OpenAI.ChatCompletionMessageParam;
type OpenAITool = OpenAI.ChatCompletionTool;

function toOpenAIMessages(
  system: Message | undefined,
  history: Message[],
  input: Message
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (system) {
    messages.push({
      role: "system",
      content: typeof system.content === "string" ? system.content : "",
    });
  }

  for (const msg of history) {
    messages.push(convertMessage(msg));
  }

  messages.push(convertMessage(input));
  return messages;
}

function convertMessage(msg: Message): OpenAIMessage {
  switch (msg.role) {
    case "user":
      return {
        role: "user",
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .map((p) => ("text" in p ? p.text : "[image]"))
                .join(""),
      };
    case "system":
      return { role: "system", content: msg.content };
    case "model":
      if (msg.function_calls && msg.function_calls.length > 0) {
        return {
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.function_calls.map((fc) => ({
            id: fc.id,
            type: "function" as const,
            function: {
              name: fc.name,
              arguments: JSON.stringify(fc.arguments),
            },
          })),
        };
      }
      return { role: "assistant", content: msg.content ?? "" };
    case "function":
      return {
        role: "tool",
        content: msg.content ?? "",
        tool_call_id: msg.function_id,
      };
    default:
      return { role: "user", content: "" };
  }
}

function toOpenAITools(
  functions: Record<string, TeamsFunction> | undefined
): OpenAITool[] | undefined {
  if (!functions || Object.keys(functions).length === 0) return undefined;

  return Object.values(functions).map((fn) => ({
    type: "function" as const,
    function: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters as Record<string, unknown>,
    },
  }));
}

export class OpenAIChatModel implements IChatModel {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async send(
    input: Message,
    options?: ChatSendOptions
  ): Promise<ModelMessage> {
    const rawValues = options?.messages?.values() ?? [];
    const history = Array.isArray(rawValues) ? rawValues : await rawValues;
    const tools = toOpenAITools(options?.functions);

    const messages = toOpenAIMessages(options?.system, history, input);

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools,
      temperature: 0.3,
    });

    const choice = completion.choices[0];
    if (!choice) {
      return { role: "model", content: "No response from model." };
    }

    const msg = choice.message;

    const result: ModelMessage = {
      role: "model",
      content: msg.content ?? undefined,
    };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      result.function_calls = msg.tool_calls
        .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        }));
    }

    return result;
  }
}
