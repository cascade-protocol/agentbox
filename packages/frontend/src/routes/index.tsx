import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, AlertTriangle, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { api, type Instance } from "../lib/api";

export const Route = createFileRoute("/")({
  component: Home,
});

const statusStyles: Record<string, string> = {
  provisioning: "bg-blue-500/10 text-blue-600",
  running: "bg-green-500/10 text-green-600",
  stopped: "bg-gray-500/10 text-gray-500",
  error: "bg-red-500/10 text-red-600",
  deleting: "bg-amber-500/10 text-amber-600",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function isExpiringSoon(expiresAt: string) {
  return new Date(expiresAt).getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000;
}

function Home() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.instances
      .list()
      .then((data) => setInstances(data.instances))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const running = instances.filter((i) => i.status === "running").length;
  const expiring = instances.filter((i) => isExpiringSoon(i.expiresAt)).length;

  if (loading) {
    return (
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
        <p className="text-sm text-destructive">Error: {error}</p>
      </main>
    );
  }

  return (
    <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Instances</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your AgentBox instances</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{instances.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{running}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expiring Soon</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{expiring}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Instances</CardTitle>
          </CardHeader>
          <CardContent>
            {instances.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No instances yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="pb-3 pr-4 font-medium">Name</th>
                      <th className="pb-3 pr-4 font-medium">User</th>
                      <th className="pb-3 pr-4 font-medium">Status</th>
                      <th className="pb-3 pr-4 font-medium">IP</th>
                      <th className="pb-3 font-medium text-right">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((instance) => (
                      <tr key={instance.id} className="border-b last:border-0">
                        <td className="py-3 pr-4">
                          <Link
                            to="/instances/$id"
                            params={{ id: String(instance.id) }}
                            className="text-sm font-medium hover:underline"
                          >
                            {instance.name}
                          </Link>
                        </td>
                        <td className="py-3 pr-4 text-sm text-muted-foreground">
                          {instance.userId}
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[instance.status] ?? "bg-gray-500/10 text-gray-500"}`}
                          >
                            {instance.status}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-sm font-mono text-muted-foreground">
                          {instance.ip}
                        </td>
                        <td
                          className={`py-3 text-sm text-right ${isExpiringSoon(instance.expiresAt) ? "text-destructive font-medium" : "text-muted-foreground"}`}
                        >
                          {formatDate(instance.expiresAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
