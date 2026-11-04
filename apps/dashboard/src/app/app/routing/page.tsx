import { redirect } from "next/navigation";

// The browser-only routing preview was replaced by server-side risk rules.
export default function RoutingRedirect() {
  redirect("/app/risk-rules");
}
