import { useNavigate } from "@tanstack/react-router";
import { logout, useMe } from "./session.ts";

/** Top bar: who is logged in, and log out. Nothing without a session. */
export function AccountMenu() {
	const me = useMe();
	const navigate = useNavigate();
	if (!me) return null;
	return (
		<div className="flex items-center gap-3 text-xs">
			<span className="font-medium" title="Logged in as">
				{me.account}
			</span>
			{me.auth === "off" ? (
				<span className="text-[11px] text-signal">auth off</span>
			) : (
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground"
					onClick={() => void logout().then(() => navigate({ to: "/login" }))}
				>
					Log out
				</button>
			)}
		</div>
	);
}
