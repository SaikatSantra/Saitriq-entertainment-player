// Vercel serverless function — React Router v7
import { createRequestListener } from "@react-router/node";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let requestListener;

async function getListener() {
  if (!requestListener) {
    // Dynamic import resolves after build
    const build = await import(path.join(rootDir, "build/server/index.js"));
    requestListener = createRequestListener({ build });
  }
  return requestListener;
}

export default async function handler(req, res) {
  const listener = await getListener();
  return listener(req, res);
}
