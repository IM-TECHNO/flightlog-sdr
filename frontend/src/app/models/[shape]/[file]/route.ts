import { liveryFor, liveryKey } from "@/lib/livery";
import { buildGltf, isShape } from "@/lib/planeModel";

// Models are generated on request (a few milliseconds) and cached by the browser, so there are no
// pre-built files: /models/<shape>/<AIRLINE>.gltf, e.g. /models/wide/KLM.gltf
const cache = new Map<string, string>();

export async function GET(_req: Request, { params }: { params: Promise<{ shape: string; file: string }> }) {
  const { shape, file } = await params;
  const code = file.replace(/\.gltf$/i, "");
  if (!isShape(shape) || !file.toLowerCase().endsWith(".gltf")) return new Response("not found", { status: 404 });
  const key = `${shape}/${liveryKey(code)}`;
  let body = cache.get(key);
  if (!body) {
    body = JSON.stringify(buildGltf(shape, liveryFor(code)));
    cache.set(key, body);
  }
  return new Response(body, {
    headers: { "Content-Type": "model/gltf+json", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
