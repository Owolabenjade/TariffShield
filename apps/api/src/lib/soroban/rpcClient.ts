import http from "node:http";
import https from "node:https";
import { rpc } from "@stellar/stellar-sdk";
import { registerSorobanLogger } from "./logger.js";

// #249 — the SDK's HttpClient abstraction has no per-server agent option
// (it also targets browsers, which have no concept of a Node http.Agent),
// so keep-alive is enabled process-wide by replacing Node's global agents
// with keep-alive-enabled ones. `keepAlive` can only be set at Agent
// construction time (it isn't a mutable property), so the default agents
// are swapped out rather than mutated. This is safe here since
// createRpcServer is the only place in the app that talks to the Soroban
// RPC endpoint over HTTP(S).
http.globalAgent = new http.Agent({ keepAlive: true });
https.globalAgent = new https.Agent({ keepAlive: true });

export function createRpcServer(url: string, opts?: rpc.Server.Options): rpc.Server {
  const server = new rpc.Server(url, {
    allowHttp: url.startsWith("http://"),
    ...opts,
  });
  registerSorobanLogger(server);
  return server;
}
