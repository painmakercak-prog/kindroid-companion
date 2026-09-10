"use client";
import { useEffect, useRef, useState } from "react";
import { AudioLines, ArrowUp, ArrowUpRight, Check, ChevronRight, Circle, Headphones, Keyboard, Loader2, LockKeyhole, Mic, MicOff, Settings2, Sparkles, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, VoiceSession, type Phase } from "@/lib/voice";
import { acknowledgeSettingsEdits, connectionEdits, readSettingsDraft, settingsDraftStorage, writeSettingsDraft, type SettingsDraft, type SettingsEdits, type SettingsPanel } from "@/lib/settings-draft";

type Settings = { provider: "kindroid" | "gemma"; kinId: string; modelUrl: string; voiceId: string; thinking: boolean; memory: string; textReady: boolean; voiceReady: boolean; keys: { kindroid: boolean; model: boolean; deepgram: boolean; cartesia: boolean } };
const defaults: Settings = { provider: "gemma", kinId: "", modelUrl: "", voiceId: "", thinking: false, memory: "", textReady: false, voiceReady: false, keys: { kindroid: false, model: false, deepgram: false, cartesia: false } };
type Panel = SettingsPanel;
const labels: Record<Phase, string> = { idle: "A little space, just for you.", connecting: "Opening your conversation…", listening: "I'm listening.", thinking: "Thinking it through…", speaking: "Talk whenever you're ready." };

export default function Companion() {
  const [savedSettings, setSavedSettings] = useState<Settings>(defaults);
  const [edits, setEdits] = useState<SettingsEdits>({});
  const settings = { ...savedSettings, ...edits, provider: "gemma" as const };
  const secrets = { modelKey: edits.modelKey ?? "", deepgramKey: edits.deepgramKey ?? "", cartesiaKey: edits.cartesiaKey ?? "" };
  const [loaded, setLoaded] = useState(false);
  const [panel, setPanelState] = useState<Panel>(null);
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [level, setLevel] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [checks, setChecks] = useState<{ provider: string; ok: boolean; message: string }[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [erase, setErase] = useState(false);
  const session = useRef<VoiceSession | null>(null);
  const settingsDraft = useRef<SettingsDraft>({ values: {}, panel: null });
  const persistDraft = (next: SettingsDraft) => {
    settingsDraft.current = next;
    // Write during the input event, before iOS can suspend or reload the page.
    setDraftStorageAvailable(writeSettingsDraft(settingsDraftStorage(), next));
    setEdits(next.values); setPanelState(next.panel);
  };
  const setPanel = (value: Panel) => persistDraft({ ...settingsDraft.current, panel: value });
  useEffect(() => {
    const restored = readSettingsDraft(settingsDraftStorage());
    settingsDraft.current = restored;
    setEdits(restored.values); setPanelState(restored.panel);
    const engine = new VoiceSession({ phase: setPhase, active: setActive, reply: setReply, error: setError, level: setLevel, latency: setLatency });
    session.current = engine;
    let live = true;
    api("settings").then(r => r.json()).then(data => { if (live) { setSavedSettings(data); setLoaded(true); } }).catch(e => { if (live) { setError(e.message); setNotice("Could not load your saved connections. Your draft is still here. Refresh to try again."); } });
    const hide = () => { if (document.hidden) engine.stop(); };
    document.addEventListener("visibilitychange", hide);
    return () => { live = false; document.removeEventListener("visibilitychange", hide); void engine.dispose(); };
  }, []);
  const open = (value: Panel) => { session.current?.stop(); setMuted(false); setNotice(""); setErase(false); setPanel(value); };
  const persistSettings = async (submitted: SettingsEdits) => {
    const data = await (await api("settings", submitted)).json();
    setSavedSettings(data); setLoaded(true);
    persistDraft({ ...settingsDraft.current, values: acknowledgeSettingsEdits(settingsDraft.current.values, submitted) });
    return data as Settings;
  };
  const save = async () => {
    setBusy(true); setNotice(""); setError("");
    try {
      await persistSettings(panel === "memory" ? { memory: settings.memory } : connectionEdits(settingsDraft.current.values));
      setNotice("Saved.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Could not save. Your edits are still here."); }
    finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setChecks([]); setNotice("");
    try {
      await persistSettings(connectionEdits(settingsDraft.current.values));
      const result = await (await api("check", {})).json(); setChecks(result.checks);
      if (result.checks.every((c: { ok: boolean }) => c.ok)) setNotice("All connections passed. Close this panel and tap Start talking.");
    }
    catch (e) { setNotice(e instanceof Error ? e.message : "Connection check failed."); }
    finally { setBusy(false); }
  };
  const loadVoices = async () => {
    setBusy(true); setNotice("");
    try {
      await persistSettings(connectionEdits(settingsDraft.current.values));
      setVoices((await (await api("voices")).json()).voices);
    }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not load voices."); }
    finally { setBusy(false); }
  };
  const start = () => {
    if (active || phase === "connecting") { session.current?.stop(); return; }
    if (!settings.voiceReady) { open("connections"); return; }
    setTyping(false); setMuted(false); void session.current?.start();
  };
  const send = (text: string) => {
    if (!settings.textReady) { open("connections"); return; }
    if (!text.trim()) return;
    setTyping(true); setDraft(""); void session.current?.turn(text, false);
  };
  const clearMemory = async () => {
    setBusy(true);
    const memoryAtStart = settingsDraft.current.values.memory;
    try { await api("memory", undefined, "DELETE"); setSavedSettings(s => ({ ...s, memory: "" })); persistDraft({ ...settingsDraft.current, values: acknowledgeSettingsEdits(settingsDraft.current.values, { memory: memoryAtStart }) }); setReply(""); setNotice("Your saved memory and recent conversations were cleared."); setErase(false); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not clear memory."); }
    finally { setBusy(false); }
  };
  const update = (key: keyof SettingsEdits, value: string | boolean) => {
    persistDraft({ ...settingsDraft.current, values: { ...settingsDraft.current.values, [key]: value } });
    setNotice(""); setChecks([]);
  };
  const status = phase === "connecting" ? "Connecting" : active ? (muted ? "Microphone paused" : phase === "speaking" ? "Speaking" : phase === "thinking" ? "Thinking" : "Listening") : settings.voiceReady ? "Configured" : "Connections needed";
  return (
    <div className="companion-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Companion home"><span className="brand-icon"><AudioLines size={22} /></span>companion<span className="brand-period">.</span></a>
        <div className="sidebar-section">YOUR SPACE</div>
        <nav aria-label="Main navigation">
          <button className="nav-item selected" onClick={() => setPanel(null)}><AudioLines size={19} /> Conversation <span className="nav-dot" /></button>
          <button className="nav-item" onClick={() => open("memory")}><Sparkles size={19} /> Memory <ChevronRight size={15} className="nav-chevron" /></button>
          <button className="nav-item" onClick={() => open("connections")}><Settings2 size={19} /> Connections <ChevronRight size={15} className="nav-chevron" /></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="small-orbit" aria-hidden="true"><span /></div>
          <p>A familiar voice.<br />A fresh perspective.</p>
          <div className="private-label"><LockKeyhole size={13} /> Your private companion</div>
        </div>
      </aside>
      <main className="conversation">
        <header className="topbar">
          <div className="topbar-title"><span className="eyebrow">GEMMA VOICE</span><span>Your space to talk.</span></div>
          <div className="topbar-actions"><span className="status-pill"><i className={active ? "live-dot" : ""} />{status}</span><Button variant="ghost" size="icon" className="mobile-settings" aria-label="Open connections" onClick={() => open("connections")}><Settings2 /></Button></div>
        </header>
        <section className="voice-space" aria-label="Voice conversation">
          <div className="orb-scene" data-active={active} data-speaking={phase === "speaking"} style={{ "--voice-level": level } as React.CSSProperties}>
            <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
            <div className="orb"><div className="orb-grain" /><div className="orb-wave"><span /><span /><span /><span /><span /></div></div>
            <div className="orb-shadow" />
          </div>
          <div className="conversation-heading">
            <span className="eyebrow warm">{active ? "HERE WITH YOU" : "COME AS YOU ARE"}</span>
            <h1>{active ? (muted ? "Take your time." : phase === "thinking" ? "One moment." : "I'm here.") : "Room to talk."}</h1>
            <p aria-live="polite">{muted && active ? "Your microphone is paused." : labels[phase]}</p>
          </div>
          {error && <div role="alert" className="error-banner">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
          {!active && !typing && <div className="conversation-starters"><button onClick={() => send("Help me untangle something on my mind.")}>Untangle a thought <ArrowUpRight size={15} /></button><button onClick={() => send("Let's talk about my day. Start with one thoughtful question.")}>Talk about my day <ArrowUpRight size={15} /></button></div>}
          {typing && <div className="text-mode">
            {reply && <div className="text-reply" aria-live="polite"><span className="eyebrow">COMPANION</span><p>{reply}</p></div>}
            <form onSubmit={e => { e.preventDefault(); send(draft); }} className="text-composer">
              <Input value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} placeholder="What's on your mind?" aria-label="Your message" />
              <Button type="submit" size="icon" disabled={!draft.trim() || phase === "thinking"} aria-label="Send message"><ArrowUp /></Button>
            </form>
          </div>}
          <div className="voice-controls">
            {active && <Button variant="outline" size="icon" className="round-button" aria-label={muted ? "Unmute microphone" : "Mute microphone"} onClick={() => { session.current?.setMuted(!muted); setMuted(!muted); }}>{muted ? <MicOff /> : <Mic />}</Button>}
            <Button className={"start-button " + (active ? "is-active" : "")} onClick={start} disabled={!loaded && !error}>
              {phase === "connecting" ? <Loader2 className="animate-spin" size={18} /> : active ? <Square size={15} fill="currentColor" /> : settings.voiceReady ? <Mic size={19} /> : <Headphones size={20} />}
              {phase === "connecting" ? "Cancel connection" : active ? "End conversation" : settings.voiceReady ? "Start talking" : "Connect your companion"}
            </Button>
            {!active && <Button variant="ghost" size="icon" className="round-button text-toggle" aria-label={typing ? "Hide typing" : "Type a message"} aria-pressed={typing} onClick={() => setTyping(!typing)}><Keyboard size={21} /></Button>}
            {active && (phase === "thinking" || phase === "speaking") && <Button variant="outline" size="icon" className="round-button" aria-label="Interrupt reply" onClick={() => session.current?.interrupt()}><X /></Button>}
          </div>
          {active && latency !== null && <p className="latency-note">First audio · {(latency / 1000).toFixed(1)}s</p>}
          <p className="control-note">{active ? "You can interrupt at any time." : settings.voiceReady ? "Allow your microphone when prompted. Headphones help prevent echo." : "One setup. Then it's just a conversation."}</p>
        </section>
        <footer className="conversation-footer"><span><LockKeyhole size={13} /> Only you can open this space</span><button onClick={() => open("memory")}><Sparkles size={14} /> Your memory <ChevronRight size={14} /></button><span className="footer-model">GEMMA 4 HERETICAL</span></footer>
      </main>
      <Dialog open={panel !== null} onOpenChange={isOpen => { if (!isOpen) setPanel(null); }}>
        <DialogContent className="settings-dialog">
          <DialogHeader><span className="eyebrow warm">YOUR COMPANION</span><DialogTitle>{panel === "memory" ? "A little context goes a long way." : "Make the connection."}</DialogTitle><DialogDescription>{panel === "memory" ? "Save what you'd like your companion to know about you." : "Connect your model and voice services. Saved keys are encrypted on the server."}</DialogDescription></DialogHeader>
          <p className="field-note" role="status">{draftStorageAvailable ? "Unfinished edits stay in this tab for one hour, including after a refresh. Save before closing the tab." : "This browser cannot keep drafts. Save each field before switching apps."}</p>
          {panel === "connections" ? <div className="settings-body">
            <div className="connection-group"><div className="connection-heading"><span className="step-number">01</span><div><h3>Gemma 4 Heretical</h3><p>Conversation & reasoning · self-hosted</p></div><span className={"key-state " + (settings.keys.model ? "saved" : "")}>{settings.keys.model ? <Check size={16} /> : <Circle size={13} />}</span></div>
              <p className="field-note">Gemma needs a running model server. The download contains setup files; it does not start a server.</p>
              <label>Model server URL<Input value={settings.modelUrl} onChange={e => update("modelUrl", e.target.value)} placeholder="https://your-model-server.com" type="url" autoComplete="off" /></label>
              <label>Server access key<Input value={secrets.modelKey} onChange={e => update("modelKey", e.target.value)} placeholder={settings.keys.model ? "Saved · leave blank to keep" : "Your model gateway key"} type="password" autoComplete="new-password" /></label>
              <a className="setup-link" href="/setup" target="_blank" rel="noreferrer">Set up your Gemma model server <ArrowUpRight size={15} /></a>
              <div className="switch-row"><div><label htmlFor="thinking">Deeper reasoning</label><p>More time to think before speaking.</p></div><Switch id="thinking" checked={settings.thinking} onCheckedChange={v => update("thinking", v)} /></div>
            </div>
            <div className="connection-group"><div className="connection-heading"><span className="step-number">02</span><div><h3>Deepgram Nova-3</h3><p>Speech recognition</p></div></div>
              <label>Deepgram API key<Input type="password" autoComplete="new-password" value={secrets.deepgramKey} onChange={e => update("deepgramKey", e.target.value)} placeholder={settings.keys.deepgram ? "Saved · leave blank to keep" : "A key with Member permissions"} /></label>
              <a className="setup-link" href="https://console.deepgram.com/" target="_blank" rel="noreferrer">Open Deepgram <ArrowUpRight size={15} /></a>
            </div>
            <div className="connection-group"><div className="connection-heading"><span className="step-number">03</span><div><h3>Cartesia Sonic 3.6</h3><p>Voice synthesis</p></div></div>
              <label>Cartesia API key<Input type="password" autoComplete="new-password" value={secrets.cartesiaKey} onChange={e => update("cartesiaKey", e.target.value)} placeholder={settings.keys.cartesia ? "Saved · leave blank to keep" : "Your Cartesia API key"} /></label>
              <label>Voice ID<Input value={settings.voiceId} onChange={e => update("voiceId", e.target.value)} placeholder="Your Cartesia voice ID" autoComplete="off" /></label>
              <div className="inline-actions"><button onClick={loadVoices} disabled={busy || !loaded || !(settings.keys.cartesia || secrets.cartesiaKey.trim())}>Load my voices</button><a href="https://play.cartesia.ai/keys" target="_blank" rel="noreferrer">Open Cartesia <ArrowUpRight size={14} /></a></div>
              {voices.length > 0 && <div className="provider-picker"><label htmlFor="voice-picker">Choose a voice</label><Select value={settings.voiceId || undefined} onValueChange={v => update("voiceId", v)}><SelectTrigger id="voice-picker" className="w-full"><SelectValue placeholder="Select a voice" /></SelectTrigger><SelectContent>{voices.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent></Select></div>}

            </div>
            {checks.length > 0 && <ul className="check-results">{checks.map(c => <li key={c.provider} className={c.ok ? "pass" : "fail"}>{c.ok ? <Check size={16} /> : <X size={16} />}<span><strong>{c.provider}</strong> · {c.message}</span></li>)}</ul>}
          </div> : <div className="settings-body memory-body"><label htmlFor="memory">What should I remember?</label><Textarea id="memory" rows={7} value={settings.memory} maxLength={3000} onChange={e => update("memory", e.target.value)} placeholder="Your name, interests, what you're working on, or how you like to talk…" /><p className="field-note">This note and up to 24 recent turns are saved to your account. Only displayed or fully spoken replies are remembered. Audio recordings are not stored by this app; speech providers process your audio.</p><div className="memory-clear">{erase ? <><p>Clear your saved note and all recent conversation memory?</p><Button variant="destructive" onClick={clearMemory} disabled={busy}>Clear all memory</Button><Button variant="ghost" onClick={() => setErase(false)}>Cancel</Button></> : <button onClick={() => setErase(true)}>Clear all memory</button>}</div></div>}
          {notice && <p className="settings-notice" role="status">{notice}</p>}
          <div className="settings-footer">{panel === "connections" && <Button variant="outline" onClick={check} disabled={busy || !loaded}>Save & test</Button>}<Button onClick={save} disabled={busy || !loaded}>{busy ? <Loader2 className="animate-spin" size={16} /> : <Check size={16} />} Save {panel === "memory" ? "memory" : "connections"}</Button></div>
          {panel === "connections" && <p className="field-note">The test checks access and generates audio. It checks the installed Gemma model without sending a conversation message. Audio is processed by your speech providers; this app does not store recordings.</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
