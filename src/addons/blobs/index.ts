/** Addon blobs : compter des objets dans une image (seuillage adaptatif, composantes, séparation des objets collés). */
export { SonicBlobs, type BlobsState, type BlobItem } from "./blobs";
export { detectBlobs, toOverlaySvg, MAX_PIXELS, type BlobOptions, type BlobResult, type Blob, type Polarity } from "./detect";
