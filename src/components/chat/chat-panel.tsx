"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Bot, Loader2, Plus, Send, RefreshCw } from "lucide-react";
import { Button, Card, Textarea, EmptyState } from "@/components/ui";
import { cn, timeAgo } from "@/lib/utils";
import {
  ToolResultCard,
  parseAssistantMessage,
  parseToolResult,
  type ParsedToolResult,
} from "@/components/chat/tool-result-card";

type Role = "USER" | "ASSISTANT" | "TOOL";

type UIMessage = {
  id: string;
  role: Role;
  content: string;
  toolName?: string | null;
  createdAt?: string;
  streaming?: boolean;
  toolOk?: boolean;
  toolError?: string | null;
  toolResult?: ParsedToolResult | null;
  /** i round di solo orchestrazione tool non producono una bollicina visibile */
  hide?: boolean;
};

type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
};

const SUGGESTIONS = [
  "Preparami 3 post sulle vacanze in Grecia",
  "Scrivi una caption per un carousel sulla Sardegna",
  "Quali contenuti sono da approvare?",
  "Crea un'idea per un reel sull'isola di Corfù",
];

export function ChatPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("id");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();

  const bottomRef = useRef<HTMLDivElement>(null);
  const decidedId = useRef(false);
  const sendingRef = useRef(false);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      if (data.ok) setConversations(data.conversations);
    } catch {
      // ignore
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setLoadingMessages(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      if (data.ok && data.conversation) {
        setMessages(
          data.conversation.messages.map((m: Record<string, unknown>) => {
            const role = m.role as Role;
            const raw = String(m.content ?? "");
            const base = {
              id: m.id as string,
              role,
              toolName: (m.toolName as string | null) ?? null,
              createdAt: m.createdAt as string | undefined,
            };
            if (role === "TOOL") {
              const parsed = parseToolResult(raw);
              return {
                ...base,
                content: parsed?.label ?? (m.toolName as string | null) ?? raw,
                toolResult: parsed ?? { message: raw },
              };
            }
            if (role === "ASSISTANT") {
              const normalized = parseAssistantMessage(raw);
              return { ...base, content: normalized.text, hide: normalized.hide };
            }
            return { ...base, content: raw };
          })
        );
      }
    } catch {
      // ignore
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      setMessages([]);
      setRound(0);
      loadMessages(id);
      router.replace(`/chat?id=${id}`, { scroll: false });
    },
    [loadMessages, router]
  );

  useEffect(() => {
    loadConversations().finally(() => setLoading(false));
  }, [loadConversations]);

  useEffect(() => {
    if (!loading && !decidedId.current) {
      decidedId.current = true;
      if (requestedId) {
        selectConversation(requestedId);
      } else if (conversations.length > 0) {
        selectConversation(conversations[0].id);
      }
    }
  }, [loading, conversations, requestedId, selectConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    if (!conversationId) return;
    const id = conversationId;
    const onFocus = () => {
      loadMessages(id).then(loadConversations);
    };
    router.prefetch(`/chat?id=${id}`);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [conversationId, loadMessages, loadConversations, router, selectConversation]);

  const createNew = () =>
    startCreating(async () => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Nuova conversazione" }),
      });
      const data = await res.json();
      if (data.ok) {
        await loadConversations();
        selectConversation(data.conversation.id);
      }
    });

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || !conversationId || sendingRef.current) return;

    sendingRef.current = true;
    setInput("");
    setError(null);
    setSending(true);
    setRound(0);

    setMessages((prev) => [
      ...prev,
      { id: `local-user-${Date.now()}`, role: "USER", content: message },
      {
        id: `local-assistant-${Date.now()}`,
        role: "ASSISTANT",
        content: "",
        streaming: true,
      },
    ]);

    let doneReceived = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Errore di comunicazione con il server.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          let data: unknown;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (!data || typeof data !== "object") continue;
          const event = data as Record<string, unknown>;
          if (event.type === "agent") {
            handleAgentEvent(event.event as Record<string, unknown>);
          } else if (event.type === "error") {
            appendErrorMessage(String(event.text ?? "Errore sconosciuto."));
          } else if (event.type === "done") {
            doneReceived = true;
            const id = String(event.conversationId ?? conversationId);
            setConversationId(id);
            await loadMessages(id);
            await loadConversations();
          }
        }
      }
    } catch (e) {
      appendErrorMessage(e instanceof Error ? e.message : "Errore sconosciuto.");
    } finally {
      sendingRef.current = false;
      setSending(false);
      setRound(0);
      if (doneReceived) {
        try {
          router.refresh();
        } catch {
          /* refresh opzionale dopo una risposta riuscita */
        }
      }
    }
  };

  const handleAgentEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "round":
        setRound(Number(event.n ?? 0));
        break;
      case "tool": {
        const ok = (event as { ok?: unknown }).ok !== false;
        const toolError =
          typeof event.error === "string" && event.error.trim()
            ? event.error
            : null;
        setMessages((prev) => [
          ...prev,
          {
            id: `local-tool-${Date.now()}-${Math.random()}`,
            role: "TOOL",
            content: String(event.label ?? event.name ?? "Strumento"),
            toolName: String(event.name ?? "tool"),
            toolOk: ok,
            toolError,
            createdAt: undefined,
          },
        ]);
        break;
      }
      case "final":
        setMessages((prev) => {
          const next = [...prev];
          const i = next.findIndex((m) => m.streaming);
          if (i >= 0) {
            next[i] = {
              ...next[i],
              content: String(event.text ?? next[i].content ?? ""),
              streaming: false,
            };
          } else {
            next.push({
              id: `local-final-${Date.now()}`,
              role: "ASSISTANT",
              content: String(event.text ?? ""),
            });
          }
          return next;
        });
        break;
      default:
        break;
    }
  };

  const appendErrorMessage = (text: string) => {
    setError(text);
    setMessages((prev) => {
      const next = [...prev];
      const i = next.findIndex((m) => m.streaming);
      if (i >= 0) {
        next[i] = { ...next[i], streaming: false };
      }
      return next;
    });
  };

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <div className="hidden w-64 shrink-0 lg:block">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-semibold text-slate-800">
              Conversazioni
            </span>
            <button
              onClick={createNew}
              disabled={creating}
              className="text-sky-600 hover:text-sky-700 disabled:opacity-50"
              title="Nuova conversazione"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-1.5">
            {conversations.length === 0 ? (
              <p className="px-3 py-4 text-xs text-slate-400">
                Nessuna conversazione.
              </p>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectConversation(c.id)}
                  className={cn(
                    "mb-1 block w-full rounded-lg px-3 py-2.5 text-left transition-colors",
                    c.id === conversationId
                      ? "bg-sky-50 text-sky-700"
                      : "hover:bg-slate-50 text-slate-700"
                  )}
                >
                  <div className="truncate text-sm font-medium">
                    {c.title}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {c._count.messages} messaggi · {timeAgo(c.updatedAt)}
                  </div>
                </button>
              ))
            )}
          </div>
        </Card>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Card className="flex h-[calc(100vh-5rem)] flex-col overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-600 text-white">
              <Bot className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-800">
                Assistente AI
              </div>
              <div className="text-xs text-slate-400">
                Qwen via Ollama · gestione contenuti
              </div>
            </div>
            {round > 0 && sending ? (
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Esecuzione round {round}
              </span>
            ) : null}
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Caricamento…
              </div>
            ) : messages.length === 0 && !sending ? (
              <div className="flex h-full flex-col items-center justify-center gap-5">
                <EmptyState
                  title="Come posso aiutarti?"
                  description="Scrivi in linguaggio naturale e l'assistente userà gli strumenti per creare contenuti, generare testi, programmare e altro."
                />
                <div className="flex max-w-lg flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-sky-300 hover:text-sky-700"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((m) => {
                  if (m.role === "TOOL") {
                    return (
                      <div key={m.id} className="flex justify-start">
                        <ToolResultCard
                          toolName={m.toolName ?? "tool"}
                          label={m.content}
                          ok={m.toolOk}
                          error={m.toolError}
                          result={m.toolResult}
                        />
                      </div>
                    );
                  }
                  if (m.hide) return null;
                  const isUser = m.role === "USER";
                  return (
                    <div
                      key={m.id}
                      className={cn("flex", isUser ? "justify-end" : "justify-start")}
                    >
                      <div
                        className={cn(
                          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                          isUser
                            ? "bg-sky-600 text-white"
                            : "bg-slate-100 text-slate-800"
                        )}
                      >
                        {m.content}
                        {m.streaming ? (
                          <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded bg-sky-400 align-middle" />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {sending && !messages.some((m) => m.streaming) ? (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1.5 rounded-2xl bg-slate-100 px-4 py-2.5">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                          style={{ animationDelay: `${i * 120}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {error ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {error}
                  </div>
                ) : null}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          <div className="border-t border-slate-100 p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2"
            >
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="Scrivi un messaggio… (Invio per inviare)"
                rows={1}
                className="max-h-40 min-h-11 resize-none"
                disabled={!conversationId || sending}
              />
              <Button
                type="submit"
                disabled={!input.trim() || !conversationId || sending || loadingMessages}
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Invia
              </Button>
            </form>
            <div className="mt-2 lg:hidden">
              <button
                onClick={createNew}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-600 hover:text-sky-700"
              >
                <Plus className="h-3.5 w-3.5" />
                Nuova conversazione
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}