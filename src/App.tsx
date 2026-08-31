import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import catalog from "./catalog.json";
import "./App.css";

type Game = { id: string; title: string; summary: string; accent: string; sourcePath: string; executable: string };
type Installation = { installPath: string; executablePath: string };
const games = catalog as Game[];

function App() {
  const [selected, setSelected] = useState(0);
  const [installations, setInstallations] = useState<Record<string, Installation>>({});
  const [message, setMessage] = useState("Catálogo local — selecione um jogo.");
  const [busy, setBusy] = useState(false);
  const [gameRunning, setGameRunning] = useState(false);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitPassword, setExitPassword] = useState("");
  const [exitError, setExitError] = useState("");
  const interactionLocked = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const game = games[selected];
  const installation = installations[game.id];

  useEffect(() => {
    Promise.all(games.map(async (item) => [item.id, await invoke<Installation | null>("get_installation", { gameId: item.id, executable: item.executable })] as const))
      .then((entries) => setInstallations(Object.fromEntries(entries.filter(([, item]) => item !== null)) as Record<string, Installation>))
      .catch(() => setMessage("Não foi possível ler as instalações locais."));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (exitDialogOpen) return;
      if (event.target instanceof Element && event.target.closest("button, input")) return;
      if (["ArrowRight", "d", "D"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current + 1) % games.length); }
      if (["ArrowLeft", "a", "A"].includes(event.key)) { event.preventDefault(); setSelected((current) => (current - 1 + games.length) % games.length); }
      if (["Enter", " "].includes(event.key) && !busy && !gameRunning && !interactionLocked.current) {
        event.preventDefault();
        void (installation ? launchInstalledGame() : installGame());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, exitDialogOpen, gameRunning, installation, game]);

  useEffect(() => {
    let animationFrame = 0;
    let heldActions = new Set<string>();

    const activate = (action: string) => {
      if (action === "right") setSelected((current) => (current + 1) % games.length);
      if (action === "left") setSelected((current) => (current - 1 + games.length) % games.length);
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
  }, [busy, exitDialogOpen, gameRunning, installation, game]);

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

  async function installGame() {
    setBusy(true); setMessage(`Instalando ${game.title}…`);
    try {
      const result = await invoke<Installation>("install_game", { gameId: game.id, sourcePath: game.sourcePath, executable: game.executable });
      setInstallations((current) => ({ ...current, [game.id]: result }));
      setMessage(`${game.title} está pronto para jogar.`);
    } catch (error) { setMessage(`Falha ao instalar: ${String(error)}`); }
    finally { setBusy(false); }
  }

  async function launchInstalledGame() {
    if (!installation || gameRunning || interactionLocked.current) return;
    interactionLocked.current = true;
    setBusy(true); setMessage(`Abrindo ${game.title}…`);
    try {
      await invoke("launch_game", { executable: installation.executablePath, workingDirectory: installation.installPath });
      setGameRunning(true);
      setMessage(`${game.title} está em execução.`);
    } catch (error) { interactionLocked.current = false; setMessage(`Falha ao abrir: ${String(error)}`); }
    finally { setBusy(false); }
  }

  function activateSelectedGame() {
    if (busy || gameRunning || interactionLocked.current) return;
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
    <header className="topbar"><div><p className="eyebrow">LIGA DE JOGOS</p><h1>UEFS Launcher</h1></div><div className="topbar-actions"><p className="status">{Object.keys(installations).length} instalados</p><button className="exit-action" onClick={openExitDialog}>Sair</button></div></header>
    <section aria-label="Catálogo de jogos" className="catalog">
      {games.map((item, index) => <button className={`game-card ${selected === index ? "is-selected" : ""}`} key={item.id} onClick={() => setSelected(index)} style={{ "--accent": item.accent } as React.CSSProperties}>
        <span className="cover" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className="game-title">{item.title}</span><span className="game-state">{installations[item.id] ? "Pronto para jogar" : "Não instalado"}</span>
      </button>)}
    </section>
    <section className="game-details" aria-live="polite"><div><p className="eyebrow">SELECIONADO</p><h2>{game.title}</h2><p>{game.summary}</p></div><button className="primary-action" disabled={busy || gameRunning} onClick={activateSelectedGame}>{busy ? "Aguarde…" : gameRunning ? "Em execução" : installation ? "Jogar" : "Instalar"}</button></section>
    <footer><span>{message}</span><span>← → / A-D ou direcional · Enter / A para selecionar</span></footer>
    {exitDialogOpen && <div className="dialog-backdrop" role="presentation"><form className="exit-dialog" onSubmit={requestExit} role="dialog" aria-modal="true" aria-labelledby="exit-dialog-title"><p className="eyebrow">ADMINISTRAÇÃO</p><h2 id="exit-dialog-title">Autorização necessária</h2><p>Digite a senha para fechar o launcher.</p><label htmlFor="admin-password">Senha de autorização</label><input ref={passwordInput} id="admin-password" type="password" value={exitPassword} onChange={(event) => setExitPassword(event.target.value)} autoComplete="current-password" />{exitError && <p className="dialog-error">{exitError}</p>}<div className="dialog-actions"><button type="button" className="cancel-action" onClick={() => setExitDialogOpen(false)}>Cancelar</button><button type="submit" className="confirm-action">Confirmar saída</button></div></form></div>}
  </main>;
}

export default App;
