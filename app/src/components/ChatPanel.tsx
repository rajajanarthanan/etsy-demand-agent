"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { LinkifiedText } from "./LinkifiedText";

/** Portfolio demo thread — grounded sample Q&A so the home screen never looks empty. */
const DEMO_MESSAGES: UIMessage[] = [
  {
    id: "demo-user-1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Which Wave-1 categories should I prioritize for makeable hardwood housewares, and what should I ignore?",
      },
    ],
  },
  {
    id: "demo-assistant-1",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `Based on this run (406 US listings, 0 CA — no Canada signal to invent):

Prioritize (clear makeable SKUs)
1. cutting_board — combined noise ~2,550; median ~$45. Strongest named Wave-1 leader after the catch-all.
2. shelves_hooks — ~1,177 noise; median ~$67. Makeable overseas if you keep SKUs simple (racks/hooks, not custom millwork).
3. bowls_trays / frames — solid mid-tier noise (~929 / ~780) with approachable price bands.

Treat carefully
• kitchen_utensils (~410) and coasters_slices (~128) — real but quieter; good for line extensions, not the first bet.
• other_wood tops the board (~6,373) but is a catch-all bucket (sculpture, misc décor). Do not treat it as a production SKU.

Caveat: scores are demand proxies (rank, badges, recent reviews) — not verified unit sales. Prefer named Wave-1 categories for manufacturing decisions.`,
      },
    ],
  },
];

export function ChatPanel({ hasOpenAI }: { hasOpenAI: boolean }) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );
  const { messages, sendMessage, status, error, setMessages } = useChat({
    transport,
    messages: DEMO_MESSAGES,
  });
  const [input, setInput] = useState("");
  const [rememberMsg, setRememberMsg] = useState("");
  const busy = status !== "ready";
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  async function rememberLast() {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const text =
      lastAssistant?.parts
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n") ?? "";
    if (!text.trim()) {
      setRememberMsg("No assistant reply to remember yet.");
      return;
    }
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "remember",
        text: text.slice(0, 2000),
        tags: ["chat"],
      }),
    });
    const data = await res.json();
    setRememberMsg(
      data.ok ? "Saved to portable memory notes." : data.error || "Failed",
    );
  }

  return (
    <aside className="panel chat-panel">
      <div className="chat-panel-head">
        <h2>Analyst chat</h2>
        <p className="muted" style={{ margin: 0 }}>
          Grounded in summary, business rules, run state, TOON digest, and
          memory.
        </p>
        {!hasOpenAI && (
          <p className="status-err" style={{ marginBottom: 0 }}>
            Add an OpenAI API key in Settings to enable chat. Charts and
            briefing still work offline.
          </p>
        )}
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="muted">
            Try: “Top makeable Wave‑1 categories and why?” or “Any India-based
            sellers in this run?”
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <strong>{m.role === "user" ? "You" : "Desk"}</strong>
            <div className="bubble-body">
              {m.parts.map((part, i) =>
                part.type === "text" ? (
                  <LinkifiedText key={i} text={part.text} />
                ) : null,
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-panel-foot">
        {error && <p className="status-err">{error.message}</p>}
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy || !hasOpenAI) return;
            sendMessage({ text: input });
            setInput("");
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy || !hasOpenAI}
            placeholder="Ask about demand, categories, listings…"
          />
          <button
            className="btn btn-accent"
            type="submit"
            disabled={busy || !hasOpenAI}
          >
            Send
          </button>
        </form>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void rememberLast()}
            disabled={!hasOpenAI}
          >
            Remember last reply
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setMessages(DEMO_MESSAGES)}
            title="Restore the sample analyst thread"
          >
            Reset demo
          </button>
          {rememberMsg && <span className="muted">{rememberMsg}</span>}
        </div>
      </div>
    </aside>
  );
}
