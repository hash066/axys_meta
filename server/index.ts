import { createApp } from "./app.ts";
const { app, engine } = createApp();
const port = Number(process.env.AXYS_PORT || 4310);
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
