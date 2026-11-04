import { createApp } from "./app.ts";
// Reels get a narration and music bed; AXYS_NARRATION=off turns that off.
const { app, engine } = createApp(undefined, {
  narrate: process.env.AXYS_NARRATION !== "off",
});
const port = Number(process.env.AXYS_PORT || process.env.PORT || 4310);
const server = app.listen(
  port,
  process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
  () => console.log(`Axys: http://127.0.0.1:${port}`),
);
const timer = setInterval(() => void engine.tick(), 1000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close();
});
