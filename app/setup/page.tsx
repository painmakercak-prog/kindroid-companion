import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Download } from "lucide-react";
export default function Setup() {
  return <main className="setup-page"><Link className="setup-back" href="/"><ArrowLeft size={16} /> Back to Companion</Link><span className="eyebrow warm">MODEL SERVER SETUP</span><h1>Give Llama a home.</h1><p className="setup-intro">Your companion is configured for Llama 3.1 8B Abliterated Q5_K_M. It needs an Ollama inference server; the companion website handles conversation memory and voice connections.</p>
    <a className="download-button" href="/llama-model-server.zip" download><Download size={18} /> Download server setup</a>
    <ol className="setup-steps"><li><span>01</span><div><h2>Choose a machine</h2><p>The pinned model is about 5.7 GB. A modern computer with enough system RAM can run it on CPU, while a supported GPU gives much better conversational latency. You do not need the 24–32 GB GPU class required by the old 31B setup.</p></div></li>
    <li><span>02</span><div><h2>Start the model server</h2><p>The download includes Docker configuration, the authenticated gateway, and an installer that pulls the exact Ollama model: mannix/llama3.1-8b-abliterated:q5_k_m.</p><p>Ollama stays private behind the gateway; only the authenticated chat and model-check routes are exposed.</p></div></li>
    <li><span>03</span><div><h2>Connect it here</h2><p>Enter the server's HTTPS address and access key in Connections. Add your Deepgram and Cartesia keys, choose a voice, save, then test the connections. Start talking once the checks pass.</p></div></li></ol>
    <div className="setup-note"><h2>What is ready, and what needs you</h2><p>The companion interface, local memory layer, Llama request path, Deepgram transcription, and Cartesia speech path are wired. A running Ollama host and your speech-provider credentials are still required.</p><p>The selected model is community-modified. Test response quality and latency on the machine you choose.</p></div>
    <a className="setup-link" href="https://ollama.com/mannix/llama3.1-8b-abliterated:q5_k_m" target="_blank" rel="noreferrer">View the selected Ollama model <ArrowUpRight size={15} /></a>
  </main>;
}
