// Test helper: a throwaway nats-server with WebSocket and JetStream on free
// ports (see @mastermind/work/test).
import { startNatsServer, type TestNats } from "@mastermind/work/test";

export type NatsServer = TestNats;

export function startNats(path: string): Promise<NatsServer> {
	return startNatsServer(path, { prefix: "mm-dispatch-nats-" });
}
