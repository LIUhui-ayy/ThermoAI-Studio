import React, { useState, useEffect, useRef } from 'react';
import { 
  Database, Folder, Settings, Zap, FileText, 
  Target, Download, Maximize2, Layout, RefreshCw,
  ImageIcon, Activity, X
} from 'lucide-react';
import { FileNode } from '../types';
import FileSelectorModal from './FileSelectorModal';

interface UncertaintyAnalysisProps {
  files: FileNode[];
}

const UncertaintyAnalysis: React.FC<UncertaintyAnalysisProps> = ({ files }) => {
  // Config
  const [tdbFile, setTdbFile] = useState<string>('A1-AL-MG_Best_Final.tdb');
  const [dbFile, setDbFile] = useState<string>('A1-AL-MG_Final_Optimized.db');
  const [dataPath, setDataPath] = useState<string>('input-data');
  const [minScore, setMinScore] = useState<number>(-390000000);
  const [nSamples, setNSamples] = useState<number>(200);

  const [uqType, setUqType] = useState<'PD' | 'HM' | 'ACR' | 'GM' | 'FRACTION' | 'INVARIANT'>('PD');
  
  // Specific settings
  const [tCalc, setTCalc] = useState<number>(923);
  const [tMin, setTMin] = useState<number>(300);
  const [tMax, setTMax] = useState<number>(1000);
  const [tStep, setTStep] = useState<number>(10);
  const [xMin, setXMin] = useState<number>(0);
  const [xMax, setXMax] = useState<number>(1);
  const [xStep, setXStep] = useState<number>(0.01);
  
  const [targetPhase, setTargetPhase] = useState<string>('LIQUID');
  const [targetComp, setTargetComp] = useState<string>('MG');
  const [targetPhases, setTargetPhases] = useState<string>('FCC_A1, GAMMA, LIQUID');

  const [selectorConfig, setSelectorConfig] = useState<{ mode: 'file' | 'folder', title: string, field: string } | null>(null);

  // Logs
  const [logs, setLogs] = useState<string[]>([
    "=== [Uncertainty Analysis] Engine Initialized ===",
    "Ready to extract ensemble parameters."
  ]);
  const logRef = useRef<HTMLDivElement>(null);

  // Result
  const [isPlotting, setIsPlotting] = useState(false);
  const [generatedPlot, setGeneratedPlot] = useState<string | null>(null);
  const [showPlotModal, setShowPlotModal] = useState(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const findNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    for (const node of nodes) {
      const nodePath = node.path.startsWith('/') ? node.path : '/' + node.path;
      if (nodePath === cleanPath) return node;
      if (node.children) {
        const found = findNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  const handleGenerate = async () => {
    setIsPlotting(true);
    setGeneratedPlot(null);
    addLog(`\n▶️ Starting Uncertainty Analysis: ${uqType}`);
    addLog(`Extracting ensemble parameters from ${dbFile} (min_score: ${minScore})...`);

    const payload = {
      uq_type: uqType,
      tdb_file: tdbFile,
      db_file: dbFile,
      data_path: dataPath,
      min_score: minScore,
      n_samples: nSamples,
      t_calc: tCalc,
      t_min: tMin,
      t_max: tMax,
      t_step: tStep,
      x_min: xMin,
      x_max: xMax,
      x_step: xStep,
      target_phase: targetPhase,
      target_comp: targetComp,
      target_phases: targetPhases.split(',').map(s => s.trim())
    };

    try {
      const res = await fetch('/plot-uncertainty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (res.ok && data.status === 'success' && data.image) {
        setGeneratedPlot(data.image);
        addLog(`[SUCCESS] Validation plot rendered.`);
      } else {
        addLog(`[ERROR] Backend plot returned error: ${data.detail || data.message || 'Unknown error'}`);
      }
    } catch (e: any) {
      addLog(`[ERROR] Request failed: ${e.message}`);
    } finally {
      setIsPlotting(false);
    }
  };

  const downloadPlot = () => {
    if (!generatedPlot) return;
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${generatedPlot}`;
    link.download = `PDUQ_${uqType}_${Date.now()}.png`;
    link.click();
  };

  const renderConfigFields = () => {
    switch (uqType) {
      case 'PD':
      case 'INVARIANT':
        return (
          <>
            <div className="grid grid-cols-3 gap-2">
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">T Min (K)</label><input type="number" value={tMin} onChange={e => setTMin(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">T Max (K)</label><input type="number" value={tMax} onChange={e => setTMax(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">T Step (K)</label><input type="number" value={tStep} onChange={e => setTStep(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">X Min</label><input type="number" value={xMin} onChange={e => setXMin(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">X Max</label><input type="number" value={xMax} onChange={e => setXMax(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
               <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">X Step</label><input type="number" value={xStep} onChange={e => setXStep(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-slate-300 font-mono" /></div>
            </div>
            {uqType === 'INVARIANT' && (
              <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">Target Phases (Comma separated)</label><input type="text" value={targetPhases} onChange={e => setTargetPhases(e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-amber-300 font-mono" /></div>
            )}
          </>
        );
      case 'HM':
      case 'ACR':
      case 'FRACTION':
        return (
          <>
            <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">Calculate Temp (K)</label><input type="number" value={tCalc} onChange={e => setTCalc(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-emerald-300 font-mono" /></div>
            <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">Target Phase</label><input type="text" value={targetPhase} onChange={e => setTargetPhase(e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-amber-300 font-mono" /></div>
            {uqType === 'ACR' && (
              <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">Target Component</label><input type="text" value={targetComp} onChange={e => setTargetComp(e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-blue-300 font-mono" /></div>
            )}
          </>
        );
      case 'GM':
        return (
          <div className="space-y-1"><label className="text-[8px] text-slate-500 font-bold uppercase">Calculate Temp (K)</label><input type="number" value={tCalc} onChange={e => setTCalc(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-emerald-300 font-mono" /></div>
        );
    }
  };

  return (
    <div className="h-full bg-black p-4 overflow-hidden relative font-sans">
      <div className="grid grid-cols-3 gap-4 h-full items-stretch overflow-hidden">
        
        {/* COLUMN 1: Settings */}
        <div className="col-span-1 flex flex-col space-y-4 overflow-hidden h-full">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 shrink-0 bg-black">
              <Settings size={16} className="text-blue-500 mr-2" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--industrial-text)]">UQ Configuration</h3>
            </header>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
              {/* I/O Section */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Database size={12} className="text-emerald-500" /><span>I/O Mapping</span>
                </div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Input TDB File</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{tdbFile}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'file', title: 'Select TDB', field: 'tdbFile' })} className="p-1.5 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-[var(--industrial-accent)] border border-[var(--industrial-border)]"><Layout size={14} /></button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Input SQLite DB</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono truncate">{dbFile}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'file', title: 'Select SQLite DB', field: 'dbFile' })} className="p-1.5 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-amber-400 border border-[var(--industrial-border)]"><Layout size={14} /></button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Input Data Path</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-400 font-mono truncate">{dataPath}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Select Data Path', field: 'dataPath' })} className="p-1.5 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-emerald-400 border border-[var(--industrial-border)]"><Folder size={14} /></button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Ensemble Params */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Target size={12} className="text-blue-500" /><span>Ensemble Extraction</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Min Score</label><input type="number" value={minScore} onChange={e => setMinScore(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-400 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Max Samples</label><input type="number" value={nSamples} onChange={e => setNSamples(Number(e.target.value))} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-blue-400 font-mono" /></div>
                </div>
              </div>

              {/* Analysis Type */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Activity size={12} className="text-[var(--industrial-accent)]" /><span>Plot Type & Parameters</span>
                </div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[8px] text-slate-600 font-bold uppercase">Analysis Target</label>
                    <select value={uqType} onChange={e => setUqType(e.target.value as any)} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-2 text-[10px] text-white outline-none">
                      <option value="PD">Phase Diagram Uncertainty</option>
                      <option value="HM">Enthalpy Uncertainty</option>
                      <option value="ACR">Activity Uncertainty</option>
                      <option value="GM">Gibbs Energy Uncertainty</option>
                      <option value="FRACTION">Phase Fraction Uncertainty</option>
                      <option value="INVARIANT">Invariant Point Uncertainty</option>
                    </select>
                  </div>
                  
                  {renderConfigFields()}
                </div>
              </div>

              <div className="pt-2">
                <button onClick={handleGenerate} disabled={isPlotting} className="w-full h-12 flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[10px] disabled:opacity-50 disabled:cursor-not-allowed">
                  {isPlotting ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
                  <span>{isPlotting ? 'Generating...' : 'Run Uncertainty Analysis'}</span>
                </button>
              </div>

            </div>
          </div>
        </div>

        {/* COLUMN 2: Log Viewer */}
        <div className="col-span-1 flex flex-col space-y-4 h-full overflow-hidden">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-10 border-b border-[var(--industrial-border)] flex items-center px-4 bg-[#0a0a0a] shrink-0">
              <FileText size={14} className="text-emerald-500 mr-2" />
              <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400">Execution Log</h3>
            </header>
            <div ref={logRef} className="flex-1 p-4 overflow-y-auto custom-scrollbar font-mono text-[10px] text-emerald-500/80 leading-relaxed whitespace-pre-wrap">
              {logs.join('\n')}
            </div>
          </div>
        </div>

        {/* COLUMN 3: Validation View */}
        <div className="col-span-1 flex flex-col h-full bg-black border border-[var(--industrial-border)] shadow-2xl overflow-hidden relative">
          <header className="h-10 border-b border-[var(--industrial-border)] flex items-center justify-center bg-[#0a0a0a] shrink-0">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Validation & Plot Output</span>
          </header>

          <div className="flex-1 border-t border-[var(--industrial-border)] bg-[#050505] flex items-center justify-center relative overflow-hidden group p-4">
             {generatedPlot ? (
                <>
                  <img src={`data:image/png;base64,${generatedPlot}`} className="max-h-full max-w-full object-contain cursor-pointer" onClick={() => setShowPlotModal(true)} />
                  <div className="absolute bottom-4 right-4 flex space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={downloadPlot} className="p-2 bg-black border border-[var(--industrial-border)] hover:bg-[var(--industrial-accent)] hover:text-black text-white transition-colors"><Download size={16} /></button>
                    <button onClick={() => setShowPlotModal(true)} className="p-2 bg-black border border-[var(--industrial-border)] hover:bg-[var(--industrial-accent)] hover:text-black text-white transition-colors"><Maximize2 size={16} /></button>
                  </div>
                </>
             ) : (
               <div className="opacity-20 flex flex-col items-center select-none text-slate-400">
                 <ImageIcon size={48} className="mb-4" />
                 <span className="text-[10px] font-black uppercase tracking-widest text-center max-w-[200px]">
                   {isPlotting ? 'Rendering plot...' : 'Configure parameters on the left and run analysis to view plots'}
                 </span>
               </div>
             )}
          </div>
        </div>

      </div>

      {showPlotModal && generatedPlot && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-12 backdrop-blur-sm">
          <button onClick={() => setShowPlotModal(false)} className="absolute top-8 right-8 p-3 bg-black border border-[var(--industrial-border)] text-white hover:bg-red-600 transition-all"><X size={24} /></button>
          <img src={`data:image/png;base64,${generatedPlot}`} className="max-h-full max-w-full object-contain shadow-[0_0_80px_rgba(0,0,0,0.5)]" />
        </div>
      )}

      {selectorConfig && (
        <FileSelectorModal 
          files={files} mode={selectorConfig.mode} title={selectorConfig.title} onClose={() => setSelectorConfig(null)}
          onConfirm={(path) => {
            if (selectorConfig.field === 'tdbFile') setTdbFile(path as string);
            else if (selectorConfig.field === 'dbFile') setDbFile(path as string);
            else if (selectorConfig.field === 'dataPath') setDataPath(path as string);
            setSelectorConfig(null);
          }}
        />
      )}
    </div>
  );
};

export default UncertaintyAnalysis;
