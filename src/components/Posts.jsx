import { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import {
  createPost,
  fetchPostsFeed,
  likePost,
  unlikePost,
  deletePost,
  displayUrl,
} from "../utils/postApi";

const PAGE_SIZE = 5;

// Phase 4 — the posts feed, and the upload form that proves the design.
//
// Cursor pagination (same shape as Chat.jsx, mirrored): the server returns
// { data, nextCursor, hasMore } and the client's stop condition is "the server
// said there is nothing after this" rather than "I got back fewer rows than I
// asked for" — which is an unreliable signal the moment any post-query filtering
// is added. This feed pages FORWARD into the past, appending, because posts are
// read newest-first.

const Posts = () => {
  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const [file, setFile] = useState(null);
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const user = useSelector((store) => store.user);

  const loadFirstPage = async () => {
    try {
      const page = await fetchPostsFeed(null, PAGE_SIZE);
      setPosts(page.data);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError("Could not load posts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFirstPage();
  }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPostsFeed(cursor, PAGE_SIZE);
      // Appended, so already-rendered posts are never re-fetched or re-ordered.
      setPosts((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError("Could not load more posts.");
    } finally {
      setLoadingMore(false);
    }
  };

  const handleUpload = async () => {
    if (!file || uploading) return;
    setError("");
    setUploading(true);
    setProgress(0);

    try {
      // The progress callback is reporting the browser's DIRECT upload to object
      // storage — our API is not in this data path at all.
      const post = await createPost(file, caption, setProgress);

      // Prepend rather than refetching. The new post is the newest, so it belongs
      // at the head, and refetching page 1 would discard every page the user has
      // already scrolled through.
      //
      // `post.thumbnailUrl` is null here — the worker has not run yet — so this
      // renders from the original via displayUrl(). Not a bug: it's the contract
      // that lets the upload return immediately. See pollForThumbnail below.
      setPosts((prev) => [post, ...prev]);
      setFile(null);
      setCaption("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      pollForThumbnail(post._id);
    } catch (err) {
      setError(
        err?.response?.data?.message || err.message || "Upload failed."
      );
    } finally {
      setUploading(false);
      setProgress(null);
    }
  };

  // Swap in the thumbnail once the background worker has produced it.
  //
  // Polling is the honest simple answer here, and it is bounded: a few attempts a
  // couple of seconds apart, then it gives up and leaves the original rendering
  // (which looks identical, just heavier). This is only cosmetic, so it must not
  // become a retry loop that hammers the API.
  //
  // The "proper" version is the server pushing a `postUpdated` event over the
  // socket connection this app already has from Phase 3 — the worker would emit
  // when it finishes. Not done here because it would mean giving the worker
  // process a Socket.io emitter and a room to publish into, which is real Phase 5
  // scope rather than a client change.
  const pollForThumbnail = (postId, attempt = 0) => {
    if (attempt >= 4) return;
    setTimeout(async () => {
      try {
        const page = await fetchPostsFeed(null, PAGE_SIZE);
        const fresh = page.data.find((p) => p._id === postId);
        if (fresh?.thumbnailUrl) {
          setPosts((prev) =>
            prev.map((p) => (p._id === postId ? { ...p, ...fresh } : p))
          );
          return;
        }
        pollForThumbnail(postId, attempt + 1);
      } catch {
        // Cosmetic only — the original image is already rendering.
      }
    }, 1500 * (attempt + 1));
  };

  // Optimistic toggle, reconciled with the server's authoritative count.
  //
  // Safe to be optimistic precisely BECAUSE both endpoints are idempotent: a
  // double-click can't corrupt anything, so the UI can act first and correct
  // itself from the response. The response carries the true likeCount, so a
  // count that drifted from an optimistic guess is repaired on the next
  // interaction rather than staying wrong.
  const toggleLike = async (post) => {
    const wasLiked = post.likedByMe;

    setPosts((prev) =>
      prev.map((p) =>
        p._id === post._id
          ? {
              ...p,
              likedByMe: !wasLiked,
              likeCount: p.likeCount + (wasLiked ? -1 : 1),
            }
          : p
      )
    );

    try {
      const result = wasLiked
        ? await unlikePost(post._id)
        : await likePost(post._id);
      setPosts((prev) =>
        prev.map((p) =>
          p._id === post._id
            ? { ...p, likedByMe: result.likedByMe, likeCount: result.likeCount }
            : p
        )
      );
    } catch {
      // Roll the optimistic change back.
      setPosts((prev) =>
        prev.map((p) =>
          p._id === post._id
            ? {
                ...p,
                likedByMe: wasLiked,
                likeCount: p.likeCount + (wasLiked ? 1 : -1),
              }
            : p
        )
      );
      setError("Could not update that like.");
    }
  };

  const handleDelete = async (postId) => {
    try {
      await deletePost(postId);
      setPosts((prev) => prev.filter((p) => p._id !== postId));
    } catch {
      setError("Could not delete that post.");
    }
  };

  if (loading) {
    return <h1 className="flex justify-center my-10">Loading posts…</h1>;
  }

  return (
    // pb-28 clears the app-wide footer, which is `fixed bottom-0` and therefore
    // paints over whatever is at the bottom of the page. That matters here more
    // than on other pages because this one ENDS in a button: without the padding,
    // "Load more posts" sits underneath the footer and the footer swallows the
    // click (elementFromPoint at the button's centre returns the footer). Found
    // by driving the real page in a browser — it looks fine in a screenshot,
    // because the button is visible; it just isn't clickable.
    //
    // Padding here rather than un-fixing the footer: the footer is shared by every
    // route, and changing its positioning is a global layout change that belongs
    // in its own commit, not in a posts feature branch.
    <div className="w-full max-w-xl mx-auto my-8 px-4 pb-28">
      {/* ---------------- Upload ---------------- */}
      <div className="card bg-base-300 shadow-xl mb-8">
        <div className="card-body">
          <h2 className="card-title">Share a post</h2>

          <input
            ref={fileInputRef}
            type="file"
            // The accept list matches the backend's allowlist exactly. A filter,
            // not a control — the backend pins the type into the signature and
            // re-checks it at claim time, because a file picker is trivially
            // bypassed.
            accept="image/jpeg,image/png,image/webp"
            className="file-input file-input-bordered w-full"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError("");
            }}
          />

          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Say something about it…"
            maxLength={2200}
            className="textarea textarea-bordered w-full mt-2"
          />

          {progress !== null && (
            <div className="mt-2">
              <progress
                className="progress progress-primary w-full"
                value={progress}
                max="100"
              />
              <p className="text-xs opacity-60 mt-1">
                {progress}% — uploading straight to object storage (this request
                does not go through the API)
              </p>
            </div>
          )}

          <div className="card-actions justify-end mt-2">
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="btn btn-primary"
            >
              {uploading ? "Uploading…" : "Post"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="alert alert-error mb-6">
          <span>{error}</span>
        </div>
      )}

      {/* ---------------- Feed ---------------- */}
      {posts.length === 0 ? (
        <p className="text-center opacity-60">
          No posts yet — from you or your connections.
        </p>
      ) : (
        posts.map((post) => (
          <div key={post._id} className="card bg-base-300 shadow-xl mb-6">
            <figure>
              <img
                // thumbnailUrl when the worker has run, the original until then.
                src={displayUrl(post)}
                alt={post.caption || "post"}
                className="w-full object-cover max-h-96"
              />
            </figure>
            <div className="card-body">
              <div className="flex items-center gap-3">
                {post.userId?.photoUrl && (
                  <div className="avatar w-10 rounded-full">
                    <img src={post.userId.photoUrl} alt="" />
                  </div>
                )}
                <div>
                  <p className="font-semibold">
                    {post.userId?.firstName} {post.userId?.lastName}
                  </p>
                  <p className="text-xs opacity-60">
                    {new Date(post.createdAt).toLocaleString()}
                    {!post.thumbnailUrl && " · thumbnail generating…"}
                  </p>
                </div>
              </div>

              {post.caption && <p className="mt-2">{post.caption}</p>}

              <div className="card-actions justify-between items-center mt-2">
                <button
                  onClick={() => toggleLike(post)}
                  className={
                    "btn btn-sm " +
                    (post.likedByMe ? "btn-secondary" : "btn-outline")
                  }
                >
                  {post.likedByMe ? "♥" : "♡"} {post.likeCount}
                </button>

                {post.userId?._id === user?._id && (
                  <button
                    onClick={() => handleDelete(post._id)}
                    className="btn btn-sm btn-ghost text-error"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))
      )}

      {hasMore && (
        <div className="flex justify-center my-6">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="btn btn-outline"
          >
            {loadingMore ? "Loading…" : "Load more posts"}
          </button>
        </div>
      )}
    </div>
  );
};

export default Posts;
