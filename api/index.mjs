// Vercel serverless entry point for React Router v7
import { createRequestListener } from "@react-router/node";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let handler;

async function getHandler() {
  if (!handler) {
    const build = await import(join(__dirname, "../build/server/index.js"));
    handler = createRequestListener({ build });
  }
  return handler;
}

export default async function (req, res) {
  const h = await getHandler();
  await h(req, res);
}
