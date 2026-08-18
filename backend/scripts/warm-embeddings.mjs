// Downloads and caches the embedding model into the image at build time, so
// nothing is fetched from the network when the server runs. Fails the build if
// the model cannot be prepared, rather than shipping an image that would only
// discover the problem on the first search.
import { pipeline, env } from "@huggingface/transformers";

if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;

const started = Date.now();
await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
console.log(`embedding model cached in ${((Date.now() - started) / 1000).toFixed(1)}s`);
