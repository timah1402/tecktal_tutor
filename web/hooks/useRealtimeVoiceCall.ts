"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";

export type RealtimeCallState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

interface RealtimeResponseOutputItem {
  type: string;
  name?: string;
  call_id?: string;
  arguments?: string;
}

interface RealtimeServerEvent {
  type: string;
  transcript?: string;
  response?: { output?: RealtimeResponseOutputItem[] };
  [key: string]: unknown;
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// A forgotten open call would otherwise run (and bill) indefinitely — end it
// after a stretch of mutual silence. Checked on an interval rather than one
// long timer so it naturally resets as long as either side is active.
const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
const SILENCE_CHECK_INTERVAL_MS = 5_000;

export interface UseRealtimeVoiceCallOptions {
  /** Fires once per finished user utterance, with the transcribed text. */
  onUserUtterance?: (text: string) => void;
  /** Fires once per finished assistant utterance, with the spoken text. */
  onAssistantUtterance?: (text: string) => void;
  /**
   * Fires when the model calls one of the tools declared server-side (see
   * voice.py's session config). Return value is sent back to the model as
   * the function's result, so it can speak an accurate confirmation.
   */
  onFunctionCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  /**
   * Fires at the end of every response turn (response.done), before function
   * calls are dispatched. `hadFunctionCalls` is true when the model called at
   * least one tool in this turn — callers use this to skip recording navigation/
   * tool-call exchanges to chat history.
   */
  onTurnComplete?: (hadFunctionCalls: boolean) => void;
  /** Override for tests; production callers should leave this at the default. */
  silenceTimeoutMs?: number;
}

/**
 * Full-duplex speech-to-speech voice call against OpenAI's Realtime API,
 * connected directly browser↔OpenAI over WebRTC (our backend only mints the
 * short-lived token — see ``POST /api/v1/voice/realtime-session``; no audio
 * is ever relayed through our server).
 *
 * Turn-taking and barge-in (interrupting the assistant mid-sentence) rely
 * entirely on OpenAI's server-side voice activity detection — this hook just
 * reflects the resulting events, it does not implement VAD itself.
 */
export function useRealtimeVoiceCall(options: UseRealtimeVoiceCallOptions) {
  const [state, setState] = useState<RealtimeCallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lastActivityRef = useRef<number>(Date.now());
  const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopSilenceWatchdog = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopSilenceWatchdog();
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.pause();
      audioElRef.current = null;
    }
  }, [stopSilenceWatchdog]);

  const disconnect = useCallback(() => {
    cleanup();
    setState("idle");
  }, [cleanup]);

  const startSilenceWatchdog = useCallback(() => {
    stopSilenceWatchdog();
    lastActivityRef.current = Date.now();
    const timeoutMs = optionsRef.current.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    silenceTimerRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= timeoutMs) {
        cleanup();
        setState("idle");
        setNotice("Call ended after a period of silence.");
      }
    }, SILENCE_CHECK_INTERVAL_MS);
  }, [cleanup, stopSilenceWatchdog]);

  const sendClientEvent = useCallback((payload: Record<string, unknown>) => {
    dcRef.current?.send(JSON.stringify(payload));
  }, []);

  // The model doesn't auto-continue after a function call — we have to send
  // its result back, then explicitly ask for a response. But in practice the
  // model often already speaks a confirmation in the *same* turn it calls
  // the function (observed live, not just per docs), so we only request a
  // follow-up response when it didn't already say something out loud —
  // otherwise the user would hear two confirmations back to back.
  const handleFunctionCalls = useCallback(
    async (output: RealtimeResponseOutputItem[]) => {
      const calls = output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return;
      const alreadySpoke = output.some(
        (item) =>
          item.type === "message" &&
          Array.isArray((item as { content?: unknown[] }).content) &&
          ((item as { content?: unknown[] }).content?.length ?? 0) > 0,
      );
      for (const call of calls) {
        if (!call.name || !call.call_id) continue;
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          // Malformed arguments — proceed with an empty object; our tools'
          // arguments are all optional or single-enum, so this is recoverable.
        }
        let result: unknown;
        try {
          result = await optionsRef.current.onFunctionCall?.(call.name, args);
        } catch (err) {
          result = {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }
        sendClientEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result ?? { status: "ok" }),
          },
        });
      }
      if (!alreadySpoke) {
        sendClientEvent({ type: "response.create" });
      }
    },
    [sendClientEvent],
  );

  const handleServerEvent = useCallback((event: RealtimeServerEvent) => {
    lastActivityRef.current = Date.now();
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        setState("listening");
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = (event.transcript || "").trim();
        if (text) optionsRef.current.onUserUtterance?.(text);
        break;
      }
      case "response.created":
        setState("speaking");
        break;
      case "response.output_audio_transcript.done": {
        const text = (event.transcript || "").trim();
        if (text) optionsRef.current.onAssistantUtterance?.(text);
        break;
      }
      case "response.done": {
        const output = event.response?.output ?? [];
        const hadFunctionCalls = output.some(
          (item) => item.type === "function_call" && item.name,
        );
        // Fire before dispatching function calls so VoiceCallContext can
        // decide whether to commit the pending exchange to chat history.
        optionsRef.current.onTurnComplete?.(hadFunctionCalls);
        if (output.length) void handleFunctionCalls(output);
        setState("listening");
        break;
      }
      case "response.cancelled":
        setState("listening");
        break;
      case "error":
        setError(
          (event as { error?: { message?: string } }).error?.message ||
            "The voice call hit an error.",
        );
        setState("error");
        break;
      default:
        break;
    }
  }, [handleFunctionCalls]);

  const connect = useCallback(async () => {
    if (state !== "idle" && state !== "error") return;
    setError(null);
    setNotice(null);
    setState("connecting");

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      setError("Real-time voice is not supported in this browser.");
      setState("error");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission denied.");
      setState("error");
      return;
    }
    streamRef.current = stream;

    let clientSecret: string;
    try {
      const resp = await apiFetch(apiUrl("/api/v1/voice/realtime-session"), {
        method: "POST",
      });
      if (!resp.ok) {
        const detail = (await resp.json().catch(() => null)) as {
          detail?: string;
        } | null;
        throw new Error(
          detail?.detail || `Could not start the voice call (HTTP ${resp.status}).`,
        );
      }
      const data = (await resp.json()) as { client_secret?: string };
      if (!data.client_secret) throw new Error("No voice call token returned.");
      clientSecret = data.client_secret;
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "Could not start the voice call.");
      setState("error");
      return;
    }

    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTrack(stream.getAudioTracks()[0], stream);

      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (event) => {
        audioEl.srcObject = event.streams[0];
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          if (pcRef.current === pc) {
            cleanup();
            setState((prev) => (prev === "idle" ? prev : "error"));
            if (pc.connectionState === "failed") {
              setError("The voice call connection was lost.");
            }
          }
        }
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = (event) => {
        try {
          handleServerEvent(JSON.parse(event.data) as RealtimeServerEvent);
        } catch {
          // Ignore malformed/unrecognized data-channel payloads.
        }
      };
      dc.onopen = () => {
        setState("listening");
        startSilenceWatchdog();
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!sdpResp.ok) {
        throw new Error(`OpenAI rejected the voice call connection (HTTP ${sdpResp.status}).`);
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "Could not connect the voice call.");
      setState("error");
    }
  }, [cleanup, handleServerEvent, startSilenceWatchdog, state]);

  // Tear down if the component unmounts mid-call.
  useEffect(() => cleanup, [cleanup]);

  return { state, error, notice, connect, disconnect };
}
