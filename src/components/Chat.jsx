import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { createSocketConnection } from "../utils/socket";
import { useSelector } from "react-redux";
import axios from "axios";
import { BASE_URL } from "../utils/constants";

const PAGE_SIZE = 50;

const Chat = () => {
  const { targetUserId } = useParams();
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const user = useSelector((store) => store.user);
  const userId = user?._id;

  // One socket for the lifetime of the page. The previous version called
  // createSocketConnection() again inside sendMessage, opening a brand new
  // connection per message — which now also means a JWT verify and a user lookup
  // per message on the server, and a socket that never joined the room.
  const socketRef = useRef(null);

  // Scroll-to-newest. Keyed on the id of the LAST message rather than on the
  // array, so appending a new message scrolls to it but PREPENDING older ones
  // ("Load older messages") deliberately does not — yanking the viewport to the
  // bottom is the opposite of what someone scrolling back through history wants.
  const bottomRef = useRef(null);
  const lastSeenIdRef = useRef(null);

  // Updated to the Phase 3 response shape: { chatId, data, nextCursor, hasMore }
  // instead of the whole chat document with an embedded messages array. `data` is
  // one page, oldest-first, so it renders top-to-bottom as-is.
  const fetchPage = async (before) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) params.set("before", before);

    const res = await axios.get(
      `${BASE_URL}/chat/${targetUserId}?${params.toString()}`,
      { withCredentials: true }
    );

    return res.data;
  };

  const toView = (msg) => ({
    _id: msg._id,
    firstName: msg.senderId?.firstName,
    lastName: msg.senderId?.lastName,
    text: msg.text,
    createdAt: msg.createdAt,
  });

  useEffect(() => {
    let cancelled = false;

    const loadFirstPage = async () => {
      try {
        const page = await fetchPage();
        if (cancelled) return;
        setMessages(page.data.map(toView));
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (err) {
        if (!cancelled) {
          setError(
            err?.response?.status === 403
              ? "You can only chat with your connections."
              : "Could not load this conversation."
          );
        }
      }
    };

    loadFirstPage();
    return () => {
      cancelled = true;
    };
  }, [targetUserId]);

  // Scroll-back through history, one cursor page at a time. Older messages are
  // prepended, so the existing list never has to be re-fetched or re-ordered.
  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(cursor);
      setMessages((prev) => [...page.data.map(toView), ...prev]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError("Could not load older messages.");
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    const lastId = messages[messages.length - 1]?._id;
    if (lastId && lastId !== lastSeenIdRef.current) {
      lastSeenIdRef.current = lastId;
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  useEffect(() => {
    if (!userId) return;

    const socket = createSocketConnection();
    socketRef.current = socket;

    // The server takes the sender's identity from the authenticated session, so
    // firstName / userId are no longer sent — only which conversation to open.
    socket.emit("joinChat", { targetUserId });

    socket.on("messageReceived", (msg) => {
      setMessages((prev) =>
        // The sender receives its own message back through the room. De-duplicate
        // on the server-assigned _id, which the payload now carries.
        prev.some((m) => m._id === msg._id) ? prev : [...prev, msg]
      );
    });

    socket.on("chatError", ({ message }) => setError(message));
    socket.on("connect_error", () =>
      setError("Could not connect to chat. Try logging in again.")
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [userId, targetUserId]);

  const sendMessage = () => {
    const text = newMessage.trim();
    if (!text || !socketRef.current) return;

    setError("");
    socketRef.current.emit("sendMessage", { targetUserId, text });
    setNewMessage("");
  };

  return (
    <div className="w-3/4 mx-auto border border-gray-600 m-5 h-[70vh] flex flex-col">
      <h1 className="p-5 border-b border-gray-600">Chat</h1>

      <div className="flex-1 overflow-scroll p-5">
        {hasMore && (
          <div className="flex justify-center mb-4">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="btn btn-sm btn-outline"
            >
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg._id}
            className={
              "chat " +
              (user.firstName === msg.firstName ? "chat-end" : "chat-start")
            }
          >
            <div className="chat-header">
              {`${msg.firstName}  ${msg.lastName}`}
              <time className="text-xs opacity-50">
                {" "}
                {msg.createdAt ? new Date(msg.createdAt).toLocaleString() : ""}
              </time>
            </div>
            <div className="chat-bubble">{msg.text}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="px-5 py-2 text-sm text-red-400 border-t border-gray-600">
          {error}
        </div>
      )}

      <div className="p-5 border-t border-gray-600 flex items-center gap-2">
        <input
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          className="flex-1 border border-gray-500 text-white rounded p-2"
        ></input>
        <button onClick={sendMessage} className="btn btn-secondary">
          Send
        </button>
      </div>
    </div>
  );
};
export default Chat;
