/**
 * Enforcement of the routing document at the dispatcher:
 *
 * - {@link admit}: may `account` take work from `queue`? Not a member is the
 *   typed bus error `not_a_member`.
 * - {@link reroute}: after the rules or queues change, put every open bead that
 *   has no queue on the queue its first matching rule names.
 *
 * Before anybody saves routing (KV revision 0), queues are open: every account
 * may take work from every queue. The first save closes them to their members.
 */
import { BusError } from "@mastermind/bus";
import { type Bead, queueLabel, queueOf } from "@mastermind/core";
import { route } from "@mastermind/router";
import { queueNamed, type RoutingState } from "./model.ts";

export async function admit(
	state: RoutingState | null,
	account: string,
	queue: string,
	/** Beads that hold a claim now (for maxPerAccount). */
	claimed: () => Promise<Bead[]>,
): Promise<void> {
	if (!state || state.revision === 0) return;
	const q = queueNamed(state.doc, queue);
	if (!q) throw new BusError("not_a_member", `there is no queue ${queue}`);
	if (!q.members.includes(account))
		throw new BusError(
			"not_a_member",
			`account ${account} is not a member of queue ${queue}`,
		);
	if (q.maxPerAccount === undefined) return;
	const prefix = `${account}/`;
	const held = (await claimed()).filter(
		(b) => b.assignee?.startsWith(prefix) && queueOf(b) === queue,
	).length;
	if (held >= q.maxPerAccount)
		throw new BusError(
			"conflict",
			`account ${account} holds ${held} of at most ${q.maxPerAccount} beads of queue ${queue}`,
		);
}

/** The bead writes that rerouting needs. */
export type RerouteWork = {
	/** Open beads that have no queue label. */
	unrouted(): Promise<Bead[]>;
	setLabels(id: string, actor: string, labels: string[]): Promise<Bead>;
};

/** Route every open, unrouted bead by the current rules. Returns the ids moved. */
export async function reroute(
	work: RerouteWork,
	state: RoutingState,
	actor: string,
	onError?: (error: unknown) => void,
): Promise<string[]> {
	const moved: string[] = [];
	for (const bead of await work.unrouted()) {
		if (bead.status !== "open" || queueOf(bead)) continue;
		const target = route(bead, state.doc.rules);
		if (!target) continue;
		try {
			await work.setLabels(bead.id, actor, [
				...bead.labels,
				queueLabel(target),
			]);
			moved.push(bead.id);
		} catch (error) {
			onError?.(error);
		}
	}
	return moved;
}
