// The work contract on the fake (always) and on the NATS store (when a
// nats-server is available: NATS_TEST_URL, NATS_SERVER or nats-server on PATH).
import { afterAll, beforeAll, describe } from "bun:test";
import { connect } from "@mastermind/bus";
import { NatsWork } from "@mastermind/work";
import { natsAvailable, type TestNats, testNats } from "@mastermind/work/test";
import type { NatsConnection } from "@nats-io/nats-core";
import { fakeWork, LEASE_MS } from "../dispatch/fake-work.ts";
import { workContract } from "./contract.ts";
import { natsWork } from "./nats-work.ts";

workContract(
	"fake",
	async (c) => {
		const work = fakeWork(c.now);
		let n = 0;
		return {
			work,
			add: async (input) => work.add({ id: `mm-f${n++}`, ...input }),
			stop() {},
		};
	},
	// The fake lets anyone release; NATS and bd serve check the holder.
	{ leaseMs: LEASE_MS, releaseChecksHolder: false },
);

describe.skipIf(!natsAvailable())("on nats-server", () => {
	let nats: TestNats;
	let nc: NatsConnection;
	const run = Date.now().toString(36);
	let n = 0;
	beforeAll(async () => {
		nats = await testNats();
		nc = await connect({ servers: nats.url, name: "work-contract" });
	});
	afterAll(async () => {
		await nc?.drain();
		nats?.stop();
	});

	workContract(
		"nats",
		async (c) => {
			const k = `${run}${n++}`;
			const store = await NatsWork.open(nc, {
				stream: `C_WORK_${k}`,
				subject: `c.work.${k}`,
				leaseBucket: `c_leases_${k}`,
				now: c.now,
			});
			return {
				work: natsWork(store),
				add: (input) => store.create("ann", input),
				stop: () => store.stop(),
			};
		},
		{ leaseMs: LEASE_MS },
	);
});
