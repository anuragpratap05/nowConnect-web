import axios from "axios";
import { BASE_URL } from "./constants";

// Phase 4 — the three-step upload, on the client side.
//
// The whole point of this file is step 2: the image bytes go from the browser
// STRAIGHT to object storage. They never touch our API. Everything else here
// exists to make that one PUT possible and safe.
//
//   1. POST /posts/upload-url  -> { key, url, expiresIn, maxBytes }
//   2. PUT  <url>  <the File>  -> the browser uploads directly to S3/MinIO
//   3. POST /posts { imageKey, caption }  -> the post row
//
// Read the backend's src/utils/postStorage.js for why the flow is shaped like
// this. What matters on this side is the three things that are easy to get wrong.

// A bare axios instance for the object store, deliberately NOT the app's axios.
//
// This is the subtle one. Every other request in this app sends
// `withCredentials: true` so the JWT cookie rides along. Sending credentials to
// the object store would be wrong twice over:
//
//   1. It leaks our session cookie to a different origin — a third-party service
//      in production. The cookie has nothing to do with this request: the
//      presigned URL carries its own authorization in the query string, which is
//      the entire reason it exists.
//   2. It breaks the request. A cross-origin request with credentials requires
//      the responding server to echo an explicit origin AND
//      `Access-Control-Allow-Credentials: true`. S3 and MinIO answer CORS
//      preflights with a wildcard origin, and the browser refuses a wildcard on a
//      credentialed request — so the upload fails in CORS, before it is sent.
//
// A separate client makes "no credentials here" structural rather than something
// each call site has to remember not to pass.
const storageClient = axios.create();

const api = axios.create({ baseURL: BASE_URL, withCredentials: true });

// Ask the API to mint a presigned PUT URL for this exact content type.
const requestUploadUrl = (contentType) =>
  api.post("/posts/upload-url", { contentType }).then((res) => res.data);

// Step 2. The `Content-Type` header MUST be byte-identical to the contentType
// sent in step 1, because the backend signs that header into the signature
// (`X-Amz-SignedHeaders=content-type;host`). A mismatch is not a warning — the
// object store rejects it with 403 SignatureDoesNotMatch.
//
// This is why the type is read from `file.type` once and threaded through both
// calls, rather than being inferred separately in each place.
const uploadToStorage = (url, file, contentType, onProgress) =>
  storageClient.put(url, file, {
    headers: { "Content-Type": contentType },
    // Real progress, because this is the request that actually carries the
    // bytes. With a proxy-through-the-API design the browser would report the
    // upload as instantly complete and then sit waiting on a response while the
    // server did the slow half — so the honest progress bar is a side benefit of
    // uploading direct.
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(Math.round((event.loaded * 100) / event.total));
      }
    },
  });

// Step 3 — the claim. Idempotent on the backend (imageKey is uniquely indexed),
// so retrying this after a dropped response returns the existing post rather
// than creating a second one for the same image.
const claimPost = (imageKey, caption) =>
  api.post("/posts", { imageKey, caption }).then((res) => res.data.data);

// The whole flow, as one call.
export const createPost = async (file, caption, onProgress) => {
  const contentType = file.type;

  const { url, key, maxBytes } = await requestUploadUrl(contentType);

  // Client-side size check, using the limit the SERVER just told us rather than
  // a number hardcoded here — so the two can never disagree after a change.
  //
  // This is a UX affordance, NOT a security control, and the distinction is
  // worth being clear about: it exists so the user is told immediately instead of
  // spending 30 seconds of mobile uplink on an upload that step 3 will refuse.
  // The enforcing check is the backend's HeadObject at claim time, because
  // anything the client checks, a client can skip.
  if (maxBytes && file.size > maxBytes) {
    throw new Error(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${(
        maxBytes /
        1024 /
        1024
      ).toFixed(0)}MB.`
    );
  }

  await uploadToStorage(url, file, contentType, onProgress);

  return claimPost(key, caption);
};

export const fetchPostsFeed = (cursor, limit = 5) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return api.get(`/posts/feed?${params.toString()}`).then((res) => res.data);
};

// Like and unlike are separate verbs on the same path, and both are idempotent
// server-side — so the client never has to know the current state to act. It can
// just say what it wants to be true.
export const likePost = (postId) =>
  api.post(`/posts/${postId}/like`).then((res) => res.data.data);

export const unlikePost = (postId) =>
  api.delete(`/posts/${postId}/like`).then((res) => res.data.data);

export const deletePost = (postId) =>
  api.delete(`/posts/${postId}`).then((res) => res.data);

// The thumbnail contract, in one place.
//
// `thumbnailUrl` is null until the background worker has resized the image,
// which is a state every freshly-created post passes through. This fallback is
// what makes that invisible to the user instead of a broken image — and it is
// the reason the backend can treat thumbnailing as an optimisation rather than a
// step the upload has to wait for.
export const displayUrl = (post) => post.thumbnailUrl ?? post.imageUrl;
