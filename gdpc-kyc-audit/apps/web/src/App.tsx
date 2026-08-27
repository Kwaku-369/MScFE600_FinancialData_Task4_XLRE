import { useEffect, useState } from "react";
import { api, type Principal } from "./api.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Upload } from "./pages/Upload.js";
import { BatchDetail } from "./pages/BatchDetail.js";
import { Codes } from "./pages/Codes.js";

type View =
  | { name: "dashboard" }
  | { name: "upload" }
  | { name: "batch"; id: string }
  | { name: "codes" };

export function App() {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>({ name: "dashboard" });

  useEffect(() => {
    void (async () => {
      try {
        const { principal: current } = await api.me();
        setPrincipal(current);
      } catch {
        setPrincipal(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) return <main><p>Loading…</p></main>;

  if (!principal) {
    return <Login onSignedIn={(p) => setPrincipal(p)} />;
  }

  async function signOut() {
    await api.logout().catch(() => undefined);
    setPrincipal(null);
    setView({ name: "dashboard" });
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">GDPC KYC Alignment &amp; Audit</span>
        <nav>
          <button
            onClick={() => setView({ name: "dashboard" })}
            aria-current={view.name === "dashboard" ? "page" : undefined}
          >
            Submissions
          </button>
          <button
            onClick={() => setView({ name: "upload" })}
            aria-current={view.name === "upload" ? "page" : undefined}
          >
            New submission
          </button>
          <button
            onClick={() => setView({ name: "codes" })}
            aria-current={view.name === "codes" ? "page" : undefined}
          >
            Exception catalogue
          </button>
        </nav>
        <span className="spacer" />
        <span className="who">
          {principal.name} · {principal.role.replace(/_/g, " ")}
        </span>
        <button onClick={signOut}>Sign out</button>
      </header>

      <main>
        {view.name === "dashboard" ? (
          <Dashboard onOpenBatch={(id) => setView({ name: "batch", id })} />
        ) : null}
        {view.name === "upload" ? (
          <Upload onOpenBatch={(id) => setView({ name: "batch", id })} />
        ) : null}
        {view.name === "batch" ? (
          <BatchDetail batchId={view.id} onBack={() => setView({ name: "dashboard" })} />
        ) : null}
        {view.name === "codes" ? <Codes /> : null}
      </main>
    </div>
  );
}
