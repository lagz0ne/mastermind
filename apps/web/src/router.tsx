import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { ActivityPage } from "./activity/activity-page.tsx";
import { BeadSheet } from "./board/bead-sheet.tsx";
import { BoardPage } from "./board/board-page.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { EnvironmentsPage } from "./environments/environments-page.tsx";
import { HealthFooter } from "./health-footer.tsx";
import { LoginPage } from "./login/login-page.tsx";
import { PeoplePage } from "./people/people-page.tsx";
import { RoutingPage } from "./routing/routing-page.tsx";
import { AccountMenu } from "./session/account-menu.tsx";
import { ensureSession } from "./session/session.ts";
import { NewWorkButton } from "./work/new-work-dialog.tsx";

function Layout() {
	return (
		<TooltipProvider>
			<div className="flex h-dvh flex-col">
				<header className="flex items-baseline gap-4 border-b px-4 py-2">
					<Link to="/board" className="font-bold text-base tracking-tight">
						mastermind
					</Link>
					<nav className="text-sm">
						<Link
							to="/board"
							className="text-muted-foreground [&.active]:font-semibold [&.active]:text-foreground"
						>
							Board
						</Link>
						<Link
							to="/people"
							className="ml-3 text-muted-foreground [&.active]:font-semibold [&.active]:text-foreground"
						>
							People
						</Link>
						<Link
							to="/activity"
							className="ml-3 text-muted-foreground [&.active]:font-semibold [&.active]:text-foreground"
						>
							Activity
						</Link>
						<Link
							to="/routing"
							className="ml-3 text-muted-foreground [&.active]:font-semibold [&.active]:text-foreground"
						>
							Routing
						</Link>
						<Link
							to="/environments"
							className="ml-3 text-muted-foreground [&.active]:font-semibold [&.active]:text-foreground"
						>
							Environments
						</Link>
					</nav>
					<NewWorkButton />
					<AccountMenu />
				</header>
				<main className="min-h-0 flex-1">
					<Outlet />
				</main>
				<HealthFooter />
			</div>
		</TooltipProvider>
	);
}

function NotFound() {
	return (
		<div className="px-4 py-6">
			<h1 className="font-bold text-lg">Not found</h1>
			<p className="text-muted-foreground text-sm">
				Nothing lives at this address.{" "}
				<Link to="/board" className="underline">
					Go to the board
				</Link>
			</p>
		</div>
	);
}

const rootRoute = createRootRoute({
	component: Layout,
	notFoundComponent: NotFound,
	// No session: go to /login (GET /api/people/me says 401).
	beforeLoad: async ({ location }) => {
		if ((await ensureSession(location.pathname)) === "login")
			throw redirect({ to: "/login" });
	},
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: () => {
		throw redirect({ to: "/board" });
	},
});

const boardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/board",
	component: BoardPage,
});

const beadRoute = createRoute({
	getParentRoute: () => boardRoute,
	path: "$beadId",
	component: BeadSheet,
});

const peopleRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/people",
	component: PeoplePage,
});

const activityRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/activity",
	component: ActivityPage,
});

const routingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/routing",
	component: RoutingPage,
});

const environmentsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/environments",
	component: EnvironmentsPage,
});

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	component: LoginPage,
});

export const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	peopleRoute,
	activityRoute,
	routingRoute,
	environmentsRoute,
	boardRoute.addChildren([beadRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
