import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type {
  CatalogPlatform,
  CatalogResponse,
  EditableGame,
  Game,
  GameBuild,
  SavedCatalogResponse,
} from "../catalogTypes";
import "./CatalogEditor.css";
import "./Dialog.css";

type CatalogEditorProps = {
  coverSources: Record<string, string>;
  onClose: () => void;
  onFailure: (message: string) => void;
  onSaved: (games: Game[], catalogPath: string) => void;
  onSynced: (games: Game[]) => void;
};

function toEditableGames(games: Array<Game & { cover_url?: string }>): EditableGame[] {
  return games.map(({ cover_url, ...item }) => ({
    ...item,
    coverUrl: item.coverUrl ?? cover_url ?? "",
  }));
}

export function CatalogEditor({
  coverSources,
  onClose,
  onFailure,
  onSaved,
  onSynced,
}: CatalogEditorProps) {
  const [draft, setDraft] = useState<EditableGame[]>([]);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const busy = loading || saving || syncing;

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("get_catalog_json")
      .then((contents) => {
        if (cancelled) return;
        setDraft(toEditableGames(JSON.parse(contents)));
      })
      .catch((reason) => {
        if (cancelled) return;
        onFailure(`Não foi possível abrir o catálogo: ${String(reason)}`);
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onClose, onFailure]);

  function updateGame(index: number, changes: Partial<EditableGame>) {
    setDraft((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...changes } : item)),
    );
  }

  function updateBuild(
    gameIndex: number,
    platformName: CatalogPlatform,
    changes: Partial<GameBuild>,
  ) {
    setDraft((current) =>
      current.map((item, itemIndex) => {
        if (itemIndex !== gameIndex) return item;
        const build = item.builds[platformName] ?? { downloadUrl: "", executable: "" };
        return {
          ...item,
          builds: { ...item.builds, [platformName]: { ...build, ...changes } },
        };
      }),
    );
  }

  function addGame() {
    const usedIds = new Set(draft.map((item) => item.id));
    let id = "novo-jogo";
    let suffix = 2;
    while (usedIds.has(id)) id = `novo-jogo-${suffix++}`;
    setEditorIndex(draft.length);
    setDraft([
      ...draft,
      {
        id,
        title: "Novo jogo",
        summary: "",
        accent: "#f6a43a",
        coverUrl: "",
        builds: {},
      },
    ]);
  }

  function removeGame(index: number) {
    setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditorIndex(null);
  }

  function moveGame(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.length) return;
    setDraft((current) => {
      const reordered = [...current];
      [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
      return reordered;
    });
    setEditorIndex(destination);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const catalogToSave = draft.map((item) => ({
        ...item,
        coverUrl: item.coverUrl?.trim() || undefined,
        builds: Object.fromEntries(
          Object.entries(item.builds).filter(
            ([, build]) => build.downloadUrl.trim() || build.executable.trim(),
          ),
        ),
      }));
      const result = await invoke<SavedCatalogResponse>("save_catalog", {
        password,
        contents: JSON.stringify(catalogToSave, null, 2),
      });
      onSaved(result.games, result.catalogPath);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function syncFromDrive() {
    setSyncing(true);
    setError("");
    try {
      const result = await invoke<CatalogResponse>("sync_catalog_from_drive", { password });
      setDraft(toEditableGames(result.games));
      setEditorIndex(null);
      setSyncConfirm(false);
      onSynced(result.games);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSyncing(false);
    }
  }

  const selectedGame = editorIndex === null ? null : draft[editorIndex];

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="exit-dialog catalog-dialog"
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-dialog-title"
      >
        <p className="eyebrow">ADMINISTRAÇÃO</p>
        <h2 id="catalog-dialog-title">Editar catálogo</h2>
        <p>
          Use IDs do Google Drive ou URLs HTTPS completas em <code>coverUrl</code> e{" "}
          <code>downloadUrl</code>. Depois de salvar, o caminho do arquivo pronto para envio ao
          Drive será exibido no rodapé.
        </p>

        <div className="catalog-editor-list">
          {loading ? (
            <p className="catalog-editor-hint">Carregando catálogo…</p>
          ) : (
            <>
              <div className="catalog-editor-picker" aria-label="Jogos do catálogo">
                <button
                  type="button"
                  className="catalog-picker-card add-catalog-card"
                  onClick={addGame}
                  aria-label="Adicionar novo jogo"
                >
                  <span className="catalog-picker-cover" aria-hidden="true">
                    +
                  </span>
                  <span>Novo jogo</span>
                </button>
                {draft.map((item, index) => (
                  <button
                    type="button"
                    className={`catalog-picker-card ${editorIndex === index ? "is-selected" : ""}`}
                    key={`${item.id}-${index}`}
                    onClick={() => setEditorIndex(index)}
                    style={{ "--accent": item.accent } as React.CSSProperties}
                    aria-pressed={editorIndex === index}
                  >
                    <span className="catalog-picker-cover">
                      {coverSources[item.id] ? (
                        <img src={coverSources[item.id]} alt="" />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <span>{item.title || "Sem título"}</span>
                  </button>
                ))}
              </div>

              {!selectedGame ? (
                <p className="catalog-editor-hint">
                  Selecione um jogo para editar ou use + para adicionar.
                </p>
              ) : (
                <fieldset className="catalog-editor-game">
                  <legend>Jogo {editorIndex! + 1}</legend>
                  <div className="catalog-order-actions" aria-label="Ordenação do jogo">
                    <button
                      type="button"
                      disabled={editorIndex === 0}
                      onClick={() => moveGame(editorIndex!, -1)}
                    >
                      ← Mover antes
                    </button>
                    <button
                      type="button"
                      disabled={editorIndex === draft.length - 1}
                      onClick={() => moveGame(editorIndex!, 1)}
                    >
                      Mover depois →
                    </button>
                  </div>
                  <div className="catalog-editor-grid">
                    <label>
                      ID do jogo
                      <input
                        value={selectedGame.id}
                        onChange={(event) => updateGame(editorIndex!, { id: event.target.value })}
                      />
                    </label>
                    <label>
                      Título
                      <input
                        value={selectedGame.title}
                        onChange={(event) =>
                          updateGame(editorIndex!, { title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Cor de destaque
                      <span className="color-field">
                        <input
                          type="color"
                          value={selectedGame.accent}
                          onChange={(event) =>
                            updateGame(editorIndex!, { accent: event.target.value })
                          }
                        />
                        <input
                          value={selectedGame.accent}
                          onChange={(event) =>
                            updateGame(editorIndex!, { accent: event.target.value })
                          }
                        />
                      </span>
                    </label>
                    <label>
                      ID ou URL da capa
                      <input
                        value={selectedGame.coverUrl ?? ""}
                        onChange={(event) =>
                          updateGame(editorIndex!, { coverUrl: event.target.value })
                        }
                      />
                    </label>
                    <label className="full-row">
                      Resumo
                      <textarea
                        value={selectedGame.summary}
                        onChange={(event) =>
                          updateGame(editorIndex!, { summary: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  {(["windows", "linux"] as const).map((platformName) => {
                    const build = selectedGame.builds[platformName] ?? {
                      downloadUrl: "",
                      executable: "",
                    };
                    return (
                      <fieldset className="catalog-build" key={platformName}>
                        <legend>{platformName === "windows" ? "Windows" : "Linux"}</legend>
                        <label>
                          ID ou URL do ZIP
                          <input
                            value={build.downloadUrl}
                            onChange={(event) =>
                              updateBuild(editorIndex!, platformName, {
                                downloadUrl: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Caminho do executável
                          <input
                            value={build.executable}
                            onChange={(event) =>
                              updateBuild(editorIndex!, platformName, {
                                executable: event.target.value,
                              })
                            }
                          />
                        </label>
                      </fieldset>
                    );
                  })}
                  <button
                    type="button"
                    className="remove-game-action"
                    onClick={() => removeGame(editorIndex!)}
                  >
                    Remover jogo
                  </button>
                </fieldset>
              )}
            </>
          )}
        </div>

        <label htmlFor="catalog-password">Senha de autorização</label>
        <div className="password-field">
          <input
            id="catalog-password"
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

        {syncConfirm && (
          <div className="catalog-sync-warning" role="alert">
            <p>
              As alterações locais serão substituídas pelo catálogo atual do Drive. Esta ação não
              pode ser desfeita pela tela do launcher.
            </p>
            <div>
              <button type="button" disabled={syncing} onClick={() => setSyncConfirm(false)}>
                Manter dados locais
              </button>
              <button
                type="button"
                className="confirm-sync-action"
                disabled={syncing}
                onClick={() => void syncFromDrive()}
              >
                {syncing ? "Sincronizando…" : "Substituir pelo Drive"}
              </button>
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button
            type="button"
            className="sync-catalog-action"
            disabled={busy || syncConfirm}
            onClick={() => setSyncConfirm(true)}
          >
            Sincronizar com o Drive
          </button>
          <button type="button" className="cancel-action" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="confirm-action" disabled={busy || syncConfirm}>
            {saving ? "Salvando…" : "Salvar catálogo"}
          </button>
        </div>
      </form>
    </div>
  );
}
