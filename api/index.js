import { createRequestListener } from "@react-router/node";
import * as build from "../build/server/index.js";

const requestListener = createRequestListener({
  build,
  mode: "production",
});

export default function handler(request, response) {
  return requestListener(request, response);
}