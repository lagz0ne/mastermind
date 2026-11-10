import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { BeadSheet } from "./board/bead-sheet.tsx";
import { BoardPage } from "./board/board-page.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { HealthFooter } from "./health-footer.tsx";

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
					</nav>
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

export const routeTree = rootRoute.addChildren([
	indexRoute,
	boardRoute.addChildren([beadRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
