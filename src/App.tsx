import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import catalog from "./catalog.json";
import "./App.css";

type Platform = "windows" | "linux" | "unsupported";
type GameBuild = { downloadUrl: string; executable: string };
type Game = { id: string; title: string; summary: string; accent: string; coverUrl?: string; builds: Partial<Record<Platform, GameBuild>> };
type Installation = { installPath: string; executablePath: string };
type DownloadProgress = { gameId: string; downloadedBytes: number; totalBytes: number | null };
type CatalogResponse = { games: Game[]; source: "remote" | "cache" | "bundled"; detail: string | null };
const fallbackGames = catalog as Game[];

function App() {
  const [selected, setSelected] = useState(0);
  const [games, setGames] = useState<Game[]>(fallbackGames);
  const [platform, setPlatform] = useState<Platform>("windows");
  const [installations, setInstallations] = useState<Record<string, Installation>>({});
  const [coverSources, setCoverSources] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("Catálogo local — selecione um jogo.");
  const [busy, setBusy] = useState(false);
  const [downloadingGameId, setDownloadingGameId] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitPassword, setExitPassword] = useState("");
  const [exitError, setExitError] = useState("");
  const interactionLocked = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const game = games[selected] ?? fallbackGames[0];
  const build = game.builds[platform];
  const installation = installations[game.id];

  useEffect(() => { void invoke<Platform>("current_platform").then(setPlatform); }, []);

  useEffect(() => {
    void invoke<CatalogResponse>("load_catalog")
      .then(({ games: updatedCatalog, source, detail }) => {
        if (updatedCatalog.length > 0) setGames(updatedCatalog);
        setSelected((current) => Math.min(current, Math.max(0, updatedCatalog.length - 1)));
        setMessage(source === "remote" ? "Catálogo atualizado do Drive." : `Não foi possível atualizar pelo Drive: ${detail ?? "erro desconhecido"}. ${source === "cache" ? "Usando catálogo salvo localmente." : "Usando catálogo embutido no launcher."}`);
      })
      .catch(() => setMessage("Usando o catálogo local. Não foi possível atualizar pelo Drive."));
  }, []);

  useEffect(() => {
    Promise.all(games.map(async (item) => [item.id, item.builds[platform] ? await invoke<Installation | null>("get_installation", { gameId: item.id, executable: item.builds[platform]?.executable }) : null] as const))
      .then((entries) => setInstallations(Object.fromEntries(entries.filter(([, item]) => item !== null)) as Record<string, Installation>))
      .catch(() => setMessage("Não foi possível ler as instalações locais."));
  }, [games, platform]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(games.filter((item) => item.coverUrl).map(async (item) => {
      try { return [item.id, await invoke<string>("get_cached_cover", { gameId: item.id, coverUrl: item.coverUrl })] as const; }
      catch { return null; }
    })).then((entries) => {
      if (!cancelled) setCoverSources(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [games]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgress>("download-progress", (event) => {
      const { gameId, downloadedBytes, totalBytes } = event.payload;
      const title = games.find((item) => item.id === gameId)?.title ?? gameId;
      if (totalBytes) setMessage(`Baixando ${title}: ${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))}%`);
      else setMessage(`Baixando ${title}: ${(downloadedBytes / 1_048_576).toFixed(1)} MB`);
    }).then((stopListening) => { unlisten = stopListening; });
    return () => unlisten?.();
  }, [games]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (exitDialogOpen) return;
      if (event.target instanceof Element && event.target.closest("button, input")) return;
      if (["ArrowRight", "d", "D"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current + 1) % games.length); }
      if (["ArrowLeft", "a", "A"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current - 1 + games.length) % games.length); }
      if (["ArrowDown", "s", "S"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current + 3) % games.length); }
      if (["ArrowUp", "w", "W"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current - 3 + games.length) % games.length); }
      if (["Enter", " "].includes(event.key) && !busy && !gameRunning && !interactionLocked.current) {
        event.preventDefault();
        void (installation ? launchInstalledGame() : installGame());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, exitDialogOpen, gameRunning, installation, game, games]);

  useEffect(() => {
    let animationFrame = 0;
    let heldActions = new Set<string>();

    const activate = (action: string) => {
      if (action === "right") setSelected((current) => (current + 1) % games.length);
      if (action === "left") setSelected((current) => (current - 1 + games.length) % games.length);
      if (action === "down") setSelected((current) => (current + 3) % games.length);
      if (action === "up") setSelected((current) => (current - 3 + games.length) % games.length);
      if (action === "confirm") void activateSelectedGame();
      if (action === "back" && exitDialogOpen) setExitDialogOpen(false);
    };

    const pollGamepad = () => {
      const gamepad = [...navigator.getGamepads()].find((item) => item !== null);
      const activeActions = new Set<string>();
      if (gamepad) {
        const pressed = (button: number) => gamepad.buttons[button]?.pressed;
        if (!exitDialogOpen) {
          if (pressed(14) || gamepad.axes[0] < -0.6) activeActions.add("left");
          if (pressed(15) || gamepad.axes[0] > 0.6) activeActions.add("right");
          if (pressed(12) || gamepad.axes[1] < -0.6) activeActions.add("up");
          if (pressed(13) || gamepad.axes[1] > 0.6) activeActions.add("down");
          if (pressed(0)) activeActions.add("confirm");
        }
        if (pressed(1)) activeActions.add("back");
      }
      for (const action of activeActions) if (!heldActions.has(action)) activate(action);
      heldActions = activeActions;
      animationFrame = window.requestAnimationFrame(pollGamepad);
    };

    animationFrame = window.requestAnimationFrame(pollGamepad);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [busy, exitDialogOpen, gameRunning, installation, game, games]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("game-ended", () => {
      setGameRunning(false);
      interactionLocked.current = false;
      setMessage("Jogo encerrado. Escolha o próximo.");
    }).then((stopListening) => { unlisten = stopListening; });
    return () => unlisten?.();
  }, []);

  useEffect(() => { if (exitDialogOpen) passwordInput.current?.focus(); }, [exitDialogOpen]);

  useEffect(() => {
    const catalogElement = catalogRef.current;
    const card = cardRefs.current[selected];
    if (!catalogElement || !card) return;
    if (selected < 3) {
      catalogElement.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);

  async function installGame() {
    setBusy(true); setDownloadingGameId(game.id); setMessage(`Instalando ${game.title}…`);
    try {
      if (!build) throw new Error(`Não há build para ${platform}.`);
      const result = await invoke<Installation>("install_game", { gameId: game.id, downloadUrl: build.downloadUrl, executable: build.executable });
      setInstallations((current) => ({ ...current, [game.id]: result }));
      setMessage(`${game.title} está pronto para jogar.`);
    } catch (error) { setMessage(`Falha ao instalar: ${String(error)}`); }
    finally { setBusy(false); setDownloadingGameId(null); }
  }

  async function launchInstalledGame() {
    if (!installation || !build || gameRunning || interactionLocked.current) return;
    interactionLocked.current = true;
    setBusy(true); setMessage(`Abrindo ${game.title}…`);
    try {
      await invoke("launch_game", { executable: installation.executablePath, workingDirectory: installation.installPath });
      setGameRunning(true);
      setMessage(`${game.title} está em execução.`);
    } catch (error) { interactionLocked.current = false; setMessage(`Falha ao abrir: ${String(error)}`); }
    finally { setBusy(false); }
  }

  async function uninstallGame() {
    if (!installation || busy || gameRunning) return;
    setBusy(true); setMessage(`Desinstalando ${game.title}…`);
    try {
      await invoke("uninstall_game", { gameId: game.id });
      setInstallations((current) => { const updated = { ...current }; delete updated[game.id]; return updated; });
      setCoverSources((current) => { const updated = { ...current }; delete updated[game.id]; return updated; });
      setMessage(`${game.title} e sua capa foram removidos.`);
    } catch (error) { setMessage(`Falha ao desinstalar: ${String(error)}`); }
    finally { setBusy(false); }
  }

  function activateSelectedGame() {
    if (busy || gameRunning || interactionLocked.current) return;
    if (!build) { setMessage(`Este jogo ainda não possui build para ${platform}.`); return; }
    if (installation) void launchInstalledGame();
    else void installGame();
  }

  function openExitDialog() {
    setExitPassword("");
    setExitError("");
    setExitDialogOpen(true);
  }

  async function requestExit(event: React.FormEvent) {
    event.preventDefault();
    try { await invoke("exit_launcher", { password: exitPassword }); }
    catch (error) { setExitError(String(error)); }
  }

  return <main className="launcher-shell">
    <header className="topbar"><div><p className="eyebrow">LIGA DE JOGOS</p><h1>UEFS</h1></div><div className="topbar-actions"><p className="status">{Object.keys(installations).length} instalados</p><button className="exit-action" onClick={openExitDialog}>Sair</button></div></header>
    <section ref={catalogRef} aria-label="Catálogo de jogos" className="catalog" data-downloading-game={downloadingGameId ?? undefined}>
      {games.map((item, index) => <button ref={(element) => { cardRefs.current[index] = element; }} className={`game-card ${selected === index ? "is-selected" : ""}`} key={item.id} onClick={() => setSelected(index)} style={{ "--accent": item.accent } as React.CSSProperties}>
        <span className="cover" aria-hidden="true">{coverSources[item.id] ? <img src={coverSources[item.id]} alt="" /> : String(index + 1).padStart(2, "0")}</span><span className="game-title">{item.title}</span><span className="game-state">{item.builds[platform] ? installations[item.id] ? "Pronto para jogar" : "Não instalado" : "Indisponível nesta plataforma"}</span>
      </button>)}
    </section>
    <section className="game-details" aria-live="polite"><div><p className="eyebrow">SELECIONADO · {platform.toUpperCase()}</p><h2>{game.title}</h2><p>{game.summary}</p></div><div className="game-actions"><button className="primary-action" disabled={busy || gameRunning || !build} onClick={activateSelectedGame}>{busy ? "Aguarde…" : gameRunning ? "Em execução" : !build ? "Indisponível" : installation ? "Jogar" : "Instalar"}</button>{installation && <button className="secondary-action" disabled={busy || gameRunning} onClick={() => void uninstallGame()}>Desinstalar</button>}</div></section>
    <footer><span>{message}</span><span>Setas / WASD ou direcional · Enter / A para selecionar</span></footer>
    {exitDialogOpen && <div className="dialog-backdrop" role="presentation"><form className="exit-dialog" onSubmit={requestExit} role="dialog" aria-modal="true" aria-labelledby="exit-dialog-title"><p className="eyebrow">ADMINISTRAÇÃO</p><h2 id="exit-dialog-title">Autorização necessária</h2><p>Digite a senha para fechar o launcher.</p><label htmlFor="admin-password">Senha de autorização</label><input ref={passwordInput} id="admin-password" type="password" value={exitPassword} onChange={(event) => setExitPassword(event.target.value)} autoComplete="current-password" />{exitError && <p className="dialog-error">{exitError}</p>}<div className="dialog-actions"><button type="button" className="cancel-action" onClick={() => setExitDialogOpen(false)}>Cancelar</button><button type="submit" className="confirm-action">Confirmar saída</button></div></form></div>}
  </main>;
}

export default App;
