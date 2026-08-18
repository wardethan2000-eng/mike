// Computing the meaning of a passage or a query as a vector, on our own machine.
//
// A small model (bge-small-en-v1.5, 384 dimensions) runs locally through
// onnxruntime, so no document text is ever sent outside for search. The model
// is loaded once, lazily, on first use; until the search feature is exercised
// it costs nothing. The files are baked into the image at build time (see the
// backend Dockerfile), so nothing is downloaded at run time. See
// docs/plans/01-search-across-a-matter.md for why this is local.

/** Dimensions of the fingerprint. Must match the migration's vector(384). */
export const EMBEDDING_DIM = 384;

// bge asks for a short instruction in front of a *query* — but not the passages
// — which measurably improves how well a query finds the right passage.
const QUERY_INSTRUCTION =
  "Represent this sentence for searching relevant passages: ";

type Tensor = { data: ArrayLike<number>; dims: number[] };
type Extractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<Tensor>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (
          task: string,
          model: string,
          opts?: Record<string, unknown>,
        ) => Promise<Extractor>;
        env: {
          cacheDir?: string;
          allowRemoteModels?: boolean;
          allowLocalModels?: boolean;
        };
      };
      if (process.env.TRANSFORMERS_CACHE) {
        mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
        // The model is baked into the image; do not reach the network at run
        // time. If it were somehow missing, embedding fails soft to word search.
        mod.env.allowLocalModels = true;
        mod.env.allowRemoteModels = false;
      }
      return mod.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
        dtype: "q8",
      });
    })().catch((err) => {
      // Reset so a later call can retry after a transient failure.
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rowToArray(t: Tensor, row: number): number[] {
  const width = t.dims[t.dims.length - 1];
  const start = row * width;
  const out = new Array<number>(width);
  for (let j = 0; j < width; j++) out[j] = Number(t.data[start + j]);
  return out;
}

/**
 * The fingerprints of several passages at once. Returns an array the same
 * length as the input; an entry is null for an empty passage. Returns all-null
 * if the model is unavailable, so indexing degrades to word search rather than
 * failing.
 */
export async function embedPassages(
  texts: string[],
): Promise<(number[] | null)[]> {
  const clean = texts.map(tidy);
  try {
    const extractor = await getExtractor();
    const out = await extractor(
      clean.map((c) => c || " "),
      { pooling: "mean", normalize: true },
    );
    return clean.map((c, i) => (c ? rowToArray(out, i) : null));
  } catch (err) {
    console.error("[embeddings] passage embedding failed:", err);
    return texts.map(() => null);
  }
}

/** The fingerprint of a search query, with the retrieval instruction. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const clean = tidy(text);
  if (!clean) return null;
  try {
    const extractor = await getExtractor();
    const out = await extractor(QUERY_INSTRUCTION + clean, {
      pooling: "mean",
      normalize: true,
    });
    return rowToArray(out, 0);
  } catch (err) {
    console.error("[embeddings] query embedding failed:", err);
    return null;
  }
}

/** A pgvector text literal, e.g. "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
