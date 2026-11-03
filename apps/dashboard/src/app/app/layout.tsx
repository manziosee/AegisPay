import { WorkspaceGuard } from "@/components/providers/workspace-guard";
import { WorkspaceDataProvider } from "@/components/providers/workspace-data-provider";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceGuard>
      <WorkspaceDataProvider>
        <WorkspaceShell>{children}</WorkspaceShell>
      </WorkspaceDataProvider>
    </WorkspaceGuard>
  );
}
