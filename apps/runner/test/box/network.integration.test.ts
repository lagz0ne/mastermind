/**
 * The network allow list on a real engine. Runs only with MM_BOX_DOCKER_HOST
 * (see docker.integration.test.ts), for example rootless Podman:
 *
 *   podman system service --time=0 unix://$XDG_RUNTIME_DIR/mm-box.sock &
 *   MM_BOX_DOCKER_HOST=unix://$XDG_RUNTIME_DIR/mm-box.sock bun test test/box/network.integration
 *
 * MM_BOX_TEST_IMAGE: an image with git and node or bun (default: Paseo's).
 * Needs network to reach github.com.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { DockerDriver } from "../../src/box/docker.ts";
import { BOX_LABEL } from "../../src/box/driver.ts";
import { sweepBoxes } from "../../src/box/run.ts";

const host = process.env.MM_BOX_DOCKER_HOST;
const image = process.env.MM_BOX_TEST_IMAGE ?? "ghcr.io/getpaseo/paseo:0.15.4";
const runnerId = `it-net-${process.pid}`;
const driver = new DockerDriver({ env: { DOCKER_HOST: host } });
const labels = (n: string) => ({
	[BOX_LABEL.runner]: runnerId,
	[BOX_LABEL.item]: "mm-it",
	[BOX_LABEL.execution]: n,
});

async function networkExists(name: string): Promise<boolean> {
	const res = await driver.request("GET", `/networks/${name}`, {
		ok404: true,
	});
	return res.status !== 404;
}

afterAll(async () => {
	if (host) await sweepBoxes(driver, runnerId).catch(() => {});
});

describe.skipIf(!host)("network allow list on a real engine", () => {
	test("allow [github.com]: clone works, example.com and a direct connection do not; destroy deletes box, proxy and network", async () => {
		const img = await driver.ensureImage({ image });
		const name = `mm-box-it-net-${Date.now()}`;
		const box = await driver.create({
			image: img,
			name,
			labels: labels(name),
			network: { allow: ["github.com"] },
			cmd: ["sleep", "infinity"],
		});
		try {
			const sh = (c: string) =>
				box.exec(["sh", "-c", c], { workdir: "/tmp", user: "root" });
			const clone = await sh(
				"git clone --depth 1 https://github.com/octocat/Hello-World.git hw && test -f hw/README",
			);
			expect(clone.stderr + clone.stdout).not.toContain("fatal");
			expect(clone.code).toBe(0);
			const other = await sh("git ls-remote https://example.com/x.git");
			expect(other.code).not.toBe(0);
			expect(other.stderr).toMatch(/403|CONNECT/);
			// Without the proxy there is no way out at all.
			const direct = await sh(
				"env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy timeout 15 git ls-remote https://github.com/octocat/Hello-World.git",
			);
			expect(direct.code).not.toBe(0);
			expect(await networkExists(`${name}-net`)).toBe(true);
		} finally {
			await box.destroy();
		}
		expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
		expect(await networkExists(`${name}-net`)).toBe(false);
	}, 600_000);

	test("the sweep after a crash deletes the box, its proxy and its network", async () => {
		const name = `mm-box-it-net-sweep-${Date.now()}`;
		await driver.create({
			image: await driver.ensureImage({ image }),
			name,
			labels: labels(name),
			network: { allow: ["github.com"] },
			cmd: ["sleep", "infinity"],
		});
		const left = await driver.list({ [BOX_LABEL.runner]: runnerId });
		expect(left.map((b) => b.name).sort()).toEqual([name, `${name}-proxy`]);
		await sweepBoxes(driver, runnerId);
		expect(await driver.list({ [BOX_LABEL.runner]: runnerId })).toEqual([]);
		expect(await networkExists(`${name}-net`)).toBe(false);
	}, 600_000);
});
