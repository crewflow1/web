"use client";

import dynamic from "next/dynamic";
import type { WorkflowCanvasProps } from "./WorkflowCanvas";

/**
 * Client-only loader for the visual workflow canvas.
 *
 * The canvas (WorkflowCanvas) is a heavy interactive client component — a full
 * SVG/DOM node-graph editor that also pulls in the condition/action/graph modules
 * and the form-builder fallback. Static-importing it into the (server) editor page
 * would bundle it into that route's SSR + initial chunk and compile it as part of
 * the route, inflating build memory. Here it is `next/dynamic({ ssr: false })`, so
 * it is code-split into its own async chunk, loaded ONLY in the browser when the
 * editor page mounts — never under SSR, never in the shared/initial bundle. Same
 * idiom as the blueprint viewer/compare launchers.
 */
const WorkflowCanvas = dynamic(
  () => import("./WorkflowCanvas").then((m) => m.WorkflowCanvas),
  {
    ssr: false,
    loading: () => (
      <div
        className="grid h-[440px] place-items-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500"
        aria-live="polite"
      >
        Loading the workflow canvas…
      </div>
    ),
  },
);

export function WorkflowCanvasLoader(props: WorkflowCanvasProps) {
  return <WorkflowCanvas {...props} />;
}
