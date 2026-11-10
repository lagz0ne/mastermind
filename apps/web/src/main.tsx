import { startBrowserTelemetry } from "@mastermind/telemetry/browser";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { router } from "./router.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
// Web vitals, errors and route timings, posted to /api/telemetry.
startBrowserTelemetry().trackRouter(router);
createRoot(root).render(<RouterProvider router={router} />);
