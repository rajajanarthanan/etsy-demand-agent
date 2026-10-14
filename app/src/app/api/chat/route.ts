import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { buildChatSystemPrompt } from "@/lib/chatContext";
import { readSecrets } from "@/lib/secrets";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const secrets = readSecrets();
  if (!secrets.openaiApiKey) {
    return new Response(
      JSON.stringify({
        error:
          "OpenAI API key missing. Add it in Settings — offline metrics still work without chat.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user");
  const lastText =
    lastUser?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

  const { system } = await buildChatSystemPrompt(lastText || "market overview");
  const openai = createOpenAI({ apiKey: secrets.openaiApiKey });

  const result = streamText({
    model: openai("gpt-4o-mini"),
    instructions: system,
    messages: await convertToModelMessages(messages),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
