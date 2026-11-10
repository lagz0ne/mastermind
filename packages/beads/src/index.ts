/**
 * Beads (bd) as a data source for Mastermind.
 *
 * - Writes go through `bd serve` ({@link BdClient}) so that claims, leases and
 *   the events journal stay correct.
 * - Reads go straight to Dolt over the MySQL protocol ({@link DoltReader}).
 * - {@link tailJournal} turns the events journal into a live feed.
 */
export * from "./client.ts";
export * from "./dolt.ts";
export * from "./errors.ts";
export * from "./tail.ts";
export * from "./wire.ts";
