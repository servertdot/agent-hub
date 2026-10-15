import { useEffect, useRef } from "react";
import { useStdout, useStdin } from "ink";
import {
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  consumeSgrMouse,
  type MouseClick,
} from "./mouse.ts";

/**
 * Subscribe to left-button terminal clicks via xterm SGR mouse mode.
 * Ink has no built-in onClick; this is the usual DIY path.
 */
export function useMouse(onClick: (click: MouseClick) => void): void {
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const handlerRef = useRef(onClick);
  handlerRef.current = onClick;

  useEffect(() => {
    if (!stdin || !isRawModeSupported || !stdout?.isTTY) return;

    let pending = "";
    try {
      stdout.write(ENABLE_MOUSE);
    } catch {
      return;
    }

    const onData = (raw: string | Buffer) => {
      const chunk = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = consumeSgrMouse(chunk, pending);
      pending = parsed.pending;
      for (const click of parsed.clicks) {
        handlerRef.current(click);
      }
    };

    stdin.on("data", onData);

    const disable = () => {
      try {
        stdout.write(DISABLE_MOUSE);
      } catch {
        // stdout may already be closed
      }
    };
    process.once("exit", disable);

    return () => {
      stdin.off("data", onData);
      process.off("exit", disable);
      disable();
    };
  }, [stdin, isRawModeSupported, stdout]);
}
