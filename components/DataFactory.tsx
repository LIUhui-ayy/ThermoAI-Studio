
import React, { useState } from 'react';
// Added missing Upload icon to the lucide-react imports
import { FileText, Wand2, ArrowRight, Layers, Table, FlaskConical, Binary, CheckCircle2, Upload } from 'lucide-react';
import { GoogleGenAI } from "@google/genai";

const DataFactory: React.FC = () => {
  const [extracting, setExtracting] = useState(false);
  const [stage, setStage] = useState(1);

  const agents = [
    { id: 1, name: 'Phase Models', icon: <Layers />, status: 'active', desc: 'Define sublattice models (FCC, BCC, etc.)' },
    { id: 2, name: 'Liquid Agent', icon: <FlaskConical />, status: 'locked', desc: 'Process enthalpy/entropy of mixing' },
    { id: 3, name: 'Solid Agent', icon: <Layers />, status: 'locked', desc: 'Process solid solution data' },
    { id: 4, name: 'Compound Agent', icon: <Binary />, status: 'locked', desc: 'Formation enthalpy of intermetallics' },
    { id: 5, name: 'Activity Agent', icon: <Table />, status: 'waiting', desc: 'Chemical potential & activity processing' },
    { id: 6, name: 'ZPF Agent', icon: <CheckCircle2 />, status: 'waiting', desc: 'Phase boundary coordinate digitalization' },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto h-full overflow-y-auto">
      <div className="mb-10 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Data Structuring Factory</h1>
          <p className="text-slate-400 max-w-2xl">
            Seamlessly convert PDF literature into structured JSON datasets compatible with ESPEI. 
            Utilize our Multi-Agent system to handle phase models, thermochemical data, and phase equilibria.
          </p>
        </div>
        <div className="flex space-x-4">
          <button className="bg-black hover:bg-slate-700 text-white px-6 py-2 rounded-none border border-[var(--industrial-border)] flex items-center space-x-2 transition-all">
            <FileText className="w-5 h-5" />
            <span>Upload Literature</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Stage 1: Extraction */}
        <div className="col-span-1 space-y-6">
          <div className="bg-black rounded-none border border-[var(--industrial-border)] p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="p-2 bg-[var(--industrial-accent)] rounded-none"><Wand2 className="w-5 h-5 text-black" /></div>
              <h2 className="text-lg font-bold">AI Literature Agent</h2>
            </div>
            <div className="bg-black rounded-none p-8 border-2 border-dashed border-[var(--industrial-border)] flex flex-col items-center justify-center text-center space-y-4">
              <Upload className="w-10 h-10 text-slate-500" />
              <div className="text-sm text-slate-400">Drag & drop your PDF research paper here</div>
              <button className="text-[var(--industrial-accent)] font-semibold hover:underline">Select files</button>
            </div>
          </div>
        </div>

        {/* Stage 2: Agents */}
        <div className="col-span-2 space-y-6">
           <div className="bg-black rounded-none border border-[var(--industrial-border)] p-6 h-full">
            <h2 className="text-lg font-bold mb-6 flex items-center">
              Multi-Agent Orchestration 
              <span className="ml-3 text-xs bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)] px-2 py-0.5 rounded-none uppercase tracking-tighter font-bold">Phase Model Dependent</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {agents.map(agent => (
                <div key={agent.id} className={`p-4 rounded-none border transition-all ${agent.status === 'active' ? 'bg-black border-[var(--industrial-accent)]/50 shadow-lg shadow-[var(--industrial-accent)]/10' : 'bg-black border-[var(--industrial-border)] opacity-60'}`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className={`p-2 rounded-none ${agent.status === 'active' ? 'bg-[var(--industrial-accent)]' : 'bg-slate-700'}`}>
                      {/* Fix: cast agent.icon to React.ReactElement<any> to resolve className type error */}
                      {React.cloneElement(agent.icon as React.ReactElement<any>, { className: `w-5 h-5 ${agent.status === 'active' ? 'text-black' : 'text-white'}` })}
                    </div>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-none ${agent.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-slate-800 text-slate-500'}`}>
                      {agent.status}
                    </span>
                  </div>
                  <h3 className="font-bold text-slate-200">{agent.name}</h3>
                  <p className="text-xs text-slate-500 mt-1">{agent.desc}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 flex justify-end">
              <button className="bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-black px-8 py-3 rounded-none font-bold flex items-center space-x-2 transition-transform hover:scale-105">
                <span>Deploy Agents</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default DataFactory;
