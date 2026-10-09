// Vercel serverless entry — React Router v7 Node adapter
import { createRequestListener } from "@react-router/node";

let handler;

export default async function (req, res) {
  if (!handler) {
    const build = await import("./build/server/index.js");
    handler = createRequestListener({ build });
  }
  return handler(req, res);
}
