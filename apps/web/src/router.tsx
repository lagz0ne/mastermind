import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	redirect,
	useRouterState,
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
import { ensureSession, isPublicPath } from "./session/session.ts";
import { NewWorkButton } from "./work/new-work-dialog.tsx";

/** Header nav link: full header height (a usable touch target), bold when active. */
const navLink =
	"flex items-center text-muted-foreground hover:text-foreground [&.active]:font-semibold [&.active]:text-foreground";

function Layout() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	// Logged-out pages (/login): the wordmark only.
	const bare = isPublicPath(pathname);
	return (
		<TooltipProvider>
			<div className="flex h-dvh flex-col">
				<header className="sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-4 border-b bg-background px-4">
					<Link to="/board" className="font-bold text-[13px] tracking-tight">
						mastermind
					</Link>
					{!bare && (
						<>
							<nav className="flex h-full min-w-0 items-stretch gap-3 overflow-x-auto whitespace-nowrap text-xs [scrollbar-width:none]">
								<Link to="/board" className={navLink}>
									Board
								</Link>
								<Link to="/people" className={navLink}>
									People
								</Link>
								<Link to="/activity" className={navLink}>
									Activity
								</Link>
								<Link to="/routing" className={navLink}>
									Routing
								</Link>
								<Link to="/environments" className={navLink}>
									Environments
								</Link>
							</nav>
							<div className="ml-auto flex shrink-0 items-center gap-3">
								<NewWorkButton />
								<AccountMenu />
							</div>
						</>
					)}
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
