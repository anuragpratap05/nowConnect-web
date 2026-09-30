import io from "socket.io-client";
import { BASE_URL } from "./constants";

export const createSocketConnection = () => {
  // withCredentials is required as of the Phase 3 backend change: the server
  // authenticates the socket from the same `token` cookie the REST API uses
  // (src/utils/socket.js, io.use(authenticateSocket)) and rejects the handshake
  // outright without it. The browser will not attach cookies to a cross-origin
  // WebSocket handshake unless this is set.
  if (location.hostname === "localhost") {
    return io(BASE_URL, { withCredentials: true });
  } else {
    return io("/", { path: "/api/socket.io", withCredentials: true });
  }
};
