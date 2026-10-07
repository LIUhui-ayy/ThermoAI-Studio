import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Save, Database, Play, Terminal, FileCode, Plus, 
  Trash2, BarChart3, Download, Layout, 
  Zap, Loader2, Monitor,
  Settings, FileText, Activity, X, ImageIcon,
  SlidersHorizontal, Gauge, AlertCircle, CheckCircle2,
  Fingerprint, ToggleLeft, ToggleRight, FileWarning, Search,
  ChevronRight, RefreshCw, Layers, DatabaseZap, HardDrive,
  Target, Thermometer, BoxSelect, FolderOpen, FileSearch,
  ZapOff, FileSpreadsheet, Eye, ShieldAlert, ClipboardCheck, Info,
  FolderPlus, Copy, Maximize2
} from 'lucide-react';
import { ESPEIConfig, FileNode, AICcPenalty } from '../types';
import FileSelectorModal from './FileSelectorModal';

interface IntegrityError {
  fileName: string;
  message: string;
}

interface IntegrityReport {
  total: number;
  passed: number;
  errors: number;
  logs: IntegrityError[];
}

interface WizardProps {
  config: ESPEIConfig;
  setConfig: React.Dispatch<React.SetStateAction<ESPEIConfig>>;
  files: FileNode[];
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
}

const Wizard: React.FC<WizardProps> = ({ config, setConfig, files, setFiles }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [engineStatus, setEngineStatus] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [generatedTDB, setGeneratedTDB] = useState<string | null>(null);
  const [generatedLog, setGeneratedLog] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  const [plotSourceTdbPath, setPlotSourceTdbPath] = useState<string | null>('INTERNAL_CURRENT');
  const [plotSourceDsPath, setPlotSourceDsPath] = useState<string | null>(null);
  const [validationPhases, setValidationPhases] = useState<string[]>([]);
  const [validationComps, setValidationComps] = useState<string[]>([]);
  
  const [exportName, setExportName] = useState(config.output.output_db || 'GEN-INIT.tdb');
  const [pythonPath, setPythonPath] = useState(() => localStorage.getItem('espei_python_path') || '');
  const [useOptimizationTags, setUseOptimizationTags] = useState(() => config.system.tags && Object.keys(config.system.tags).length > 0);
  
  const [activeValidationTab, setActiveValidationTab] = useState<'PD' | 'ACR' | 'HM_MIX' | 'DRIVING_FORCE'>('PD');
  const [generatedPlot, setGeneratedPlot] = useState<string | null>(null);
  const [generatedCsv, setGeneratedCsv] = useState<string | null>(null);
  const [isPlotting, setIsPlotting] = useState(false);
  const [showPlotModal, setShowPlotModal] = useState(false);
  const [viewMode, setViewMode] = useState<'plot' | 'table'>('plot');

  // Integrity Check State
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport>({ total: 0, passed: 0, errors: 0, logs: [] });
  const [isValidating, setIsValidating] = useState(false);
  
  // MANDATORY PRESERVATION: Panel 3 Variables (Red Line Defense)
  const [vParams, setVParams] = useState({
    tMin: 300,
    tMax: 2000,
    tStep: 10,
    targetTemp: 1000,
    targetPhase: '',
    targetComp: ''
  });

  const [selectorConfig, setSelectorConfig] = useState<{ mode: 'file' | 'folder' | 'multi-file', title: string, field: 'phase_models' | 'datasets' | 'save_location' | 'plot_tdb' | 'plot_ds' | 'save_artifact' } | null>(null);
  const [middleTab, setMiddleTab] = useState<'tdb' | 'log'>('tdb');

  // Extract phases from current phase model for AICc selection
  const pmPhases = useMemo(() => {
    const node = findNodeByPath(files, config.system.phase_models);
    if (!node || !node.content) return [];
    try {
      const pm = JSON.parse(node.content);
      return Object.keys(pm.phases || {}).sort();
    } catch { return []; }
  }, [config.system.phase_models, files]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs]);

  function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
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
  }

  useEffect(() => {
    let content = "";
    if (plotSourceTdbPath === 'INTERNAL_CURRENT') content = generatedTDB || "";
    else if (plotSourceTdbPath) content = findNodeByPath(files, plotSourceTdbPath)?.content || "";

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
      
      // Auto-init params if empty
      if (!vParams.targetPhase && uniquePhases.length > 0) setVParams(p => ({...p, targetPhase: uniquePhases[0]}));
      if (!vParams.targetComp && uniqueComps.length > 0) setVParams(p => ({...p, targetComp: uniqueComps[0]}));
    }
  }, [plotSourceTdbPath, generatedTDB, files]);

  const collectFolderDatasets = (path: string): { content: any, name: string }[] => {
    const contents: { content: any, name: string }[] = [];
    const folderNode = findNodeByPath(files, path);
    if (!folderNode) return contents;
    const traverse = (n: FileNode) => {
      if (n.type === 'file' && n.name.toLowerCase().endsWith('.json') && n.content) {
        try { 
          const parsed = JSON.parse(n.content); 
          if (parsed.output || parsed.values || parsed.reference) {
            contents.push({ content: parsed, name: n.name }); 
          }
        } catch (e) { }
      }
      if (n.children) n.children.forEach(traverse);
    };
    traverse(folderNode);
    return contents;
  };

  const handleCheckIntegrity = () => {
    const pmPath = config.system.phase_models;
    const dsPath = Array.isArray(config.system.datasets) ? config.system.datasets[0] : (config.system.datasets as string);
    
    if (!pmPath) {
      setLogs(prev => [...prev, "[CHECK] Error: No Phase Model selected."]);
      return;
    }

    setIsValidating(true);
    const pmNode = findNodeByPath(files, pmPath);
    if (!pmNode || !pmNode.content) {
      setLogs(prev => [...prev, "[CHECK] Error: Phase Model content empty or missing."]);
      setIsValidating(false);
      return;
    }

    try {
      const pm = JSON.parse(pmNode.content);
      const pmComponents = new Set((pm.components || []).map((c: string) => c.toUpperCase()));
      const pmPhases = new Set(Object.keys(pm.phases || {}).map(p => p.toUpperCase()));

      const datasetObjects = collectFolderDatasets(dsPath || "/espei_datasets");
      const logs: IntegrityError[] = [];
      let passedCount = 0;

      datasetObjects.forEach(({ content: ds, name }) => {
        try {
          const dsComponents = (ds.components || []).map((c: string) => c.toUpperCase());
          if (dsComponents.filter((c: string) => !pmComponents.has(c) && c !== 'VA').length > 0) throw new Error(`Missing components in Phase Model.`);
          if ((ds.phases || []).filter((p: string) => !pmPhases.has(p.toUpperCase())).length > 0) throw new Error(`Missing phases in Phase Model.`);
          passedCount++;
        } catch (e: any) {
          logs.push({ fileName: name, message: e.message });
        }
      });

      setIntegrityReport({ total: datasetObjects.length, passed: passedCount, errors: logs.length, logs });
      setLogs(prev => [...prev, `[CHECK] Integrity validation complete. ${passedCount}/${datasetObjects.length} passed.`]);
    } catch (e: any) {
      setLogs(prev => [...prev, `[CHECK] Critical error: ${e.message}`]);
    } finally {
      setIsValidating(false);
    }
  };

  const addAICcRow = () => {
    const newRow: AICcPenalty = { phase: pmPhases[0] || 'PHASE', hm: 1.0, sm: 1.0 };
    setConfig(prev => ({
      ...prev,
      generate_parameters: {
        ...prev.generate_parameters!,
        aicc_penalty: [...(prev.generate_parameters?.aicc_penalty || []), newRow]
      }
    }));
  };

  const updateAICcRow = (index: number, field: keyof AICcPenalty, value: any) => {
    setConfig(prev => {
      const nextPenalties = [...(prev.generate_parameters?.aicc_penalty || [])];
      nextPenalties[index] = { ...nextPenalties[index], [field]: value };
      return {
        ...prev,
        generate_parameters: { ...prev.generate_parameters!, aicc_penalty: nextPenalties }
      };
    });
  };

  const removeAICcRow = (index: number) => {
    setConfig(prev => ({
      ...prev,
      generate_parameters: {
        ...prev.generate_parameters!,
        aicc_penalty: prev.generate_parameters?.aicc_penalty.filter((_, i) => i !== index) || []
      }
    }));
  };

  const handleToggleTags = (enabled: boolean) => {
    setUseOptimizationTags(enabled);
    setConfig(prev => ({
      ...prev,
      system: {
        ...prev.system,
        tags: enabled ? { 
          'dft': 'DEFAULT', 
          'estimated-entropy': 'DEFAULT' 
        } : {}
      }
    }));
  };

  const liveYamlPreview = useMemo(() => {
    const lines: string[] = [];
    lines.push("system:");
    lines.push(`  phase_models: phase_models.json`);
    lines.push(`  datasets: datasets`);
    
    if (useOptimizationTags) {
      lines.push("  tags:");
      lines.push("    dft:");
      lines.push("      excluded_model_contributions:");
      lines.push("        - idmix");
      lines.push("        - mag");
      lines.push("    estimated-entropy:");
      lines.push("      excluded_model_contributions:");
      lines.push("        - idmix");
      lines.push("        - mag");
      lines.push("      weight: 0.1");
    }
    
    lines.push("");
    lines.push("output:");
    lines.push(`  output_db: ${config.output.output_db}`);
    lines.push(`  verbosity: 2`);
    lines.push(`  logfile: ${config.output.logfile}`);
    
    lines.push("");
    lines.push("generate_parameters:");
    lines.push(`  ref_state: ${config.generate_parameters?.ref_state || 'SGTE91'}`);
    lines.push(`  excess_model: ${config.generate_parameters?.excess_model || 'linear'}`);
    
    if (config.generate_parameters?.aicc_penalty && config.generate_parameters.aicc_penalty.length > 0) {
      lines.push("  aicc_penalty_factor:");
      config.generate_parameters.aicc_penalty.forEach(p => {
        lines.push(`    ${p.phase}:`);
        lines.push(`      HM: ${p.hm.toFixed(1)}`);
        lines.push(`      SM: ${p.sm.toFixed(1)}`);
      });
    }

    if (integrityReport.errors > 0) {
      return `# WARNING: Dataset inconsistencies detected.\n` + lines.join("\n");
    }

    return lines.join("\n");
  }, [config, integrityReport.errors, useOptimizationTags]);

  const runFitting = async () => {
    if (!config.system.phase_models) return;
    
    setIsProcessing(true);
    setMiddleTab('log'); 
    setLogs(prev => [...prev, "[ENGINE] Initializing high-fidelity fitting sequence..."]);
    setEngineStatus("Optimizing...");
    
    try {
      const pmNode = findNodeByPath(files, config.system.phase_models);
      if (!pmNode || !pmNode.content) throw new Error("Phase model content is missing.");
      
      const dsPath = Array.isArray(config.system.datasets) ? config.system.datasets[0] : config.system.datasets;
      const datasetEntries = collectFolderDatasets(dsPath || "/espei_datasets");
      const datasetContents = datasetEntries.map(d => d.content);

      setLogs(prev => [...prev, `[ENGINE] Collected ${datasetContents.length} datasets for optimization.`]);
      
      // Map penalties to the dictionary expected by bridge.py
      const penaltyFactor: Record<string, { HM: number, SM: number }> = {};
      config.generate_parameters?.aicc_penalty.forEach(p => {
        penaltyFactor[p.phase.toUpperCase()] = { HM: p.hm, SM: p.sm };
      });

      // RESTORED: Strictly following structured payload red line
      const response = await fetch('/run-espei', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase_model: JSON.parse(pmNode.content),
          datasets: datasetContents,
          config: {
            ref_state: config.generate_parameters?.ref_state || 'SGTE91',
            output_db: config.output.output_db,
            excess_model: config.generate_parameters?.excess_model || 'linear',
            use_tags: useOptimizationTags,
            aicc_penalty_factor: penaltyFactor
          }
        })
      });
      
      if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      let result;
      try {
          result = JSON.parse(text);
      } catch (e) {
          throw new Error("Invalid JSON response from server.");
      }
      
      if (result.status === "success") {
        setGeneratedTDB(result.tdb);
        setGeneratedLog(result.log);
        setLogs(prev => [...prev, "[ENGINE] Optimization complete. TDB generated.", "[ENGINE] High-fidelity log received."]);
        setEngineStatus("Complete");
      } else { 
        setLogs(prev => [...prev, `[ENGINE ERROR] ${result.message || 'Fitting failed'}`]);
        if (result.log) setGeneratedLog(result.log);
        setEngineStatus("Failed"); 
      }
    } catch (err: any) { 
      setLogs(prev => [...prev, `[CRITICAL ERROR] ${err.message}`]);
      setEngineStatus("Offline"); 
    } finally { 
      setIsProcessing(false); 
    }
  };

  const handleGeneratePlot = async (mode: 'plot' | 'table') => {
    let tdbContent = "";
    if (plotSourceTdbPath === 'INTERNAL_CURRENT') tdbContent = generatedTDB || "";
    else if (plotSourceTdbPath) tdbContent = findNodeByPath(files, plotSourceTdbPath)?.content || "";

    if (!tdbContent) {
      setLogs(prev => [...prev, "[PLOT ERROR] Invalid TDB content."]);
      return;
    }

    setIsPlotting(true);
    setViewMode(mode);
    try {
      const rawDsPath = plotSourceDsPath || (Array.isArray(config.system.datasets) ? config.system.datasets[0] : config.system.datasets as string) || "/espei_datasets";
      const datasetContents = collectFolderDatasets(rawDsPath).map(d => d.content);
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
      if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      let result;
      try {
          result = JSON.parse(text);
      } catch (e) {
          throw new Error("Invalid JSON response from server.");
      }
      
      if (result.status === "success") {
        setGeneratedPlot(result.image);
        setGeneratedCsv(result.csv_data);
      } else {
        setLogs(prev => [...prev, `[VALIDATION ERROR] ${result.message}`]);
      }
    } catch (e) { setLogs(prev => [...prev, "[VALIDATION ERROR] Connection failed."]); }
    finally { setIsPlotting(false); }
  };

  const handleSaveToResourceHub = (targetFolderPath: string) => {
    if (!generatedTDB && !generatedLog) return;

    const baseName = exportName.replace(/\.tdb$/i, "");
    const tdbName = exportName.toLowerCase().endsWith(".tdb") ? exportName : `${exportName}.tdb`;
    const logName = `${baseName}.log`;

    const newTdbFile: FileNode = {
      id: Math.random().toString(36).substr(2, 9),
      name: tdbName,
      type: 'file',
      path: `${targetFolderPath === '/' ? '' : targetFolderPath}/${tdbName}`,
      content: generatedTDB || ""
    };

    const newLogFile: FileNode = {
      id: Math.random().toString(36).substr(2, 9),
      name: logName,
      type: 'file',
      path: `${targetFolderPath === '/' ? '' : targetFolderPath}/${logName}`,
      content: generatedLog || ""
    };

    setFiles(prev => {
      const updated = JSON.parse(JSON.stringify(prev)) as FileNode[];
      const findAndInsert = (nodes: FileNode[]): boolean => {
        for (let node of nodes) {
          if (node.path === targetFolderPath && node.type === 'folder') {
            node.children = [...(node.children || []), newTdbFile, newLogFile];
            return true;
          }
          if (node.children && findAndInsert(node.children)) return true;
        }
        return false;
      };
      findAndInsert(updated);
      return updated;
    });

    setLogs(prev => [...prev, `[SYSTEM] TDB and Log successfully saved to Hub at ${targetFolderPath}.`]);
    setSelectorConfig(null);
  };

  const downloadPlot = () => {
    if (!generatedPlot) return;
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${generatedPlot}`;
    link.download = `validation_${activeValidationTab}_${Date.now()}.png`;
    link.click();
  };

  return (
    <div className="h-full bg-black overflow-hidden p-4">
      <div className="h-full grid grid-cols-4 gap-4 items-stretch overflow-hidden">
        
        {/* PANEL 1: Specification (25%) */}
        <div className="col-span-1 flex flex-col space-y-4 overflow-hidden h-full">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none overflow-hidden shadow-2xl">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 shrink-0 bg-black">
              <SlidersHorizontal size={16} className="text-[var(--industrial-accent)] mr-2" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--industrial-text)]">Fitting Workspace</h3>
            </header>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6 scroll-smooth">
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Terminal size={12} className="text-[var(--industrial-accent)]" /><span>Environment</span></div>
                <input type="text" value={pythonPath} onChange={(e) => setPythonPath(e.target.value)} placeholder="Interpreter path..." className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" />
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Database size={12} className="text-amber-500" /><span>Scientific Hub</span></div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Phase Model</label>
                    <div className="flex space-x-2"><div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{config.system.phase_models || 'None'}</div><button onClick={() => setSelectorConfig({ mode: 'file', title: 'Phase Model', field: 'phase_models' })} className="p-1.5 bg-[#1a1a1a] rounded-none text-[var(--industrial-accent)] hover:bg-[#2a2a2a] transition-all"><Layout size={14} /></button></div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase">Datasets Folder</label>
                    <div className="flex space-x-2"><div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-amber-300 font-mono truncate">{Array.isArray(config.system.datasets) ? config.system.datasets[0] : (config.system.datasets as string) || 'None'}</div><button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Datasets', field: 'datasets' })} className="p-1.5 bg-[#1a1a1a] rounded-none text-amber-400 hover:bg-[#2a2a2a] transition-all"><Monitor size={14} /></button></div>
                  </div>
                  <div className="pt-2">
                    <button onClick={handleCheckIntegrity} disabled={isValidating || !config.system.phase_models} className="w-full py-2 bg-[var(--industrial-accent)]/10 hover:bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)] text-[9px] font-bold rounded-none border border-[var(--industrial-accent)]/20 transition-all flex items-center justify-center space-x-2">
                      {isValidating ? <Loader2 size={12} className="animate-spin" /> : <ShieldAlert size={12} />}
                      <span>CHECK INTEGRITY</span>
                    </button>
                  </div>
                </div>
                {integrityReport.total > 0 && (
                  <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3 animate-in fade-in zoom-in-95">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="flex flex-col items-center"><span className="text-[8px] text-slate-600 font-black">TOTAL</span><span className="text-xs font-bold">{integrityReport.total}</span></div>
                      <div className="flex flex-col items-center"><span className="text-[8px] text-emerald-600 font-black">PASS</span><span className="text-xs font-bold text-emerald-400">{integrityReport.passed}</span></div>
                      <div className="flex flex-col items-center"><span className="text-[8px] text-red-600 font-black">ERR</span><span className="text-xs font-bold text-red-400">{integrityReport.errors}</span></div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                   <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Zap size={12} className="text-[var(--industrial-accent)]" /><span>Optimization Mode</span></div>
                   <div onClick={() => handleToggleTags(!useOptimizationTags)} className={`w-10 h-5 rounded-full relative transition-all cursor-pointer border ${useOptimizationTags ? 'bg-[var(--industrial-accent)] border-[var(--industrial-accent)]' : 'bg-[#1a1a1a] border-[var(--industrial-border)]'}`}>
                     <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${useOptimizationTags ? 'right-0.5' : 'left-0.5'}`} />
                   </div>
                </div>
                <div className="text-[8px] font-bold text-slate-600 uppercase tracking-widest px-1">DFT & Estimated Entropy Weights</div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                   <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Activity size={12} className="text-[var(--industrial-accent)]" /><span>AICc Penalty</span></div>
                   <button onClick={addAICcRow} className="p-1 bg-[var(--industrial-accent)]/10 hover:bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)] rounded-none border border-[var(--industrial-accent)]/20 transition-all"><Plus size={10} /></button>
                </div>
                <div className="space-y-2">
                  {config.generate_parameters?.aicc_penalty.map((p, idx) => (
                    <div key={idx} className="bg-black border border-[var(--industrial-border)] rounded-none p-3 grid grid-cols-12 gap-2 items-center">
                      <select value={p.phase} onChange={(e) => updateAICcRow(idx, 'phase', e.target.value)} className="col-span-5 bg-black border border-[var(--industrial-border)] rounded-none px-2 py-1 text-[10px] text-[var(--industrial-accent)] outline-none">
                        {pmPhases.length > 0 ? pmPhases.map(ph => <option key={ph} value={ph}>{ph}</option>) : <option value={p.phase}>{p.phase}</option>}
                      </select>
                      <div className="col-span-3 flex flex-col space-y-0.5">
                        <label className="text-[7px] text-slate-600 font-bold uppercase ml-1">HM</label>
                        <input type="number" step="0.1" value={p.hm} onChange={(e) => updateAICcRow(idx, 'hm', parseFloat(e.target.value))} className="bg-black border border-[var(--industrial-border)] rounded-none px-2 py-0.5 text-[10px] text-amber-300 outline-none" />
                      </div>
                      <div className="col-span-3 flex flex-col space-y-0.5">
                        <label className="text-[7px] text-slate-600 font-bold uppercase ml-1">SM</label>
                        <input type="number" step="0.1" value={p.sm} onChange={(e) => updateAICcRow(idx, 'sm', parseFloat(e.target.value))} className="bg-black border border-[var(--industrial-border)] rounded-none px-2 py-0.5 text-[10px] text-emerald-300 outline-none" />
                      </div>
                      <button onClick={() => removeAICcRow(idx)} className="col-span-1 flex justify-center text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pb-10">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><FileCode size={12} className="text-slate-400" /><span>Live YAML Preview</span></div>
                <div className="bg-black rounded-none p-4 border border-[var(--industrial-border)] shadow-inner overflow-hidden">
                   <pre className="text-[9px] font-mono text-slate-500 leading-normal overflow-x-auto whitespace-pre selection:bg-[var(--industrial-accent)]/30">{liveYamlPreview}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* PANEL 2: Log & Engine (25%) */}
        <div className="col-span-1 flex flex-col space-y-4 h-full overflow-hidden">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none overflow-hidden shadow-2xl relative">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center bg-black px-1 shrink-0"><button onClick={() => setMiddleTab('tdb')} className={`flex-1 h-full flex items-center justify-center space-x-2 text-[10px] font-bold uppercase border-b-2 transition-all ${middleTab === 'tdb' ? 'border-amber-500 text-amber-400 bg-amber-500/5' : 'border-transparent text-slate-600'}`}><Database size={14} /><span>Generated TDB</span></button><button onClick={() => setMiddleTab('log')} className={`flex-1 h-full flex items-center justify-center space-x-2 text-[10px] font-bold uppercase border-b-2 transition-all ${middleTab === 'log' ? 'border-[var(--industrial-accent)] text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/5' : 'border-transparent text-slate-600'}`}><FileText size={14} /><span>Engine Log</span></button></header>
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto custom-scrollbar p-5 bg-black mt-4">
                <pre className={`font-mono leading-tight whitespace-pre-wrap ${middleTab === 'tdb' ? 'text-[11px] text-amber-500/80' : 'text-[10px] text-slate-400'}`}>
                  {middleTab === 'tdb' ? (generatedTDB || "// Output pending...") : (generatedLog || "// Waiting for optimizer details...")}
                </pre>
              </div>

              {/* Artifact Export UI Bar - PRESERVED */}
              <div className="px-5 pb-5 pt-3 bg-black border-t border-[var(--industrial-border)] space-y-3 shrink-0">
                <div className="space-y-1.5">
                  <label className="text-[8px] font-black text-slate-600 uppercase tracking-[0.2em] ml-1">Artifact Export Configuration</label>
                  <div className="flex space-x-2">
                    <div className="flex-1 relative">
                       <FileCode size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                       <input 
                         type="text" 
                         value={exportName}
                         onChange={(e) => setExportName(e.target.value)}
                         placeholder="Export name (e.g. Mg-Al.tdb)"
                         className="w-full bg-black border border-[var(--industrial-border)] rounded-none pl-8 pr-3 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none focus:border-[var(--industrial-accent)]/30 transition-all"
                       />
                    </div>
                    <button 
                      onClick={() => setSelectorConfig({ mode: 'folder', title: 'Target Hub Folder', field: 'save_artifact' })}
                      disabled={!generatedTDB}
                      className="px-4 h-9 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 disabled:bg-[#1a1a1a] text-black rounded-none text-[9px] font-black shadow-lg transition-all active:scale-95 flex items-center space-x-2 shrink-0"
                    >
                      <Save size={14} />
                      <span>SAVE ARTIFACTS</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="p-6 border-t border-[var(--industrial-border)] bg-black flex flex-col shrink-0 shadow-2xl">
              <button onClick={runFitting} disabled={isProcessing || !config.system.phase_models} className="w-full h-14 flex items-center justify-center space-x-4 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 disabled:bg-[#1a1a1a] text-black rounded-none font-black shadow-xl transition-all active:scale-[0.98] uppercase tracking-[0.2em] text-[11px]">
                {isProcessing ? <Loader2 size={24} className="animate-spin" /> : <Play size={24} />}
                <span>{isProcessing ? 'Optimizing...' : 'Run ESPEI Optimizer'}</span>
              </button>
              <div className="mt-4 space-y-2">
                <div className="flex items-center space-x-2 px-1"><Terminal size={12} className="text-slate-500" /><span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Optimization Trace</span></div>
                <div ref={consoleRef} className="h-[180px] bg-black rounded-none p-4 font-mono text-[10px] text-[var(--industrial-accent)]/80 overflow-y-auto custom-scrollbar border border-[var(--industrial-border)] shadow-inner">
                  {logs.length === 0 ? <span className="text-slate-800 italic uppercase tracking-widest opacity-40">System Idle...</span> : logs.map((log, i) => (<div key={i} className={`mb-1 leading-relaxed border-l pl-2 ${log.startsWith('[SYSTEM]') || log.startsWith('[SYNC]') ? 'border-emerald-500 text-emerald-400' : 'border-[var(--industrial-accent)]/20'}`}>{log}</div>))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* PANEL 3: Finalized Validation Hub (50%) */}
        <div className="col-span-2 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none overflow-hidden shadow-2xl h-full relative">
          {isPlotting && <div className="absolute inset-0 z-50 bg-black backdrop-blur-xl flex flex-col items-center justify-center space-y-8 animate-in fade-in duration-300"><div className="relative"><Loader2 size={80} className="text-[var(--industrial-accent)] animate-spin" /><HardDrive className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white/20" size={32} /></div></div>}
          
          <header className="h-12 border-b border-[var(--industrial-border)] flex items-center bg-black px-1 shrink-0">
            {(['PD', 'ACR', 'HM_MIX', 'DRIVING_FORCE'] as const).map(t => (
              <button 
                key={t} 
                onClick={() => { setActiveValidationTab(t); setGeneratedPlot(null); setGeneratedCsv(null); setViewMode('plot'); }} 
                className={`flex-1 h-full flex items-center justify-center text-[9px] font-black uppercase tracking-widest transition-all border-b-2 ${activeValidationTab === t ? 'border-[var(--industrial-accent)] text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' : 'border-transparent text-slate-600 hover:text-slate-400'}`}
              >
                {t === 'PD' ? 'Phase Diagram' : t === 'ACR' ? 'Chemical Activity' : t === 'HM_MIX' ? 'Mixing Enthalpy' : 'Driving Force'}
              </button>
            ))}
          </header>

          <div className="flex-1 flex flex-col p-8 space-y-6 overflow-hidden">
            {/* Source Configuration Bar */}
            <div className="grid grid-cols-2 gap-4 shrink-0">
              <div className="bg-black border border-[var(--industrial-border)] p-4 rounded-none flex items-center justify-between group transition-all hover:border-[var(--industrial-accent)]/50">
                <div className="flex flex-col overflow-hidden">
                  <span className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center"><FileSearch size={10} className="mr-1 text-[var(--industrial-accent)]" />Validation TDB Source</span>
                  <span className="text-[11px] text-[var(--industrial-accent)] font-mono truncate">{plotSourceTdbPath === 'INTERNAL_CURRENT' ? 'Active Production Artifact' : plotSourceTdbPath || 'Select TDB...'}</span>
                </div>
                <button onClick={() => setSelectorConfig({ mode: 'file', title: 'Redirect Validation TDB', field: 'plot_tdb' })} className="p-2.5 bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)] rounded-none hover:bg-[var(--industrial-accent)]/30 transition-all"><RefreshCw size={14} /></button>
              </div>
              <div className="bg-black border border-[var(--industrial-border)] p-4 rounded-none flex items-center justify-between group transition-all hover:border-amber-500/50">
                <div className="flex flex-col overflow-hidden">
                  <span className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center"><FolderOpen size={10} className="mr-1 text-amber-400" />Calibration Hub</span>
                  <span className="text-[11px] text-amber-300 font-mono truncate">{plotSourceDsPath || 'Global Fitting Hub'}</span>
                </div>
                <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Redirect Calibration Hub', field: 'plot_ds' })} className="p-2.5 bg-amber-600/20 text-amber-400 rounded-none hover:bg-amber-600/30 transition-all"><Monitor size={14} /></button>
              </div>
            </div>

            {/* Dynamic Parameter Grid - PRESERVED */}
            <div className="bg-black border border-[var(--industrial-border)] p-6 rounded-none shadow-2xl shrink-0">
              <div className="grid grid-cols-6 gap-4 items-end">
                {/* Mode Specific Inputs including tStep */}
                {(activeValidationTab === 'PD' || activeValidationTab === 'DRIVING_FORCE') ? (
                  <>
                    <div className="col-span-1 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Min (K)</label><input type="number" value={vParams.tMin} onChange={e => setVParams(p => ({...p, tMin: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-4 py-2 text-[11px] text-[var(--industrial-accent)] outline-none" /></div>
                    <div className="col-span-1 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Max (K)</label><input type="number" value={vParams.tMax} onChange={e => setVParams(p => ({...p, tMax: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-4 py-2 text-[11px] text-[var(--industrial-accent)] outline-none" /></div>
                    <div className="col-span-1 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">T Step (K)</label><input type="number" value={vParams.tStep} onChange={e => setVParams(p => ({...p, tStep: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-4 py-2 text-[11px] text-[var(--industrial-accent)] outline-none" /></div>
                  </>
                ) : (
                  <>
                    <div className="col-span-1 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1">Temp (K)</label><input type="number" value={vParams.targetTemp} onChange={e => setVParams(p => ({...p, targetTemp: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-4 py-2 text-[11px] text-[var(--industrial-accent)] outline-none" /></div>
                    <div className="col-span-1 space-y-1.5">
                      <label className="text-[8px] font-black text-slate-600 uppercase ml-1">Phase</label>
                      <select value={vParams.targetPhase} onChange={e => setVParams(p => ({...p, targetPhase: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-2 text-[11px] text-amber-400 outline-none">
                        {validationPhases.map(ph => <option key={ph} value={ph}>{ph}</option>)}
                      </select>
                    </div>
                    {activeValidationTab === 'ACR' && (
                      <div className="col-span-1 space-y-1.5">
                        <label className="text-[8px] font-black text-slate-600 uppercase ml-1">Comp</label>
                        <select value={vParams.targetComp} onChange={e => setVParams(p => ({...p, targetComp: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-2 text-[11px] text-emerald-400 outline-none">
                          {validationComps.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
                
                <div className="col-span-3 flex space-x-2">
                  <button onClick={() => handleGeneratePlot('plot')} disabled={isPlotting} className="flex-1 h-10 flex items-center justify-center space-x-2 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 text-black rounded-none font-black shadow-xl transition-all uppercase tracking-widest text-[9px]">
                    <Zap size={14} /><span>Generate Map</span>
                  </button>
                  <button 
                    onClick={() => { setViewMode(viewMode === 'plot' ? 'table' : 'plot'); }} 
                    disabled={!generatedCsv}
                    className={`px-4 h-10 flex items-center justify-center space-x-2 rounded-none font-black transition-all uppercase text-[9px] border ${viewMode === 'table' ? 'bg-amber-600 text-white border-amber-500' : 'bg-[#1a1a1a] text-slate-400 border-[var(--industrial-border)] hover:bg-[#2a2a2a]'}`}
                  >
                    {viewMode === 'table' ? <ImageIcon size={14} /> : <FileSpreadsheet size={14} />}
                    <span>{viewMode === 'table' ? 'View Plot' : 'Raw Data'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Display Area */}
            <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none overflow-hidden relative group flex items-center justify-center min-h-[400px]">
              {generatedPlot || generatedCsv ? (
                viewMode === 'plot' ? (
                  <div className="relative w-full h-full flex items-center justify-center p-4">
                    <img 
                      src={`data:image/png;base64,${generatedPlot}`} 
                      className="max-h-full max-w-full object-contain cursor-zoom-in" 
                      onClick={() => setShowPlotModal(true)} 
                    />
                    <div className="absolute bottom-6 right-6 flex space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={downloadPlot} className="p-3 bg-black hover:bg-[var(--industrial-accent)] text-white rounded-none backdrop-blur-md transition-all shadow-2xl"><Download size={20} /></button>
                      <button onClick={() => setShowPlotModal(true)} className="p-3 bg-black hover:bg-[var(--industrial-accent)] text-white rounded-none backdrop-blur-md transition-all shadow-2xl"><Maximize2 size={20} /></button>
                    </div>
                  </div>
                ) : (
                  <div className="w-full h-full flex flex-col p-8 overflow-hidden">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Tabular Calibration Data</h4>
                      <button 
                        onClick={() => { navigator.clipboard.writeText(generatedCsv || ""); alert("CSV copied to clipboard."); }}
                        className="flex items-center space-x-2 text-[9px] font-bold text-[var(--industrial-accent)] hover:text-white transition-colors"
                      >
                        <Copy size={12} /><span>Copy CSV</span>
                      </button>
                    </div>
                    <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none p-6 overflow-auto custom-scrollbar font-mono text-[10px] text-emerald-400/90 whitespace-pre leading-relaxed">
                      {generatedCsv || "// No tabular data available."}
                    </div>
                  </div>
                )
              ) : (
                <div className="opacity-10 flex flex-col items-center select-none">
                  <ImageIcon size={160} />
                  <span className="text-2xl font-black uppercase tracking-[0.8em] mt-4">Idle Perspective</span>
                </div>
              )}
            </div>
          </div>
          
          <footer className="h-10 border-t border-[var(--industrial-border)] bg-black flex items-center px-8 justify-between shrink-0">
             <div className="flex items-center space-x-4 text-[9px] font-bold uppercase tracking-widest text-slate-600">
               <span>ARCTDE Academic Standard V11.3</span>
               <span className="w-1 h-1 rounded-full bg-slate-800" />
               <span>Mapping Mode: {activeValidationTab}</span>
             </div>
             <div className="flex items-center space-x-2">
               <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
               <span className="text-[9px] font-black text-emerald-500/80 uppercase">Internal Calibrator Active</span>
             </div>
          </footer>
        </div>
      </div>

      {/* FULLSCREEN PLOT MODAL */}
      {showPlotModal && generatedPlot && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black p-12">
          <button onClick={() => setShowPlotModal(false)} className="absolute top-8 right-8 p-3 bg-black border border-[var(--industrial-border)] rounded-full text-white hover:bg-red-600 transition-all"><X size={24} /></button>
          <img src={`data:image/png;base64,${generatedPlot}`} className="max-h-full max-w-full object-contain shadow-[0_0_80px_rgba(0,0,0,0.5)]" />
        </div>
      )}

      {selectorConfig && (
        <FileSelectorModal 
          files={files} mode={selectorConfig.mode} title={selectorConfig.title} onClose={() => setSelectorConfig(null)}
          onConfirm={(path) => {
            if (selectorConfig.field === 'phase_models') setConfig(prev => ({ ...prev, system: { ...prev.system, phase_models: path as string } }));
            else if (selectorConfig.field === 'datasets') setConfig(prev => ({ ...prev, system: { ...prev.system, datasets: path as string } }));
            else if (selectorConfig.field === 'plot_tdb') setPlotSourceTdbPath(path as string);
            else if (selectorConfig.field === 'plot_ds') setPlotSourceDsPath(path as string);
            else if (selectorConfig.field === 'save_artifact') handleSaveToResourceHub(path as string);
            
            if (selectorConfig.field !== 'save_artifact') setSelectorConfig(null);
          }}
        />
      )}
    </div>
  );
};

export default Wizard;