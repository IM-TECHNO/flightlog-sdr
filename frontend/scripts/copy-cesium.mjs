// Copies Cesium's runtime assets (workers, widgets CSS assets, etc.) into public/cesium.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const src = new URL("../node_modules/cesium/Build/Cesium/", import.meta.url);
const dst = new URL("../public/cesium/", import.meta.url);
if (!existsSync(src)) throw new Error("cesium is not installed; run npm install");
mkdirSync(dst, { recursive: true });
for (const dir of ["Workers", "ThirdParty", "Assets", "Widgets"]) cpSync(new URL(dir, src), new URL(dir, dst), { recursive: true });
console.log("copied Cesium assets to public/cesium");
