// Vercel serverless entry point for React Router v7 (Node adapter)
import { createRequestListener } from "@react-router/node";
import * as build from "../build/server/index.js";

const handler = createRequestListener({ build });

export default async function (req, res) {
  await handler(req, res);
}
