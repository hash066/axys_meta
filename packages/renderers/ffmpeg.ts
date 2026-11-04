import { spawn } from "node:child_process";

/** Kills the process and its children (on Windows the real ffmpeg can be a child of a shim). */
function killTree(p: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && p.pid)
    spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => p.kill());
  else p.kill("SIGKILL");
}
export type CommandOptions = {
  /** Hard limit (default 3 min). */
  timeoutMs?: number;
  /** Kill when stderr has been silent this long (opt-in; for ffmpeg runs that print progress). */
  stallMs?: number;
};
export function command(
  exe: string,
  args: string[],
  opts: number | CommandOptions = {},
) {
  const { timeoutMs = 180000, stallMs = 0 } =
    typeof opts === "number" ? { timeoutMs: opts } : opts;
  const started = Date.now();
  if (process.env.AXYS_FFMPEG_TRACE)
    console.error("[ffmpeg]", exe, args.join(" ").slice(0, 3000));
  return new Promise<string>((resolve, reject) => {
    const p = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "",
      stalled = false,
      stallTimer: NodeJS.Timeout | undefined;
    const watch = () => {
      if (!stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        killTree(p);
      }, stallMs);
    };
    watch();
    p.stdout.on("data", (b) => {
      out = (out + b).slice(-20000);
    });
    p.stderr.on("data", (b) => {
      err = (err + b).slice(-4000);
      watch();
    });
    const timer = setTimeout(() => killTree(p), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      clearTimeout(stallTimer);
    };
    p.on("error", (e) => {
      done();
      reject(e);
    });
    p.on("exit", (code) => {
      done();
      if (process.env.AXYS_FFMPEG_TRACE)
        console.error("[ffmpeg] exit", code, Date.now() - started, "ms");
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              `Media processing ${stalled ? "stalled" : "failed"} (${code}). ${err.slice(-250)}`,
            ),
          );
    });
  });
}
