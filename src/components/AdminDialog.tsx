import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import "./Dialog.css";

type AdminDialogProps = {
  eventModeEnabled: boolean;
  onClose: () => void;
  onChanged: (enabled: boolean) => void;
};

export function AdminDialog({ eventModeEnabled, onClose, onChanged }: AdminDialogProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => passwordInput.current?.focus(), []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const enabled = await invoke<boolean>("toggle_event_mode", { password });
      onChanged(enabled);
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="exit-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-dialog-title"
      >
        <p className="eyebrow">ADMINISTRAÇÃO</p>
        <h2 id="admin-dialog-title">Autorização necessária</h2>
        <p>Digite a senha para {eventModeEnabled ? "desativar" : "ativar"} o modo evento.</p>
        <label htmlFor="admin-password">Senha de autorização</label>
        <div className="password-field">
          <input
            ref={passwordInput}
            id="admin-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowPassword((current) => !current)}
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            aria-pressed={showPassword}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.7" />
              {showPassword && <path d="m4 4 16 16" />}
            </svg>
          </button>
        </div>
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="cancel-action" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="confirm-action">
            {eventModeEnabled ? "Desativar modo evento" : "Ativar modo evento"}
          </button>
        </div>
      </form>
    </div>
  );
}
