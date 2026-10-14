import { mergeConfig } from "vite";
import showcase from "./vite.config.ts";

// A timing run takes half a minute, and an edit anywhere in the tree would reload the page under it.
export default mergeConfig(showcase, { server: { hmr: false, watch: null } });
