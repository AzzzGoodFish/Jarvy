import type { Context } from "hono";
import type { ApiEnv } from "./context.js";

export interface EventStream {
  /** Writes one event; a reader that has fallen behind (a full buffer) is disconnected instead, and reconnects. */
  send(event: string, data: unknown): void;
  /** Ends the stream. */
  close(): void;
  /** Wraps a listener so that once the session is gone, its next call ends the stream rather than running. */
  signedIn<A extends unknown[]>(listener: (...args: A) => void): (...args: A) => void;
}

/** A server-sent event stream for the signed-in person (`/events`, `/bots/:id/live`). `open` subscribes and returns
 * how to unsubscribe and the first event to send; this keeps the rest: a heartbeat every 15 s (which also ends the
 * stream once signed out), back-pressure, and cleanup when the reader leaves or the source closes. */
export function eventStream(c: Context<ApiEnv>, authenticated: () => boolean, open: (stream: EventStream) => { unsubscribe: () => void; ready: () => void }): Response {
  const signal = c.req.raw.signal;
  let disconnect!: (close?: boolean) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        if (ended) return;
        // Bounded SSE: slow readers reconnect and reload SQLite facts.
        if ((controller.desiredSize ?? 0) <= 0) { disconnect(); return; }
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const { unsubscribe, ready } = open({
        send, close: () => disconnect(),
        signedIn: listener => (...args) => { if (!authenticated()) { disconnect(); return; } listener(...args); },
      });
      const heartbeat = setInterval(() => {
        if (!authenticated()) disconnect(); else send("heartbeat", {});
      }, 15_000);
      heartbeat.unref();
      const aborted = () => disconnect();
      disconnect = (close = true) => {
        if (ended) return;
        ended = true; clearInterval(heartbeat); unsubscribe(); signal.removeEventListener("abort", aborted);
        if (close) controller.close();
      };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) disconnect(); else ready();
    },
    cancel() { disconnect(false); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: c.env.outgoing.writableHighWaterMark }));
  return c.body(body, 200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
}
