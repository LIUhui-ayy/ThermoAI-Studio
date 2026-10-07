import React, { useState, useEffect, useRef } from 'react';
import { 
  Database, Folder, Settings, Zap, Play, FileText, CheckCircle2, 
  Hash, Sliders, RefreshCw, Download, Maximize2, 
  FolderOpen, ImageIcon, FileSpreadsheet, X, Layout, Square, HardDriveDownload} from 'lucide-react';
import { FileNode } from '../types';
import FileSelectorModal from './FileSelectorModal';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart, Scatter } from 'recharts';

interface AdvancedOptimizationProps {
  files: FileNode[];
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
}

const AdvancedOptimization: React.FC<AdvancedOptimizationProps> = ({ files, setFiles }) => {
  const [initialTdb, setInitialTdb] = useState<string>('Cu-Mg-generated1.tdb');
  const [datasetFolder, setDatasetFolder] = useState<string>('input-data');
  const [outDbName, setOutDbName] = useState<string>('A25-CU-MG_Final_Optimized.db');
  const [outTdbName, setOutTdbName] = useState<string>('A25-CU-MG_Best_Final.tdb');
  const [axisComp, setAxisComp] = useState<string>('MG');

  const [weights, setWeights] = useState({ HM: 5.0, ACR: 15.0, SM: 0.02, ZPF: 100.0, EXP: 100.0, DFT: 80.0, EST: 20.0, weightLSE: 10.0, weightSum: 0.05, tau: 1000.0 });
  const [thresholds, setThresholds] = useState({ 
    hmSigma: 0.2, 
    smSigma: 0.1, 
    hmMin: 1000.0,
    smMin: 10.0,
    allowedDev: 0.05, 
    maxAllowedDevInitial: 1.0 
  });
  const [iters, setIters] = useState({ total: 20000, annealStart: 2666, annealEnd: 5333, workers: 16, maxTrialsPerRun: 2000 });

  const [selectorConfig, setSelectorConfig] = useState<{ mode: 'file' | 'folder', title: string, field: string } | null>(null);

  // Column 3 Tabs
  const [rightTab, setRightTab] = useState<'validation' | 'monitoring'>('validation');

  // Validation State
  const [activeValidationTab, setActiveValidationTab] = useState<'PD' | 'ACR' | 'HM_MIX' | 'DRIVING_FORCE'>('PD');
  const [vParams, setVParams] = useState({ tMin: 300, tMax: 2000, tStep: 10, targetTemp: 1000, targetPhase: '', targetComp: '' });
  const [validationPhases, setValidationPhases] = useState<string[]>([]);
  const [validationComps, setValidationComps] = useState<string[]>([]);
  const [plotSourceTdbPath, setPlotSourceTdbPath] = useState<string | null>(null);
  const [generatedPlot, setGeneratedPlot] = useState<string | null>(null);
  const [generatedCsv, setGeneratedCsv] = useState<string | null>(null);
  const [isPlotting, setIsPlotting] = useState(false);
  const [viewMode, setViewMode] = useState<'plot' | 'table'>('plot');
  const [showPlotModal, setShowPlotModal] = useState(false);

  const [scoreLog, setScoreLog] = useState<string[]>([
    "=== [Eval ID: INIT] ZPF Score Sources Overview ===",
    "Waiting for optimization to start..."
  ]);
  const [detailLog, setDetailLog] = useState<string[]>([
    "=== [Eval ID: INIT] ZPF Part 3 Detailed Score Tracking ===",
    "System ready..."
  ]);
  const scoreLogRef = useRef<HTMLDivElement>(null);
  const detailLogRef = useRef<HTMLDivElement>(null);

  // Dummy dynamic data for scatter plot
  const [scatterData, setScatterData] = useState<any[]>([]);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const optIntervalRef = useRef<any>(null);

  const handleWeightChange = (key: keyof typeof weights, value: string) => setWeights(prev => ({ ...prev, [key]: parseFloat(value) || 0 }));
  const handleThresholdChange = (key: keyof typeof thresholds, value: string) => setThresholds(prev => ({ ...prev, [key]: parseFloat(value) || 0 }));
  const handleIterChange = (key: keyof typeof iters, value: string) => setIters(prev => ({ ...prev, [key]: parseInt(value, 10) || 0 }));

  useEffect(() => {
    if (scoreLogRef.current) scoreLogRef.current.scrollTop = scoreLogRef.current.scrollHeight;
    if (detailLogRef.current) detailLogRef.current.scrollTop = detailLogRef.current.scrollHeight;
  }, [scoreLog, detailLog]);

  useEffect(() => {
    return () => { if (optIntervalRef.current) clearInterval(optIntervalRef.current); }
  }, []);

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

  useEffect(() => {
    let content = "";
    const activePath = plotSourceTdbPath || initialTdb;
    if (activePath) content = findNodeByPath(files, activePath)?.content || "";

    if (content) {
      const phases: string[] = [];
      const comps: string[] = [];
      content.split('\n').forEach(line => {
        const trimmed = line.trim().toUpperCase();
        if (trimmed.startsWith('PHASE')) phases.push(trimmed.split(/\s+/)[1]);
        if (trimmed.startsWith('ELEMENT')) {
          const el = trimmed.split(/\s+/)[1];
          if (el && el !== 'VA') comps.push(el);
        }
      });
      const uniquePhases = Array.from(new Set(phases)).filter(Boolean).sort();
      const uniqueComps = Array.from(new Set(comps)).filter(Boolean).sort();
      setValidationPhases(uniquePhases);
      setValidationComps(uniqueComps);
      if (!vParams.targetPhase && uniquePhases.length > 0) setVParams(p => ({...p, targetPhase: uniquePhases[0]}));
      if (!vParams.targetComp && uniqueComps.length > 0) setVParams(p => ({...p, targetComp: uniqueComps[0]}));
      setAxisComp(prev => (uniqueComps.length > 0 && !uniqueComps.includes(prev)) ? uniqueComps[0] : prev);
    }
  }, [plotSourceTdbPath, initialTdb, files]);

  const handleGeneratePlot = async (mode: 'plot' | 'table') => {
    let tdbContent = "";
    const activePath = plotSourceTdbPath || initialTdb;
    if (activePath) tdbContent = findNodeByPath(files, activePath)?.content || "";

    if (!tdbContent) {
      setScoreLog(prev => [...prev, "[PLOT ERROR] Invalid TDB Content."]);
      return;
    }

    setIsPlotting(true);
    setViewMode(mode);
    try {
      const datasetContents = []; // In a real app, collect dataset JSONs here
      const response = await fetch('/plot-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tdb_content: tdbContent, 
          datasets: datasetContents, 
          type: activeValidationTab,
          t_min: vParams.tMin, 
          t_max: vParams.tMax, 
          t_step: vParams.tStep,
          temperature: vParams.targetTemp, 
          phase: vParams.targetPhase, 
          target_comp: vParams.targetComp
        })
      });
      if (!response.ok) throw new Error(`Server error`);
      const result = await response.json();
      if (result.status === "success") {
        setGeneratedPlot(result.image);
        setGeneratedCsv(result.csv_data);
      }
    } catch (e) { 
      setScoreLog(prev => [...prev, "[VALIDATION ERROR] Connection failed."]); 
    }
    finally { setIsPlotting(false); }
  };

  const downloadPlot = () => {
    if (!generatedPlot) return;
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${generatedPlot}`;
    link.download = `validation_${activeValidationTab}_${Date.now()}.png`;
    link.click();
  };

  // Sync state with backend
  useEffect(() => {
    const fetchState = async () => {
      try {
        const res = await fetch(`/stream-adv-opt?db_name=${encodeURIComponent(outDbName)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.running) setIsOptimizing(true);
          else setIsOptimizing(false);
          
          if (data.logs && data.logs.length > 0) setScoreLog(data.logs);
          if (data.detail_logs && data.detail_logs.length > 0) setDetailLog(data.detail_logs);
          if (data.scatter && data.scatter.length > 0) setScatterData(data.scatter);
        }
      } catch (e) {
        // Ignore
      }
    };
    
    if (isOptimizing) {
      optIntervalRef.current = setInterval(fetchState, 1000);
    } else {
      if (optIntervalRef.current) clearInterval(optIntervalRef.current);
    }
    
    return () => {
      if (optIntervalRef.current) clearInterval(optIntervalRef.current);
    };
  }, [isOptimizing]);

  const handleStartOpt = async () => {
    if (isOptimizing) return;
    const tdbContent = findNodeByPath(files, initialTdb)?.content || "";
    if (!tdbContent) {
        setScoreLog(prev => [...prev, `[ERROR] Cannot find TDB file '${initialTdb}' in Resource Hub. Please upload or select a valid TDB file first.`]);
        return;
    }
    const folderNode = findNodeByPath(files, datasetFolder);
    if (!folderNode || !folderNode.children || folderNode.children.length === 0) {
        setScoreLog(prev => [...prev, `[ERROR] Cannot find dataset folder '${datasetFolder}' or it is empty. Please upload the folder to Resource Hub.`]);
        return;
    }

    setIsOptimizing(true);
    setScoreLog(prev => [...prev, `[SYSTEM] Starting Multi-Objective Optimization (Writing progress to ${outDbName})...`]);
    
    try {
      await fetch('/run-adv-opt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial_tdb: initialTdb,
          dataset_folder: datasetFolder,
          out_db_name: outDbName,
          out_tdb_name: outTdbName,
          axis_comp: axisComp,
          weights,
          thresholds,
          iters,
          initial_tdb_content: findNodeByPath(files, initialTdb)?.content || "",
          dataset_files: (() => {
            const folderNode = findNodeByPath(files, datasetFolder);
            const dsFiles: {name: string, content: string}[] = [];
            const collectFiles = (node: FileNode, currentPath: string) => {
              if (node.type === 'file' && node.content) {
                dsFiles.push({ name: currentPath ? `${currentPath}/${node.name}` : node.name, content: node.content });
              } else if (node.type === 'folder' && node.children) {
                node.children.forEach(child => {
                  collectFiles(child, currentPath ? `${currentPath}/${node.name}` : node.name);
                });
              }
            };
            if (folderNode && folderNode.children) {
              folderNode.children.forEach(child => collectFiles(child, ""));
            }
            return dsFiles;
          })()
        })
      });
    } catch (e) {
      setScoreLog(prev => [...prev, `[ERROR] Failed to start optimization: ${e}`]);
      setIsOptimizing(false);
    }
  };

  const handleStopOpt = async () => {
    try {
      await fetch('/stop-adv-opt', { method: 'POST' });
    } catch (e) {
      // Ignore
    }
    setIsOptimizing(false);
    setScoreLog(prev => [
      ...prev, 
      "[SYSTEM] Optimization stopped by user. State saved to DB."
    ]);
    // Actually extract best TDB
    handleExtractBest();
  };

  const handleExtractBest = async () => {
    setScoreLog(prev => [
      ...prev, 
      `[SYSTEM] Requesting backend to extract Best TDB to ${outTdbName}...`
    ]);
    try {
      const res = await fetch('/extract-best-adv-opt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial_tdb: initialTdb,
          db_name: outDbName,
          out_tdb_name: outTdbName
        })
      });
      if (res.ok) {
        setScoreLog(prev => [...prev, `[SUCCESS] Best TDB extracted successfully.`]);
      }
    } catch (e) {
      setScoreLog(prev => [...prev, `[ERROR] Failed to extract best TDB.`]);
    }
  };

  const handleCommitToHub = async (targetFolder: string) => {
    setScoreLog(prev => [...prev, `[SYSTEM] Committing results to Resource Hub (${targetFolder})...`]);
    try {
      const res = await fetch('/commit-adv-opt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          db_name: outDbName,
          tdb_name: outTdbName
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success' && data.files) {
          const newNodes: any[] = [];
          for (const [filename, fileData] of Object.entries(data.files)) {
            const destPath = targetFolder === '/' ? `/${filename}` : `${targetFolder.replace(/\/$/, '')}/${filename}`;
            const isBinary = (fileData as any).type === 'base64';
            const fileContent = (fileData as any).content;
            
            let finalContent = fileContent;
            if (isBinary) {
               // Convert base64 to object URL for consistency with other parts of the app
               const byteCharacters = atob(fileContent);
               const byteNumbers = new Array(byteCharacters.length);
               for (let i = 0; i < byteCharacters.length; i++) {
                 byteNumbers[i] = byteCharacters.charCodeAt(i);
               }
               const byteArray = new Uint8Array(byteNumbers);
               const blob = new Blob([byteArray]);
               finalContent = URL.createObjectURL(blob);
            }
            
            newNodes.push({
              id: Math.random().toString(36).substr(2, 9),
              name: filename,
              type: 'file',
              content: finalContent,
              path: destPath
            });
          }
          
          setFiles(prev => {
            const recursiveAdd = (nodes: any[]): any[] => {
              return nodes.map(node => {
                if (node.path === targetFolder) {
                   // Remove existing files with same name
                   const filteredChildren = (node.children || []).filter((c: any) => !newNodes.find(n => n.name === c.name));
                   return { ...node, children: [...filteredChildren, ...newNodes] };
                }
                if (node.children) {
                   return { ...node, children: recursiveAdd(node.children) };
                }
                return node;
              });
            };
            if (targetFolder === '/') {
               const filteredRoot = prev.filter(c => !newNodes.find(n => n.name === c.name));
               return [...filteredRoot, ...newNodes];
            }
            return recursiveAdd(prev);
          });
          setScoreLog(prev => [...prev, `[SUCCESS] ${Object.keys(data.files).length} files committed to Resource Hub.`]);
        } else {
          setScoreLog(prev => [...prev, `[ERROR] Backend returned: ${JSON.stringify(data)}`]);
        }
      } else {
         const errText = await res.text();
         setScoreLog(prev => [...prev, `[ERROR] Failed to commit results. Status: ${res.status} ${res.statusText}. Response: ${errText.substring(0, 100)}`]);
      }
    } catch (e) {
      setScoreLog(prev => [...prev, `[ERROR] Failed to commit results: ${e}`]);
    }
  };

  return (
    <div className="h-full bg-black p-4 overflow-hidden relative font-sans">
      <div className="grid grid-cols-3 gap-4 h-full items-stretch overflow-hidden">
        
        {/* COLUMN 1: Configuration Settings */}
        <div className="col-span-1 flex flex-col space-y-4 overflow-hidden h-full">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 shrink-0 bg-black">
              <Settings size={16} className="text-[var(--industrial-accent)] mr-2" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--industrial-text)]">Opt Configuration</h3>
            </header>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
              {/* I/O Section */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Database size={12} className="text-[var(--industrial-accent)]" /><span>I/O Mapping</span>
                </div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Initial TDB File</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{initialTdb}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'file', title: 'Select TDB', field: 'initialTdb' })} className="p-1.5 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-[var(--industrial-accent)] border border-[var(--industrial-border)] transition-all"><Layout size={14} /></button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Dataset Folder</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono truncate">{datasetFolder}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Select Datasets', field: 'datasetFolder' })} className="p-1.5 bg-[#1a1a1a] hover:bg-[#2a2a2a] text-amber-400 border border-[var(--industrial-border)] transition-all"><FolderOpen size={14} /></button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Output SQLite DB (Resume Sync)</label>
                    <input type="text" className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-slate-300 font-mono outline-none" value={outDbName} onChange={e => setOutDbName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Best TDB Output Name</label>
                    <input type="text" className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-400 font-mono outline-none" value={outTdbName} onChange={e => setOutTdbName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Axis Component (for ZPF evaluation)</label>
                    <select className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-blue-400 font-mono outline-none" value={axisComp} onChange={e => setAxisComp(e.target.value)}>
                      {validationComps.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {/* Algorithm Scheduling */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Hash size={12} className="text-blue-500" /><span>Algorithm Scheduling</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="col-span-2 space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Total Trials</label><input type="number" value={iters.total} onChange={e => handleIterChange('total', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-blue-400 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Dask Workers</label><input type="number" value={iters.workers} onChange={e => handleIterChange('workers', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-slate-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Max Trials / Run</label><input type="number" value={iters.maxTrialsPerRun} onChange={e => handleIterChange('maxTrialsPerRun', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-slate-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Anneal Start</label><input type="number" value={iters.annealStart} onChange={e => handleIterChange('annealStart', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-slate-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Anneal End</label><input type="number" value={iters.annealEnd} onChange={e => handleIterChange('annealEnd', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-slate-300 font-mono" /></div>
                </div>
              </div>

              {/* Settings & Thresholds */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Sliders size={12} className="text-emerald-500" /><span>Settings & Thresholds</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Max Allowed Dev Init (%)</label><input type="number" step="0.1" value={thresholds.maxAllowedDevInitial} onChange={e => handleThresholdChange('maxAllowedDevInitial', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Min Allowed Dev End (%)</label><input type="number" step="0.01" value={thresholds.allowedDev} onChange={e => handleThresholdChange('allowedDev', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">HM Search Expand Factor</label><input type="number" step="0.01" value={thresholds.hmSigma} onChange={e => handleThresholdChange('hmSigma', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">SM Search Expand Factor</label><input type="number" step="0.01" value={thresholds.smSigma} onChange={e => handleThresholdChange('smSigma', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">HM Search Min (±)</label><input type="number" step="10" value={thresholds.hmMin} onChange={e => handleThresholdChange('hmMin', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">SM Search Min (±)</label><input type="number" step="1" value={thresholds.smMin} onChange={e => handleThresholdChange('smMin', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                </div>
              </div>

              {/* Weights */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Sliders size={12} className="text-emerald-500" /><span>Weights (W_PROP, W_SRC & ZPF penalties)</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">HM</label><input type="number" value={weights.HM} onChange={e => handleWeightChange('HM', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ACR</label><input type="number" value={weights.ACR} onChange={e => handleWeightChange('ACR', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">SM</label><input type="number" step="0.01" value={weights.SM} onChange={e => handleWeightChange('SM', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF</label><input type="number" value={weights.ZPF} onChange={e => handleWeightChange('ZPF', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">EXP</label><input type="number" value={weights.EXP} onChange={e => handleWeightChange('EXP', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">DFT</label><input type="number" value={weights.DFT} onChange={e => handleWeightChange('DFT', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">EST</label><input type="number" value={weights.EST} onChange={e => handleWeightChange('EST', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  
                  <div className="col-span-2 pt-2 border-t border-[var(--industrial-border)] mt-2"></div>
                  
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF LSE Weight</label><input type="number" step="1" value={weights.weightLSE} onChange={e => handleWeightChange('weightLSE', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF SUM Weight</label><input type="number" step="0.01" value={weights.weightSum} onChange={e => handleWeightChange('weightSum', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF LSE TAU</label><input type="number" step="100" value={weights.tau} onChange={e => handleWeightChange('tau', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                </div>
              </div>

              {/* Action Buttons */}

              <div className="space-y-3 pt-2">
                {isOptimizing ? (
                  <button onClick={handleStopOpt} className="w-full h-12 flex items-center justify-center space-x-2 bg-red-600 hover:bg-red-700 text-white rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[10px]">
                    <Square size={16} /><span>Stop & Extract Best TDB</span>
                  </button>
                ) : (
                  <button onClick={handleStartOpt} className="w-full h-12 flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[10px]">
                    <Play size={16} /><span>Launch / Resume Optuna</span>
                  </button>
                )}
                
                <button onClick={handleExtractBest} className="w-full h-12 flex items-center justify-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[10px]">
                  <CheckCircle2 size={16} /><span>Extract Best TDB Manually</span>
                </button>
                <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Commit to Resource Hub', field: 'adv_save' })} className="w-full h-12 flex items-center justify-center space-x-2 bg-purple-600 hover:bg-purple-700 text-white rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[10px]">
                  <HardDriveDownload size={16} /><span>Commit Results to Hub</span>
                </button>
              </div>

            </div>
          </div>
        </div>

        {/* COLUMN 2: Split Log Viewer */}
        <div className="col-span-1 flex flex-col space-y-4 h-full overflow-hidden">
          {/* Top Log: Score Summary */}
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-10 border-b border-[var(--industrial-border)] flex items-center px-4 bg-[#0a0a0a] shrink-0">
              <FileText size={14} className="text-amber-500 mr-2" />
              <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400">Score Summary Log</h3>
            </header>
            <div ref={scoreLogRef} className="flex-1 p-4 overflow-y-auto custom-scrollbar font-mono text-[10px] text-amber-500/80 leading-relaxed whitespace-pre-wrap">
              {scoreLog.join('\n')}
            </div>
          </div>
          
          {/* Bottom Log: Phase Details */}
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-10 border-b border-[var(--industrial-border)] flex items-center px-4 bg-[#0a0a0a] shrink-0">
              <FileText size={14} className="text-emerald-500 mr-2" />
              <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400">Phase Details Log</h3>
            </header>
            <div ref={detailLogRef} className="flex-1 p-4 overflow-y-auto custom-scrollbar font-mono text-[10px] text-emerald-500/80 leading-relaxed whitespace-pre-wrap">
              {detailLog.join('\n')}
            </div>
          </div>
        </div>

        {/* COLUMN 3: Validation & Dynamic Observation Toggles */}
        <div className="col-span-1 flex flex-col h-full bg-black border border-[var(--industrial-border)] shadow-2xl overflow-hidden relative">
          <header className="h-10 border-b border-[var(--industrial-border)] flex items-center bg-[#0a0a0a] shrink-0">
            <button 
              onClick={() => setRightTab('validation')} 
              className={`flex-1 h-full flex items-center justify-center text-[9px] font-black uppercase tracking-widest transition-all border-b-2 ${rightTab === 'validation' ? 'border-[var(--industrial-accent)] text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' : 'border-transparent text-slate-600 hover:text-slate-400'}`}
            >
              Validation Center
            </button>
            <button 
              onClick={() => setRightTab('monitoring')} 
              className={`flex-1 h-full flex items-center justify-center text-[9px] font-black uppercase tracking-widest transition-all border-b-2 ${rightTab === 'monitoring' ? 'border-blue-500 text-blue-500 bg-blue-500/10' : 'border-transparent text-slate-600 hover:text-slate-400'}`}
            >
              Parameter Tracing
            </button>
          </header>

          <div className="flex-1 overflow-hidden relative">
            {rightTab === 'validation' && (
              <div className="absolute inset-0 flex flex-col bg-black">
                <header className="h-8 border-b border-[var(--industrial-border)] flex items-center bg-[#0a0a0a] shrink-0">
                  {(['PD', 'ACR', 'HM_MIX', 'DRIVING_FORCE'] as const).map(t => (
                    <button 
                      key={t} 
                      onClick={() => { setActiveValidationTab(t); setGeneratedPlot(null); setGeneratedCsv(null); setViewMode('plot'); }} 
                      className={`flex-1 h-full flex items-center justify-center text-[8px] font-black uppercase tracking-widest transition-all border-r border-[var(--industrial-border)] last:border-none ${activeValidationTab === t ? 'text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' : 'text-slate-600 hover:text-slate-400'}`}
                    >
                      {t === 'PD' ? 'PD' : t === 'ACR' ? 'ACR' : t === 'HM_MIX' ? 'HM' : 'DF'}
                    </button>
                  ))}
                </header>
                
                <div className="p-4 space-y-3 overflow-y-auto custom-scrollbar flex-1 flex flex-col">
                  <div className="grid grid-cols-2 gap-2 shrink-0">
                    <div className="col-span-2 flex items-center space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] px-2 py-1 text-[9px] text-[var(--industrial-accent)] font-mono truncate">{plotSourceTdbPath || initialTdb || 'Select TDB...'}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'file', title: 'Validation TDB', field: 'plot_tdb' })} className="p-1.5 bg-[#1a1a1a] border border-[var(--industrial-border)] hover:bg-[#2a2a2a] text-[var(--industrial-accent)] transition-all"><RefreshCw size={12} /></button>
                    </div>

                    {(activeValidationTab === 'PD' || activeValidationTab === 'DRIVING_FORCE') ? (
                      <>
                        <div className="space-y-1"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Min (K)</label><input type="number" value={vParams.tMin} onChange={e => setVParams(p => ({...p, tMin: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-[var(--industrial-accent)] outline-none" /></div>
                        <div className="space-y-1"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Max (K)</label><input type="number" value={vParams.tMax} onChange={e => setVParams(p => ({...p, tMax: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-[var(--industrial-accent)] outline-none" /></div>
                        <div className="space-y-1"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Step (K)</label><input type="number" value={vParams.tStep} onChange={e => setVParams(p => ({...p, tStep: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-[var(--industrial-accent)] outline-none" /></div>
                      </>
                    ) : (
                      <>
                        <div className="space-y-1"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">Temp (K)</label><input type="number" value={vParams.targetTemp} onChange={e => setVParams(p => ({...p, targetTemp: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-[var(--industrial-accent)] outline-none" /></div>
                        <div className="space-y-1">
                          <label className="text-[8px] font-black text-slate-600 uppercase ml-1">Phase</label>
                          <select value={vParams.targetPhase} onChange={e => setVParams(p => ({...p, targetPhase: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-amber-400 outline-none">
                            {validationPhases.map(ph => <option key={ph} value={ph}>{ph}</option>)}
                          </select>
                        </div>
                        {activeValidationTab === 'ACR' && (
                          <div className="space-y-1">
                            <label className="text-[8px] font-black text-slate-600 uppercase ml-1">Comp</label>
                            <select value={vParams.targetComp} onChange={e => setVParams(p => ({...p, targetComp: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] px-2 py-1 text-[10px] text-emerald-400 outline-none">
                              {validationComps.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        )}
                      </>
                    )}
                    
                    <div className="col-span-2 flex space-x-2 pt-1">
                      <button onClick={() => handleGeneratePlot('plot')} disabled={isPlotting} className="flex-1 h-8 flex items-center justify-center space-x-1 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 text-black font-black uppercase text-[8px]">
                        <Zap size={10} /><span>Generate Map</span>
                      </button>
                      <button onClick={() => setViewMode(viewMode === 'plot' ? 'table' : 'plot')} disabled={!generatedCsv} className={`px-3 h-8 flex items-center justify-center space-x-1 font-black uppercase text-[8px] border ${viewMode === 'table' ? 'bg-amber-600 text-white border-amber-500' : 'bg-[#1a1a1a] text-slate-400 border-[var(--industrial-border)]'}`}>
                        {viewMode === 'table' ? <ImageIcon size={10} /> : <FileSpreadsheet size={10} />}<span>{viewMode === 'table' ? 'Plot' : 'Data'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Validation Image Display */}
                  <div className="flex-1 border border-[var(--industrial-border)] bg-[#050505] flex items-center justify-center relative min-h-[150px] overflow-hidden group">
                     {generatedPlot || generatedCsv ? (
                        viewMode === 'plot' ? (
                          <>
                            <img src={`data:image/png;base64,${generatedPlot}`} className="max-h-full max-w-full object-contain" onClick={() => setShowPlotModal(true)} />
                            <div className="absolute bottom-2 right-2 flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={downloadPlot} className="p-1.5 bg-black/80 hover:bg-[var(--industrial-accent)] text-white"><Download size={14} /></button>
                              <button onClick={() => setShowPlotModal(true)} className="p-1.5 bg-black/80 hover:bg-[var(--industrial-accent)] text-white"><Maximize2 size={14} /></button>
                            </div>
                          </>
                        ) : (
                          <div className="w-full h-full p-2 overflow-auto custom-scrollbar font-mono text-[8px] text-emerald-400/90 whitespace-pre">
                            {generatedCsv}
                          </div>
                        )
                     ) : (
                       <div className="opacity-10 flex flex-col items-center select-none"><ImageIcon size={40} /><span className="text-[10px] font-black uppercase tracking-widest mt-2">Idle</span></div>
                     )}
                  </div>
                </div>
              </div>
            )}

            {rightTab === 'monitoring' && (
              <div className="absolute inset-0 flex flex-col p-3 bg-[#050505]">
                <div className="flex items-center justify-between mb-3 shrink-0">
                   <div className="flex items-center space-x-2">
                      <span className={`w-2 h-2 rounded-full ${isOptimizing ? 'bg-blue-500 animate-pulse' : 'bg-slate-600'}`} />
                      <span className={`text-[10px] font-black uppercase ${isOptimizing ? 'text-blue-500' : 'text-slate-500'}`}>{isOptimizing ? 'Tracing Active' : 'Tracing Paused'}</span>
                   </div>
                </div>
                <div className="flex-1 grid grid-rows-2 gap-4 h-full overflow-hidden">
                   {/* Row 1: Score Trajectory */}
                   <div className="border border-[var(--industrial-border)] bg-black p-2 flex flex-col relative h-full">
                      <span className="absolute top-2 left-2 text-[8px] font-black text-slate-500 uppercase z-10">Global Score</span>
                      <div className="flex-1 w-full h-full min-h-0 pt-6">
                        {scatterData.length === 0 ? (
                           <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-slate-600">Waiting for tracing data...</div>
                        ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <ScatterChart margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                            <XAxis type="number" dataKey="trial" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono' }} domain={['dataMin', 'dataMax']} />
                            <YAxis type="number" dataKey="score" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', borderRadius: '0px', fontFamily: 'JetBrains Mono', fontSize: '10px' }} />
                            <Scatter name="Score" data={scatterData} fill="#3b82f6" line={{stroke: '#3b82f6', strokeWidth: 1}} shape="circle" />
                          </ScatterChart>
                        </ResponsiveContainer>
                        )}
                      </div>
                   </div>
                   {/* Row 2: Parameters Trajectory */}
                   <div className="border border-[var(--industrial-border)] bg-black p-2 flex flex-col relative h-full">
                      <span className="absolute top-2 left-2 text-[8px] font-black text-slate-500 uppercase z-10">Parameter Trajectories</span>
                      <div className="flex-1 w-full h-full min-h-0 pt-6 overflow-y-auto custom-scrollbar">
                        {scatterData.length === 0 ? (
                           <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-slate-600">Waiting for tracing data...</div>
                        ) : (
                           <div className="grid grid-cols-2 gap-4">
                             {Object.keys(scatterData[0]).filter(k => k !== 'trial' && k !== 'score').map((key, i) => (
                               <div key={key} className="h-40 border border-[#334155] p-1 relative">
                                 <span className="absolute top-1 right-2 text-[8px] font-mono text-slate-400 z-10">{key}</span>
                                 <ResponsiveContainer width="100%" height="100%">
                                   <LineChart data={scatterData} margin={{ top: 15, right: 5, left: 0, bottom: 0 }}>
                                     <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                     <XAxis type="number" dataKey="trial" stroke="#475569" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'JetBrains Mono' }} domain={['dataMin', 'dataMax']} />
                                     <YAxis stroke="#475569" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'JetBrains Mono' }} domain={['auto', 'auto']} width={35} />
                                     <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', borderRadius: '0px', fontFamily: 'JetBrains Mono', fontSize: '9px' }} />
                                     <Line type="monotone" dataKey={key} stroke={`hsl(${(i * 137.508) % 360}, 70%, 50%)`} dot={false} strokeWidth={1.5} name={key} isAnimationActive={false} />
                                   </LineChart>
                                 </ResponsiveContainer>
                               </div>
                             ))}
                           </div>
                        )}
                      </div>
                   </div>
                </div>
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
            if (selectorConfig.field === 'initialTdb') setInitialTdb(path as string);
            else if (selectorConfig.field === 'datasetFolder') setDatasetFolder(path as string);
            else if (selectorConfig.field === 'plot_tdb') setPlotSourceTdbPath(path as string);
            else if (selectorConfig.field === 'adv_save') handleCommitToHub(path as string);
            setSelectorConfig(null);
          }}
        />
      )}
    </div>
  );
};

export default AdvancedOptimization;
