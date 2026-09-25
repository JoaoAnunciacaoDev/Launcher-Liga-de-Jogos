import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { CatalogPlatform, LocalGame } from "../catalogTypes";
import "./Dialog.css";
import "./LocalGameDialog.css";

type LocalGameDialogProps = {
  game?: LocalGame;
  platform: CatalogPlatform;
  onClose: () => void;
  onRemoved: (id: string) => void;
  onSaved: (game: LocalGame) => void;
};

export function LocalGameDialog({
  game,
  platform,
  onClose,
  onRemoved,
  onSaved,
}: LocalGameDialogProps) {
  const [title, setTitle] = useState(game?.title ?? "");
  const [summary, setSummary] = useState(game?.summary ?? "");
  const [accent, setAccent] = useState(game?.accent ?? "#f6a43a");
  const [executablePath, setExecutablePath] = useState(game?.executablePath ?? "");
  const [coverPath, setCoverPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);

  useEffect(() => titleInput.current?.focus(), []);

  async function chooseExecutable() {
    const extension = platform === "windows" ? "exe" : "x86_64";
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: platform === "windows" ? "Executável Windows" : "Executável Linux",
          extensions: [extension],
        },
      ],
    });
    if (typeof selected === "string") setExecutablePath(selected);
  }

  async function chooseCover() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Imagem", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof selected === "string") setCoverPath(selected);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await invoke<LocalGame>("save_local_game", {
        password,
        id: game?.id ?? null,
        title,
        summary,
        accent,
        executablePath,
        coverPath: coverPath || null,
      });
      onSaved(saved);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!game) return;
    setBusy(true);
    setError("");
    try {
      await invoke("remove_local_game", { password, id: game.id });
      onRemoved(game.id);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="exit-dialog local-game-dialog"
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-game-dialog-title"
      >
        <p className="eyebrow">BIBLIOTECA LOCAL</p>
        <h2 id="local-game-dialog-title">{game ? "Editar jogo local" : "Adicionar jogo local"}</h2>
        <p>
          O launcher apenas cria um vínculo. Remover este cadastro não apaga o jogo do computador.
        </p>

        <div className="local-game-grid">
          <label>
            Título
            <input
              ref={titleInput}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Cor de destaque
            <span className="local-color-field">
              <input
                type="color"
                value={accent}
                onChange={(event) => setAccent(event.target.value)}
              />
              <input value={accent} onChange={(event) => setAccent(event.target.value)} />
            </span>
          </label>
          <label className="full-row">
            Resumo
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <label className="full-row">
            Executável {platform === "windows" ? "(.exe)" : "(.x86_64)"}
            <span className="path-field">
              <input value={executablePath} readOnly placeholder="Selecione o executável" />
              <button type="button" disabled={busy} onClick={() => void chooseExecutable()}>
                Procurar…
              </button>
            </span>
          </label>
          <label className="full-row">
            Capa local (opcional)
            <span className="path-field">
              <input
                value={coverPath}
                readOnly
                placeholder={game?.hasCover ? "Manter capa atual" : "Selecione uma imagem"}
              />
              <button type="button" disabled={busy} onClick={() => void chooseCover()}>
                Procurar…
              </button>
            </span>
          </label>
        </div>

        <label htmlFor="local-game-password">Senha de autorização</label>
        <div className="password-field">
          <input
            id="local-game-password"
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
          {game && (
            <button
              type="button"
              className="remove-local-action"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remover do launcher
            </button>
          )}
          <button type="button" className="cancel-action" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="confirm-action" disabled={busy || !executablePath}>
            {busy ? "Salvando…" : game ? "Salvar alterações" : "Adicionar jogo"}
          </button>
        </div>
      </form>
    </div>
  );
}
