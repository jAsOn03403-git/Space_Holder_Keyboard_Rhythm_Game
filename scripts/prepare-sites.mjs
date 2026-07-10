import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(root, "dist", "server");
const hostingSource = resolve(root, ".openai", "hosting.json");
const hostingTarget = resolve(root, "dist", ".openai", "hosting.json");

const workerSource = `const worker = {
  async fetch(request, env) {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response("Static asset binding is unavailable.", { status: 500 });
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") {
      return response;
    }

    const url = new URL(request.url);
    if (url.pathname.includes(".")) {
      return response;
    }

    url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, { headers: request.headers }));
  },
};

export default worker;
`;

await mkdir(serverDir, { recursive: true });
await writeFile(resolve(serverDir, "index.js"), workerSource, "utf8");

try {
  await readFile(hostingSource);
  await mkdir(dirname(hostingTarget), { recursive: true });
  await copyFile(hostingSource, hostingTarget);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
