import { useState } from "react";
import { api, ApiError, type Principal } from "../api.js";
import { Notice } from "../components.js";

export function Login({ onSignedIn }: { onSignedIn: (principal: Principal) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "bootstrap") {
        await api.bootstrap(name, email, password);
      }
      const { user } = await api.login(email, password);
      onSignedIn(user);
    } catch (err) {
      // A 409 on bootstrap means the platform already has an administrator.
      if (err instanceof ApiError && err.code === "already_initialised") {
        setMode("login");
        setError("The platform is already set up. Sign in instead.");
      } else {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centre">
      <div className="card">
        <h1>GDPC KYC Alignment</h1>
        <p className="muted small">
          Depositor-data alignment and audit for member institutions of the Ghana Deposit
          Protection Corporation.
        </p>

        {error ? <Notice kind="error">{error}</Notice> : null}

        <form onSubmit={submit}>
          {mode === "bootstrap" ? (
            <label>
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          ) : null}

          <label>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
              minLength={mode === "bootstrap" ? 12 : undefined}
              required
            />
          </label>

          <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Working…" : mode === "bootstrap" ? "Create administrator" : "Sign in"}
          </button>
        </form>

        <p className="small muted" style={{ marginTop: "1rem", marginBottom: 0 }}>
          {mode === "login" ? (
            <>
              Setting the platform up for the first time?{" "}
              <button className="ghost" onClick={() => setMode("bootstrap")}>
                Create the first administrator
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => setMode("login")}>
              Back to sign in
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
