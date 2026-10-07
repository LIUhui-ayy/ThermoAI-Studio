import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Terminal, SlidersHorizontal, Database, Target, Zap, Loader2, 
  FileCode, Layout, Monitor as MonitorIcon, BrainCircuit, 
  Sparkles, Plus, Trash2, Info, BarChart3, LineChart as LineChartIcon, 
  RefreshCw, ClipboardCheck, HardDrive, Activity, 
  Maximize2, ChevronRight, DatabaseZap, Image as ImageIcon,
  Save, Gauge, Settings, ShieldAlert, FileWarning, Cpu, X,
  Layers, AlertCircle, TerminalSquare, ScrollText, Binary,
  Fingerprint, ToggleLeft, ToggleRight, CheckCircle2, Copy,
  Download, FileType, ChevronDown, ChevronUp, CheckSquare, Square, Search,
  Bug, FileJson, FileStack, HardDriveDownload, FileSearch, FolderOpen,
  Thermometer, BoxSelect, FileSpreadsheet, Eye, History, Trash
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { FileNode, JobStatus } from '../types';
import FileSelectorModal from './FileSelectorModal';
import { GoogleGenAI } from "@google/genai";

interface MonitorProps {
  jobs: JobStatus[];
  files: FileNode[];
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
}

interface MCMCConfig {
  input_tdb: string;
  input_phase_model: string;
  datasets_folder: string;
  iterations: number;
  scheduler: 'dask' | 'null';
  cores: number;
  chains_per_parameter: number;
  chain_std_deviation: number;
  save_interval: number;
  deterministic: boolean;
  optimization_mode?: string;
  prior: {
    type: 'normal' | 'triangular' | 'uniform';
    loc_relative: number;
    scale_relative: number;
  };
  output: {
    output_db: string;
    logfile: string;
    tracefile: string;
    probfile: string;
    verbosity: number;
  };
  symbols: string[];
  weights: Record<string, number>;
}

interface TdbComparisonItem {
  id: string;
  label: string;
  path: string; // 'INTERNAL_INIT' | 'INTERNAL_MCMC' | '/path/to/artifact'
  selected: boolean;
  color?: string; // Optional visually
}

const downsampleData = (data: any[], maxPoints: number) => {
  if (!data || data.length <= maxPoints) return data;
  const stride = Math.floor(data.length / maxPoints);
  return data.filter((_, i) => i % stride === 0 || i === data.length - 1);
};

const Monitor: React.FC<MonitorProps> = ({ jobs, files, setFiles }) => {
  const [config, setConfig] = useState<MCMCConfig>({
    input_tdb: '',
    input_phase_model: '',
    datasets_folder: '/espei_datasets',
    iterations: 500,
    scheduler: 'dask',
    cores: 16,
    chains_per_parameter: 2,
    chain_std_deviation: 0.15,
    save_interval: 10,
    deterministic: true,
    optimization_mode: 'default',
    prior: { type: 'normal', loc_relative: 1.0, scale_relative: 0.5 },
    output: {
      output_db: 'MCMC_REFINED.tdb',
      logfile: 'mcmc.log',
      tracefile: 'trace.npy',
      probfile: 'prob.npy',
      verbosity: 2
    },
    symbols: [],
    weights: { ZPF: 40, ACR: 1, HM: 1, SM: 0.008 }
  });

  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [activeTab, setActiveTab] = useState<'MAPS' | 'TRACE' | 'AI'>('MAPS');
  
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [systemMessages, setSystemMessages] = useState<string[]>([]);
  const [lastTraceback, setLastTraceback] = useState<string | null>(null);
  
  const [refinedTrace, setRefinedTrace] = useState<any>(null);
  const [refinedProb, setRefinedProb] = useState<any>(null);
  const [refinedIndices, setRefinedIndices] = useState<number[] | null>(null);

  // Memoized probability data to prevent heavy calculations on every render
  const memoProbData = useMemo(() => {
    if (!refinedProb) return [];
    return downsampleData(refinedProb.map((iterData: number[], i: number) => {
      const pt: any = { iteration: refinedIndices ? refinedIndices[i] + 1 : i + 1 };
      iterData.forEach((val, cIdx) => pt[`chain_${cIdx}`] = val);
      return pt;
    }), 200);
  }, [refinedProb, refinedIndices]);

  // Memoized trace data to prevent heavy calculations on every render
  const memoTraceData = useMemo(() => {
    if (!refinedTrace || !config.symbols) return {};
    const res: Record<string, any[]> = {};
    config.symbols.forEach((symbol, pIdx) => {
      res[symbol] = downsampleData(refinedTrace.map((iterData: number[][], i: number) => {
        const pt: any = { iteration: refinedIndices ? refinedIndices[i] + 1 : i + 1 };
        iterData.forEach((chainData, cIdx) => {
          if (chainData && chainData[pIdx] !== undefined) {
            pt[`chain_${cIdx}`] = chainData[pIdx];
          }
        });
        return pt;
      }), 150);
    });
    return res;
  }, [refinedTrace, refinedIndices, config.symbols]);

  const [results, setResults] = useState<any>(null);
  const [selectedDataTypes, setSelectedDataTypes] = useState<string[]>(['ZPF', 'ACR', 'HM', 'SM']);
  const [isWeightsDropdownOpen, setIsWeightsDropdownOpen] = useState(false);
  const availableDataTypes = ['ZPF', 'ACR', 'HM', 'SM', 'CPM'];

  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiLanguage, setAiLanguage] = useState<'zh' | 'en'>('zh');
  const [userFeedback, setUserFeedback] = useState('');
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const [isMapExpanded, setIsMapExpanded] = useState(false);
  const [isTableExpanded, setIsTableExpanded] = useState(false);
  
  const [selectorConfig, setSelectorConfig] = useState<{ mode: 'file' | 'folder' | 'multi-file', title: string, field: 'input_tdb' | 'input_phase_model' | 'datasets_folder' | 'mcmc_save' | 'val_ds' | 'add_tdb' | 'val_save' } | null>(null);

  const [availableSymbols, setAvailableSymbols] = useState<Record<string, string[]>>({});
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());

  // Auto-adapt chains_per_parameter
  useEffect(() => {
    if (config.symbols.length > 0) {
      // User specifically wants chains = 2 * params auto-adaptation
      // We set multiplier to 2 to exactly match their request for "Total = 2 * params"
      if (config.chains_per_parameter < 2) {
        setConfig(prev => ({ ...prev, chains_per_parameter: 2 }));
      }
    }
  }, [config.symbols.length]);

  // --- 🚀 MULTI-TDB COMPARISON STATE ---
  const [tdbComparisonList, setTdbComparisonList] = useState<TdbComparisonItem[]>([
    { id: 'initial', label: 'Initial Baseline', path: 'INTERNAL_INIT', selected: true },
    { id: 'current', label: 'Active Posterior', path: 'INTERNAL_MCMC', selected: true }
  ]);
  const [valDsPath, setValDsPath] = useState<string | null>(null);
  const [validationPlot, setValidationPlot] = useState<string | null>(null);
  const [validationCsv, setValidationCsv] = useState<string | null>(null);
  const [validationMetrics, setValidationMetrics] = useState<any>(null);
  const [validationMode, setValidationMode] = useState<'PD' | 'ACR' | 'HM_MIX' | 'DRIVING_FORCE'>('PD');
  const [valParams, setValParams] = useState({
    tMin: 300, tMax: 2000, tStep: 10,
    targetTemp: 1000, targetPhase: '', targetComp: '', activityEl: ''
  });
  const [availablePhases, setAvailablePhases] = useState<string[]>([]);
  const [availableComps, setAvailableComps] = useState<string[]>([]);
  const [isValidating, setIsValidating] = useState(false);

  const logConsoleRef = useRef<HTMLDivElement>(null);
  const systemConsoleRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [refinedTDB, setRefinedTDB] = useState<string | null>(null);

  useEffect(() => {
    if (logConsoleRef.current) logConsoleRef.current.scrollTop = logConsoleRef.current.scrollHeight;
  }, [executionLogs]);

  useEffect(() => {
    if (systemConsoleRef.current) systemConsoleRef.current.scrollTop = systemConsoleRef.current.scrollHeight;
  }, [systemMessages]);

  useEffect(() => {
    const activeSources = tdbComparisonList.filter(s => s.selected);
    if (activeSources.length === 0) return;
    
    let content = "";
    const primary = activeSources[0];
    if (primary.path === 'INTERNAL_INIT') content = findNodeByPath(files, config.input_tdb)?.content || "";
    else if (primary.path === 'INTERNAL_MCMC') content = refinedTDB || "";
    else content = findNodeByPath(files, primary.path)?.content || "";

    if (content) {
      const phases: string[] = [];
      const comps: string[] = [];
      content.split('\n').forEach(line => {
        const t = line.trim().toUpperCase();
        if (t.startsWith('PHASE')) phases.push(t.split(/\s+/)[1]);
        if (t.startsWith('ELEMENT')) {
          const el = t.split(/\s+/)[1];
          if (el && el !== 'VA') comps.push(el);
        }
      });
      const uniquePhases = Array.from(new Set(phases)).filter(Boolean).sort();
      const uniqueComps = Array.from(new Set(comps)).filter(Boolean).sort();
      setAvailablePhases(uniquePhases);
      setAvailableComps(uniqueComps);
      if (!valParams.targetPhase && uniquePhases.length > 0) setValParams(v => ({...v, targetPhase: uniquePhases[0]}));
      if (!valParams.targetComp && uniqueComps.length > 0) setValParams(v => ({...v, targetComp: uniqueComps[0]}));
      if (!valParams.activityEl && uniqueComps.length > 0) setValParams(v => ({...v, activityEl: uniqueComps[0]}));
    }
  }, [tdbComparisonList, refinedTDB, files, config.input_tdb]);

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

  const parseTdbSymbols = (content: string) => {
    const lines = content.split('\n');
    const symbolsByPhase: Record<string, string[]> = { 'Global/Other': [] };
    const allVVs = new Set<string>();
    lines.forEach(line => {
      const funcMatch = line.match(/FUNCTION\s+(VV\d+)/i);
      if (funcMatch) allVVs.add(funcMatch[1].toUpperCase());
    });
    lines.forEach(line => {
      const paramMatch = line.match(/PARAMETER\s+[L|G]\s*\(\s*([^,)]+)/i);
      if (paramMatch) {
        const phase = paramMatch[1].trim().toUpperCase();
        if (!symbolsByPhase[phase]) symbolsByPhase[phase] = [];
        allVVs.forEach(vv => {
          if (line.toUpperCase().includes(vv)) {
            if (!symbolsByPhase[phase].includes(vv)) {
              symbolsByPhase[phase].push(vv);
            }
          }
        });
      }
    });
    const linkedVVs = new Set(Object.values(symbolsByPhase).flat());
    allVVs.forEach(vv => {
      if (!linkedVVs.has(vv)) {
        symbolsByPhase['Global/Other'].push(vv);
      }
    });
    Object.keys(symbolsByPhase).forEach(k => {
      if (symbolsByPhase[k].length === 0 && k !== 'Global/Other') delete symbolsByPhase[k];
    });
    return symbolsByPhase;
  };

  useEffect(() => {
    if (config.input_tdb) {
      const node = findNodeByPath(files, config.input_tdb);
      if (node?.content) {
        const mapped = parseTdbSymbols(node.content);
        setAvailableSymbols(mapped);
        setExpandedPhases(new Set(Object.keys(mapped)));
      }
    }
  }, [config.input_tdb, files]);

  const collectRecursiveDatasets = (path: string): any[] => {
    const data: any[] = [];
    let rootNode = findNodeByPath(files, path);
    
    // Fallback: If specified folder not found, scan the entire file tree
    if (!rootNode) {
      console.warn(`Folder ${path} not found. Scanning entire file tree for datasets.`);
      rootNode = { children: files, type: 'folder', name: 'ROOT', path: '/' } as FileNode;
    }

    const traverse = (node: FileNode) => {
      if (node.type === 'file' && node.name.toLowerCase().endsWith('.json') && node.content) {
        try { 
          const parsed = JSON.parse(node.content); 
          if (Array.isArray(parsed)) {
             parsed.forEach(p => {
               if (p && typeof p === 'object' && (p.output || p.values || p.reference)) data.push(p);
             });
          } else {
             if (parsed && typeof parsed === 'object' && (parsed.output || parsed.values || parsed.reference)) data.push(parsed); 
          }
        } catch (e: any) {
          console.error(`Error parsing dataset JSON in ${node.path}:`, e);
          setSystemMessages(prev => [...prev, `[WARN] Failed to parse JSON file: ${node.path} (${e.message})`]);
        }
      }
      if (node.children) node.children.forEach(traverse);
    };
    traverse(rootNode);
    return data;
  };

  const handleRunValidation = async () => {
    const activeSources = tdbComparisonList.filter(s => s.selected);
    if (activeSources.length === 0) {
      setSystemMessages(prev => [...prev, "[VALIDATION ERROR] No TDB source selected for comparison."]);
      return;
    }

    const tdbDataForBackend = activeSources.map(s => {
      let content = "";
      if (s.path === 'INTERNAL_INIT') content = findNodeByPath(files, config.input_tdb)?.content || "";
      else if (s.path === 'INTERNAL_MCMC') content = refinedTDB || "";
      else content = findNodeByPath(files, s.path)?.content || "";
      return { label: s.label, content: content };
    }).filter(s => s.content !== "");

    if (tdbDataForBackend.length === 0) {
      setSystemMessages(prev => [...prev, "[VALIDATION ERROR] Selected TDB content is missing."]);
      return;
    }

    setIsValidating(true);
    try {
      const datasets = collectRecursiveDatasets(valDsPath || config.datasets_folder);
      const response = await fetch('/validate-mcmc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tdb_sources: tdbDataForBackend,
          datasets: datasets,
          type: validationMode,
          config: {
             t_min: valParams.tMin,
             t_max: valParams.tMax,
             t_step: valParams.tStep,
             temperature: valParams.targetTemp,
             phase: valParams.targetPhase,
             target_comp: valParams.targetComp,
             activity_el: valParams.activityEl
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
        setValidationPlot(result.image);
        setValidationCsv(result.csv_data);
        setValidationMetrics(result.performance_metrics);
        setSystemMessages(prev => [...prev, `[SYSTEM] Comparison Map Generated: ${tdbDataForBackend.length} TDBs overlaid.`]);
      } else {
        setSystemMessages(prev => [...prev, `[VALIDATION ERROR] ${result.message}`]);
      }
    } catch (e) {
      setSystemMessages(prev => [...prev, "[VALIDATION ERROR] API connection failed."]);
    } finally {
      setIsValidating(false);
    }
  };

  const runMCMC = async () => {
    if (!config.input_tdb || config.symbols.length === 0) {
      setSystemMessages(prev => [...prev, "[SYSTEM] Blocked: Input TDB and symbols required."]);
      return;
    }
    setIsOptimizing(true);
    setExecutionLogs([]);
    setSystemMessages([]);
    setRefinedTDB(null);
    setRefinedTrace(null);
    setRefinedProb(null);
    setRefinedIndices(null);
    setActiveTab('TRACE');
    abortControllerRef.current = new AbortController();
    const tdbNode = findNodeByPath(files, config.input_tdb);
    const pmNode = config.input_phase_model ? findNodeByPath(files, config.input_phase_model) : null;
    const datasetObjects = collectRecursiveDatasets(config.datasets_folder);
    
    try {
      console.log("[MCMC] Sending request to /run-mcmc...");
      setSystemMessages(prev => [...prev, `[SYSTEM] Bayesian Refinement Initiated... Found ${datasetObjects.length} dataset records in ${config.datasets_folder}.`]);
      setExecutionLogs(prev => [...prev, `[INIT] Found ${datasetObjects.length} dataset records in ${config.datasets_folder}.`]);
      
      const response = await fetch('/run-mcmc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tdb_content: tdbNode?.content || "", phase_model: pmNode?.content ? JSON.parse(pmNode.content) : null, datasets: datasetObjects, config: config }),
        signal: abortControllerRef.current.signal
      });
      
      console.log("[MCMC] Response status:", response.status);
      if (!response.ok) {
        const errorText = await response.text();
        setSystemMessages(prev => [...prev, `[ERROR] Server returned ${response.status}: ${errorText}`]);
        setIsOptimizing(false);
        return;
      }

      if (!response.body) {
        setSystemMessages(prev => [...prev, "[ERROR] Response body is null."]);
        setIsOptimizing(false);
        return;
      }
      
      const reader = response.body.getReader();
      console.log("[MCMC] Reader obtained, starting stream processing...");
      const decoder = new TextDecoder();
      let buffer = "";
      
      let incomingLogs: string[] = [];
      let latestTrace: any = null;
      let latestProb: any = null;
      let latestIndices: number[] | null = null;
      
      const flushUI = setInterval(() => {
        if (incomingLogs.length > 0) {
          setExecutionLogs(prev => {
            const next = [...prev, ...incomingLogs];
            // Keep up to 150 logs for history to prevent DOM bloat (browser crash)
            return next.length > 150 ? next.slice(-150) : next;
          });
          incomingLogs = [];
        }
        if (latestTrace !== null) {
          setRefinedTrace(latestTrace);
          setRefinedProb(latestProb);
          if (latestIndices !== null) setRefinedIndices(latestIndices);
          latestTrace = null;
          latestProb = null;
          latestIndices = null;
        }
      }, 1000); // 1s flush to balance real-time feel and main thread stability

      try {
        while (true) {
          let value, done;
          try {
            const result = await reader.read();
            value = result.value;
            done = result.done;
          } catch (readErr) {
            console.error("[MCMC] Stream read error:", readErr);
            setSystemMessages(prev => [...prev, "[ERROR] Connection interrupted. The backend might have run out of memory or crashed."]);
            setIsOptimizing(false);
            break;
          }
          
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const segments = buffer.split('\n\n');
          buffer = segments.pop() || "";
          
          let newTdb: string | null = null;
          let isSuccess = false;

          segments.forEach(segment => {
            if (!segment.trim()) return;
            const dataLine = segment.split('\n').find(l => l.trim().startsWith('data: '));
            if (!dataLine) return;
            try {
              const data = JSON.parse(dataLine.replace(/^data: /, ''));
              if (data.type === 'log') {
                incomingLogs.push(data.data);
              } else if (data.type === 'error') {
                incomingLogs.push(`[SYSTEM_ERROR] ${data.data}`);
                setSystemMessages(prev => [...prev, `[FATAL] ${data.data}`]);
              } else if (data.type === 'progress') {
                if (data.trace && data.lnprob) {
                  latestTrace = data.trace;
                  latestProb = data.lnprob;
                  if (data.indices) latestIndices = data.indices;
                }
              } else if (data.status === 'success') {
                newTdb = data.tdb;
                if (data.trace) latestTrace = data.trace;
                if (data.lnprob) latestProb = data.lnprob;
                if (data.indices) latestIndices = data.indices;
                isSuccess = true;
              }
            } catch (e) {}
          });
          
          if (isSuccess) {
            setRefinedTDB(newTdb);
            setSystemMessages(prev => [...prev, "[SUCCESS] Optimization results captured."]);
            setIsOptimizing(false);
            setIsAborting(false);
            // Ensure console shows final few lines
            setExecutionLogs(prev => prev.length > 300 ? prev.slice(-300) : prev);
            break;
          }
        }
      } finally {
        clearInterval(flushUI);
        // Final flush - keep it lean to prevent crash
        if (incomingLogs.length > 0) {
          setExecutionLogs(prev => {
            const next = [...prev, ...incomingLogs];
            return next.length > 150 ? next.slice(-150) : next;
          });
        }
        setIsOptimizing(false);
        setIsAborting(false);
      }
    } catch (err: any) {
      setIsOptimizing(false);
    }
  };

  const stopMCMC = async () => {
    if (isAborting) return;
    try {
      setIsAborting(true);
      await fetch('/abort-mcmc', { method: 'POST' });
      setSystemMessages(prev => [...prev, "[SYSTEM] Stop signal sent. Finalizing current progress..."]);
    } catch(e) {
      setIsAborting(false);
    }
  };

  const toggleSymbol = (s: string) => {
    setConfig(prev => ({ ...prev, symbols: prev.symbols.includes(s) ? prev.symbols.filter(sym => sym !== s) : [...prev.symbols, s] }));
  };

  const selectAllSymbols = () => {
    const all = Object.values(availableSymbols).flat();
    setConfig(prev => ({ ...prev, symbols: all }));
  };

  const togglePhaseSymbols = (phase: string) => {
    const phaseSyms = availableSymbols[phase] || [];
    const allSelected = phaseSyms.every(s => config.symbols.includes(s));
    if (allSelected) {
      setConfig(prev => ({ ...prev, symbols: prev.symbols.filter(s => !phaseSyms.includes(s)) }));
    } else {
      setConfig(prev => ({ ...prev, symbols: Array.from(new Set([...prev.symbols, ...phaseSyms])) }));
    }
  };

  const toggleComparisonSelected = (id: string) => {
    setTdbComparisonList(prev => prev.map(s => s.id === id ? { ...s, selected: !s.selected } : s));
  };

  const addComparisonSource = (path: string) => {
    const filename = path.split('/').pop() || 'Archive TDB';
    const newItem: TdbComparisonItem = {
      id: Math.random().toString(36).substr(2, 9),
      label: `Archive: ${filename}`,
      path: path,
      selected: true
    };
    setTdbComparisonList(prev => [...prev, newItem]);
  };

  const liveYaml = useMemo(() => {
    const yamlLines = [
      "system:",
      `  input_db: ${config.input_tdb || 'None'}`,
      `  phase_models: ${config.input_phase_model || 'None'}`,
      `  datasets: ${config.datasets_folder}`
    ];
    
    if (config.optimization_mode === 'dft_estimated_entropy') {
      yamlLines.push(
        "  tags:",
        "    dft:",
        "      excluded_model_contributions:",
        "        - idmix",
        "        - mag",
        "    estimated-entropy:",
        "      excluded_model_contributions:",
        "        - idmix",
        "        - mag"
      );
    }
    
    yamlLines.push(
      "",
      "mcmc:",
      `  iterations: ${config.iterations}`,
      `  scheduler: ${config.scheduler}`,
      `  cores: ${config.cores}`,
      `  save_interval: ${config.save_interval}`,
      `  chains_per_parameter: ${config.chains_per_parameter}`,
      `  verbosity: ${config.output.verbosity}`,
      "",
      "symbols:",
      ...(config.symbols.length > 0 ? config.symbols.slice(0, 32).map(s => `  - ${s}`) : ["  []"])
    );

    if (selectedDataTypes.length > 0) {
      yamlLines.push("", "data_weights:");
      selectedDataTypes.forEach(dt => {
        const val = config.weights[dt] !== undefined ? config.weights[dt] : (dt === 'ZPF' ? 40 : dt === 'SM' ? 0.008 : 1);
        yamlLines.push(`  ${dt}: ${val}`);
      });
    }

    return yamlLines.join('\n');
  }, [config, selectedDataTypes]);

  const handleCommitResult = async (targetFolder: string) => {
    if (!refinedTDB) return;
    
    // Show a loading or committing message if necessary
    setSystemMessages(prev => [...prev, `[SYSTEM] Committing results to ${targetFolder}...`]);

    const base = config.output.output_db.replace(/\.tdb$/i, '');
    const newFiles: FileNode[] = [];
    
    if (refinedTDB) {
      newFiles.push({ id: Math.random().toString(36).substr(2, 9), name: config.output.output_db, type: 'file', content: refinedTDB, path: `${targetFolder}/${config.output.output_db}` });
    }
    
    if (executionLogs.length > 0) {
      newFiles.push({ id: Math.random().toString(36).substr(2, 9), name: config.output.logfile, type: 'file', content: executionLogs.join('\n'), path: `${targetFolder}/${config.output.logfile}` });
    }
    
    // Fetch trace.npy and prob.npy dynamically from backend to prevent SSE payload size crashes
    try {
      const traceRes = await fetch('/download-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: config.output.tracefile })
      });
      if (traceRes.ok) {
        const blob = await traceRes.blob();
        if (blob.size > 0) {
          const contents = URL.createObjectURL(blob);
          newFiles.push({ id: Math.random().toString(36).substr(2, 9), name: config.output.tracefile, type: 'file', content: contents, path: `${targetFolder}/${config.output.tracefile}` });
        }
      } else {
        const errText = await traceRes.text();
        setSystemMessages(prev => [...prev, `[WARNING] trace file not saved: backend returned ${traceRes.status} ${errText}`]);
      }
      
      const probRes = await fetch('/download-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: config.output.probfile })
      });
      if (probRes.ok) {
        const blob = await probRes.blob();
        if (blob.size > 0) {
          const contents = URL.createObjectURL(blob);
          newFiles.push({ id: Math.random().toString(36).substr(2, 9), name: config.output.probfile, type: 'file', content: contents, path: `${targetFolder}/${config.output.probfile}` });
        }
      } else {
        const errText = await probRes.text();
        setSystemMessages(prev => [...prev, `[WARNING] prob file not saved: backend returned ${probRes.status} ${errText}`]);
      }
    } catch (err) {
      setSystemMessages(prev => [...prev, `[ERROR] Failed to fetch binary artifacts: ${err}`]);
    }

    setFiles(prev => {
      const recursiveAdd = (nodes: FileNode[]): FileNode[] => {
        return nodes.map(node => {
          if (node.path === targetFolder) {
             return { ...node, children: [...(node.children || []), ...newFiles] };
          }
          if (node.children) {
             return { ...node, children: recursiveAdd(node.children) };
          }
          return node;
        });
      };
      return recursiveAdd(prev);
    });
    setSystemMessages(prev => [...prev, `[SUCCESS] Committed refinement artifacts to ${targetFolder}.`]);
    setSelectorConfig(null);
  };

  const handleCommitValidation = (targetFolder: string) => {
    if (!validationPlot && !validationCsv) return;
    const timestamp = new Date().getTime();
    const newFiles: FileNode[] = [];
    
    if (validationPlot) {
      newFiles.push({
        id: Math.random().toString(36).substr(2, 9),
        name: `validation_map_${timestamp}.png`,
        type: 'file',
        content: `data:image/png;base64,${validationPlot}`,
        path: `${targetFolder}/validation_map_${timestamp}.png`
      });
    }
    
    if (validationCsv) {
      newFiles.push({
        id: Math.random().toString(36).substr(2, 9),
        name: `validation_data_${timestamp}.csv`,
        type: 'file',
        content: validationCsv,
        path: `${targetFolder}/validation_data_${timestamp}.csv`
      });
    }

    setFiles(prev => {
      const recursiveAdd = (nodes: FileNode[]): FileNode[] => {
        return nodes.map(node => {
          if (node.path === targetFolder) {
            return { ...node, children: [...(node.children || []), ...newFiles] };
          }
          if (node.children) {
            return { ...node, children: recursiveAdd(node.children) };
          }
          return node;
        });
      };
      return recursiveAdd(prev);
    });
    setSystemMessages(prev => [...prev, `[SUCCESS] Committed validation artifacts to ${targetFolder}.`]);
    setSelectorConfig(null);
  };

  const handleRunAIAnalysis = async () => {
    if (!validationMetrics || !validationPlot) {
      setSystemMessages(prev => [...prev, "[AI ERROR] No validation data available for analysis."]);
      return;
    }

    setIsAiThinking(true);
    setActiveTab('AI');
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const activeSources = tdbComparisonList.filter(s => s.selected);
      const tdbDetails = activeSources.map(s => {
        let content = "";
        if (s.path === 'INTERNAL_INIT') content = findNodeByPath(files, config.input_tdb)?.content || "";
        else if (s.path === 'INTERNAL_MCMC') content = refinedTDB || "";
        else content = findNodeByPath(files, s.path)?.content || "";
        
        const metrics = validationMetrics[s.label] || { rmse: 'N/A', variance: 'N/A', count: 0 };
        const functions = content.split('\n').filter(l => l.trim().startsWith('FUNCTION VV'));
        return `
### Model: ${s.label}
- RMSE: ${metrics.rmse}
- Variance: ${metrics.variance}
- Data Points: ${metrics.count}
- Defined Functions (VV Parameters):
${functions.join('\n')}
        `;
      }).join('\n---\n');

      const prompt = `
### 🧠 Expert AI Advisor: Thermodynamic Full-Scale Benchmarking & TDB Synthesis Expert System

**Role:**
You are a Chief Scientist with top-tier expertise in **CALPHAD (Thermodynamic Calculation Method)**, **Materials Informatics**, and **Numerical Optimization**. You possess strong thermodynamic intuition and logical reasoning, capable of gaining insight into the nonlinear response of $VV$ parameters on phase equilibrium in the **Al-Si system** (or other systems) from multiple MCMC iterations.
**Your Core Task:**
By analyzing multiple versions of TDB source code, corresponding residual matrices ($\sigma_{ZPF}, \sigma_{ACR}, \sigma_{HM}$), and user-provided physical feedback, **deduce the optimal $VV$ parameter values that can simultaneously align phase boundaries, activities, and mixing enthalpies with experiments**, and output a full, runnable TDB file.

---

### 🛠️ Expert Reasoning Protocol

Please follow this 'Trinity' physical benchmarking principle for reasoning:

1.  **[Energy Balance Mapping]**: 
    *   **Analyze:** If the calculated Liquidus is too low, it indicates the Liquid phase is overly stable relative to solid phases (Diamond/FCC).
    *   **Reason:** You need to calculate the compensation for $\Delta G$ and locate the core variables controlling liquid stability (e.g., \`VV0017\` L0-H term or \`VV0015\` L1-H term).
2.  **[Property Locking Constraint]**:
    *   **Rule:** When optimizing ZPF, you must check changes in activity (ACR). If the activity curve slope is correct but the value shifts, fine-tune the L0 term; if curvature is wrong, fine-tune L1 or L2 terms.
    *   **Large Variation Permission:** You are authorized to step outside the current parameter search range, as long as logical reasoning proves the value satisfies experimental benchmarking in all three dimensions simultaneously.
3.  **[Structured Synthesis]**:
    *   Accurately fill the deduced optimal $VV$ values back into the \`FUNCTION\` section of the TDB, ensuring physical consistency in \`PARAMETER\` calling logic.

---

### 📊 Input Data Parsing Norms (Input Context)
You will receive a structured data packet containing:
*   **\`TDB_Registry\`**: Contains $N$ versions of TDB text fragments, especially the evolution history of \`FUNCTION VVxxxx\`.
*   **\`Triple_Residual_Matrix\`**: 
    *   $\sigma_{ACR}, \sigma_{HM}$: Fit for activity and enthalpy (Your baseline: must be kept at a very high level).
    *   $\sigma_{ZPF}$: Phase boundary deviation (Your main attack direction: minimize it by fine-tuning parameters).
*   **\`User_Heuristic_Feedback\`**: Physical feedback provided by the user.

**Actual Input Data:**

**TDB_Registry:**
${tdbDetails}

**Triple_Residual_Matrix:**
${JSON.stringify(validationMetrics, null, 2)}

**User_Heuristic_Feedback:**
${userFeedback || "None provided"}

---

### 📄 Output Format Requirements (Mandatory Deliverables)

Please output step-by-step using professional Markdown format:

#### 1. 🔬 Thermodynamic Logic Diagnosis
*   **Status Assessment**: Explain the specific contributions of parameters in current TDB versions to physical properties.
*   **Sensitivity Identification**: Point out which $VV$ variables are the key 'levers' to resolve the current ACR and ZPF contradiction.

#### 2. 🧪 Deduced Optimal Parameters
| Variable | Controlling Property | Initial Mean | **Expert Deduced Optimal Value** | Reasoning Logic |
| :--- | :--- | :--- | :--- | :--- |
| \`VV0017\` | LIQUID L0 (H) | ... | **...** | ... |

#### 3. 💾 Final Refined TDB Full Content (Ready for Production)
**This is the most important output.** Please directly output the complete TDB text.
*   **Strict Syntax**: Must include ALL blocks: \`ELEMENT\`, \`PHASE\`, \`CONSTITUENT\`, \`FUNCTION\`, \`PARAMETER\`.
*   **Variable Update**: All \`FUNCTION VVxxxx\` must be updated to the **optimal values** you deduced.
*   **Formatting Requirements**: Maintain standard Thermo-Calc / PyCalphad syntax (colons, exclamation marks, temperature ranges).

\`\`\`tdb
$ $$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$
$ Database Refined by Expert AI Advisor
$ Result: Triple-Property Optimization (ZPF + ACR + HM)
$ $$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$
ELEMENT ...
...
FUNCTION VV0012 1 [Your deduced optimal value]; 10000 N !
...
PARAMETER L(LIQUID,AL,SI;0) 1.0 T*VV0016+VV0017; 10000.0 N !
...
\`\`\`

#### 4. ⚙️ Subsequent MCMC Iteration Suggestions (Refined YAML)
Provide a suggested YAML configuration file to further validate your reasoning results, including suggested \`data_weights\` and \`priors\` ranges.

---

### ⚠️ Expert Redlines
*   **Strictly forbidden** to only suggest modifications for one or two parameters, **MUST** output the full TDB content.
*   **Must** ensure the definition of \`FUNCTION\` perfectly corresponds to the calling logic of \`PARAMETER\` in the generated TDB string (e.g. if VV0012 is defined, it must be used in a Parameter).
*   **IMPORTANT**: You MUST provide the entire response in ${aiLanguage === 'zh' ? 'Simplified Chinese' : 'English'}.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: validationPlot
            }
          }
        ],
        config: {
          systemInstruction: "You are a world-class CALPHAD expert and reasoning master. Your tone is professional, technical, and decisive."
        }
      });

      setAiAnalysis(response.text || "Analysis failed to generate.");
      setSystemMessages(prev => [...prev, "[AI SUCCESS] Technical diagnosis complete."]);
    } catch (e: any) {
      setSystemMessages(prev => [...prev, `[AI ERROR] ${e.message}`]);
    } finally {
      setIsAiThinking(false);
    }
  };

  return (
    <div className="h-full bg-black p-4 overflow-hidden relative font-sans">
      <div className="grid grid-cols-4 gap-4 h-full items-stretch overflow-hidden">
        
        {/* PANEL 1: Refinement Setup - ABSOLUTE PRESERVATION */}
        <div className="col-span-1 flex flex-col space-y-4 overflow-hidden">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 shrink-0 bg-black">
              <Settings size={16} className="text-[var(--industrial-accent)] mr-2" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--industrial-text)]">Refinement Setup</h3>
            </header>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Database size={12} className="text-amber-500" /><span>System Artifacts</span></div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase tracking-tighter">Input TDB Artifact</label>
                    <div className="flex space-x-2"><div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{config.input_tdb || 'Select TDB...'}</div><button onClick={() => setSelectorConfig({ mode: 'file', title: 'Select Input TDB', field: 'input_tdb' })} className="p-1.5 bg-black border border-[var(--industrial-border)] rounded-none text-[var(--industrial-accent)] hover:bg-[#1a1a1a]"><Layout size={14} /></button></div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase tracking-tighter">Phase Model Artifact</label>
                    <div className="flex space-x-2"><div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{config.input_phase_model || 'Select Phase Model...'}</div><button onClick={() => setSelectorConfig({ mode: 'file', title: 'Select Phase Model', field: 'input_phase_model' })} className="p-1.5 bg-black border border-[var(--industrial-border)] rounded-none text-[var(--industrial-accent)] hover:bg-[#1a1a1a]"><FileCode size={14} /></button></div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-black text-slate-600 uppercase tracking-tighter">Datasets Hub</label>
                    <div className="flex space-x-2">
                      <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono truncate">{config.datasets_folder}</div>
                      <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Select Datasets Folder', field: 'datasets_folder' })} className="p-1.5 bg-black border border-[var(--industrial-border)] rounded-none text-amber-400 hover:bg-[#1a1a1a]">
                        <FolderOpen size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Gauge size={12} className="text-[var(--industrial-accent)]" /><span>MCMC Engine</span></div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Iterations</label><input type="number" value={config.iterations} onChange={e => setConfig({...config, iterations: parseInt(e.target.value) || 0})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" /></div>
                  <div className="space-y-1">
                    <label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Chains / Param (Min 2)</label>
                    <div className="relative">
                      <input type="number" min="2" value={config.chains_per_parameter} onChange={e => setConfig({...config, chains_per_parameter: Math.max(2, parseInt(e.target.value) || 2)})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" />
                      <div className="absolute right-2 top-1.5 text-[8px] font-black text-amber-500 uppercase">Total: {config.symbols.length * config.chains_per_parameter}</div>
                    </div>
                  </div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Scheduler</label><select value={config.scheduler} onChange={e => setConfig({...config, scheduler: e.target.value as any})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono"><option value="dask">Dask</option><option value="null">Serial</option></select></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Cores</label><input type="number" value={config.cores} onChange={e => setConfig({...config, cores: parseInt(e.target.value) || 1})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Save Interval</label><input type="number" value={config.save_interval} onChange={e => setConfig({...config, save_interval: parseInt(e.target.value) || 10})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Verbosity</label><select value={config.output.verbosity} onChange={e => setConfig({...config, output: {...config.output, verbosity: parseInt(e.target.value)}})} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono"><option value={1}>1 (Low)</option><option value={2}>2 (High)</option></select></div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                    <Fingerprint size={12} className="text-rose-400" />
                    <span>Symbols Management</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button 
                      onClick={selectAllSymbols}
                      className="text-[8px] text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)] font-black uppercase border border-[var(--industrial-accent)]/30 px-1.5 py-0.5 rounded-none transition-colors"
                    >
                      Select All
                    </button>
                    <div className="text-[8px] text-slate-600 font-black uppercase tracking-tighter">Auto-Mapping</div>
                  </div>
                </div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                    {Object.entries(availableSymbols).map(([phase, syms]) => {
                      const phaseSyms = syms as string[];
                      const allPhaseSelected = phaseSyms.every(s => config.symbols.includes(s));
                      return (
                        <div key={phase} className="space-y-1">
                          <div className="flex items-center justify-between border-b border-[var(--industrial-border)] mb-1">
                            <div className="text-[8px] font-black text-slate-700 uppercase tracking-tighter">{phase}</div>
                            <button 
                              onClick={() => togglePhaseSymbols(phase)}
                              className={`text-[7px] font-black uppercase px-1 rounded-none transition-colors ${allPhaseSelected ? 'text-rose-400 hover:text-rose-300' : 'text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)]'}`}
                            >
                              {allPhaseSelected ? 'Deselect Phase' : 'Select Phase'}
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1 pb-2">
                            {phaseSyms.map(s => (
                              <button key={s} onClick={() => toggleSymbol(s)} className={`flex items-center space-x-2 px-2 py-1 rounded-none text-[9px] border transition-all ${config.symbols.includes(s) ? 'bg-[var(--industrial-accent)]/10 border-[var(--industrial-accent)]/30 text-[var(--industrial-accent)]' : 'bg-black border-transparent text-slate-600 hover:border-slate-800'}`}>
                                {config.symbols.includes(s) ? <CheckSquare size={10} /> : <Square size={10} />}<span className="truncate font-mono">{s}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Target size={12} className="text-[var(--industrial-accent)]" /><span>Prior Type</span></div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 grid grid-cols-2 gap-3">
                  <div className="col-span-2 space-y-1">
                    <label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Distribution</label>
                    <select 
                      value={config.prior.type}
                      onChange={e => setConfig({...config, prior: {...config.prior, type: e.target.value as any}})}
                      className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono"
                    >
                      <option value="normal">Normal</option>
                      <option value="triangular">Triangular</option>
                      <option value="uniform">Uniform</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">Loc/Scale Rel.</label>
                    <input 
                      type="number" 
                      step="0.1"
                      value={config.prior.loc_relative}
                      onChange={e => setConfig({...config, prior: {...config.prior, loc_relative: parseFloat(e.target.value) || 0}})}
                      className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" 
                    />
                  </div>
                  <div className="space-y-1 pt-4 flex items-center">
                    <input 
                      type="number" 
                      step="0.1"
                      value={config.prior.scale_relative}
                      onChange={e => setConfig({...config, prior: {...config.prior, scale_relative: parseFloat(e.target.value) || 0}})}
                      className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono" 
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest"><Settings size={12} className="text-[var(--industrial-accent)]" /><span>Optimization Mode</span></div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <select 
                    value={config.optimization_mode || 'default'}
                    onChange={e => setConfig({...config, optimization_mode: e.target.value})}
                    className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-[var(--industrial-accent)] font-mono"
                  >
                    <option value="default">Default</option>
                    <option value="dft_estimated_entropy">DFT & Estimated Entropy Weights</option>
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                    <SlidersHorizontal size={12} className="text-[var(--industrial-accent)]" />
                    <span>Data Weights</span>
                  </div>
                  <div className="relative">
                    <button 
                      onClick={() => setIsWeightsDropdownOpen(!isWeightsDropdownOpen)}
                      className="px-2 py-1 text-[8px] bg-black border border-[var(--industrial-border)] text-slate-400 hover:text-[var(--industrial-accent)] transition-colors uppercase font-bold tracking-widest flex items-center space-x-1"
                    >
                      <span>Select Data ({selectedDataTypes.length})</span>
                    </button>
                    {isWeightsDropdownOpen && (
                      <div className="absolute right-0 mt-1 w-32 bg-black border border-[var(--industrial-border)] shadow-2xl z-50">
                        {availableDataTypes.map(dt => (
                          <label key={dt} className="flex items-center space-x-2 px-3 py-2 hover:bg-[#1a1a1a] cursor-pointer">
                            <input 
                              type="checkbox"
                              checked={selectedDataTypes.includes(dt)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedDataTypes([...selectedDataTypes, dt]);
                                } else {
                                  setSelectedDataTypes(selectedDataTypes.filter(t => t !== dt));
                                }
                              }}
                              className="w-3 h-3 accent-[var(--industrial-accent)] bg-black border border-[var(--industrial-border)]"
                            />
                            <span className="text-[9px] text-slate-400 font-mono tracking-widest">{dt}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {selectedDataTypes.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                    {selectedDataTypes.map(dt => (
                      <div key={dt} className="space-y-1">
                        <label className="text-[8px] text-slate-600 font-bold uppercase ml-1 tracking-tighter">{dt} Weight</label>
                        <input 
                          type="number" 
                          value={config.weights[dt] !== undefined ? config.weights[dt] : (dt === 'ZPF' ? 40 : dt === 'SM' ? 0.008 : 1)} 
                          onChange={e => setConfig({...config, weights: {...config.weights, [dt]: parseFloat(e.target.value) || 0}})} 
                          className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" 
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3 pb-8">
                <div className="flex items-center justify-between text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <div className="flex items-center space-x-2"><FileCode size={12} className="text-slate-400" /><span>MCMC YAML Preview</span></div>
                  <button className="text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)]">View Full Protocol</button>
                </div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4"><pre className="text-[9px] font-mono text-slate-500 leading-normal overflow-x-auto whitespace-pre">{liveYaml}</pre></div>
              </div>
            </div>
          </div>
        </div>

        {/* PANEL 2: Live Monitor - ABSOLUTE PRESERVATION */}
        <div className="col-span-1 flex flex-col space-y-4 overflow-hidden h-full">
          <div className="flex-1 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden relative">
            <header className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 shrink-0 bg-black">
              <Activity size={16} className="text-[var(--industrial-accent)] mr-2" />
              <h3 className="text-[10px] font-black uppercase tracking-widest text-[var(--industrial-text)]">Live Engine Monitor</h3>
            </header>
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-5 mt-4 flex items-center justify-between">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-600 uppercase tracking-tighter">
                  <ScrollText size={10} />
                  <span>mcmc-log.txt Live Stream</span>
                </div>
                <button 
                  onClick={() => setIsLogExpanded(true)}
                  className="p-1 hover:bg-[#2a2a2a] rounded-none text-slate-500 hover:text-[var(--industrial-accent)] transition-colors"
                  title="Expand Log View"
                >
                  <Maximize2 size={12} />
                </button>
              </div>
              <div ref={logConsoleRef} className="flex-1 bg-black p-4 font-mono text-[9px] text-[var(--industrial-accent)]/80 overflow-y-auto custom-scrollbar leading-tight mt-2">
                {executionLogs.length > 300 && <div className="mb-0.5 border-l border-amber-500/50 pl-2 whitespace-pre-wrap text-amber-500 italic">... {executionLogs.length - 300} lines buffered ...</div>}
                {executionLogs.slice(-300).map((l, i) => <div key={i + Math.max(0, executionLogs.length - 300)} className={`mb-0.5 border-l border-[var(--industrial-accent)]/20 pl-2 whitespace-pre-wrap ${l.includes('Likelihood') ? 'text-amber-400' : l.includes('Proposal') ? 'text-sky-400' : ''}`}>{l}</div>)}
              </div>
              <div className="h-1/4 border-t border-[var(--industrial-border)] bg-black p-4 overflow-hidden flex flex-col">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-600 uppercase mb-2 tracking-tighter"><Terminal size={10} /><span>System Diagnostic Console</span></div>
                <div ref={systemConsoleRef} className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[9px] text-[var(--industrial-accent)]/80 space-y-1">
                  {systemMessages.map((m, i) => <div key={i} className="flex items-start space-x-2"><span className="text-slate-700 shrink-0">[{new Date().toLocaleTimeString()}]</span><span className="break-all">{m}</span></div>)}
                </div>
              </div>
            </div>

            <div className="p-5 bg-black border-t border-[var(--industrial-border)] shrink-0 space-y-4 shadow-inner">
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-600 uppercase tracking-widest"><HardDriveDownload size={12} className="text-[var(--industrial-accent)]" /><span>Refinement Result Commit</span></div>
                <div className="bg-black border border-[var(--industrial-border)] rounded-none p-4 space-y-3">
                    <div className="space-y-1">
                      <label className="text-[8px] font-black text-slate-600 uppercase tracking-tighter">Processing</label>
                      <div className="flex flex-col space-y-2">
                        <input 
                          type="text"
                          value={config.output.output_db}
                          onChange={e => {
                            const newName = e.target.value;
                            const base = newName.replace(/\.tdb$/i, '');
                            setConfig(prev => ({
                              ...prev,
                              output: {
                                ...prev.output,
                                output_db: newName,
                                tracefile: `trace-${base}.npy`,
                                probfile: `prob-${base}.npy`,
                                logfile: `${base}.log`
                              }
                            }));
                          }}
                          className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-3 py-1.5 text-[10px] text-amber-300 font-mono outline-none focus:border-amber-500/50"
                        />
                      </div>
                    </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-0.5">
                      <label className="text-[7px] text-slate-600 font-bold uppercase tracking-tighter">Trace Name</label>
                      <input 
                        type="text" 
                        value={config.output.tracefile} 
                        onChange={e => setConfig({...config, output: {...config.output, tracefile: e.target.value}})}
                        className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-1 text-[9px] text-slate-400 font-mono outline-none focus:border-[var(--industrial-accent)]/50" 
                      />
                    </div>
                    <div className="space-y-0.5">
                      <label className="text-[7px] text-slate-600 font-bold uppercase tracking-tighter">Prob Name</label>
                      <input 
                        type="text" 
                        value={config.output.probfile} 
                        onChange={e => setConfig({...config, output: {...config.output, probfile: e.target.value}})}
                        className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-1 text-[9px] text-slate-400 font-mono outline-none focus:border-[var(--industrial-accent)]/50" 
                      />
                    </div>
                    <div className="space-y-0.5">
                      <label className="text-[7px] text-slate-600 font-bold uppercase tracking-tighter">Log Name</label>
                      <input 
                        type="text" 
                        value={config.output.logfile} 
                        onChange={e => setConfig({...config, output: {...config.output, logfile: e.target.value}})}
                        className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-1 text-[9px] text-slate-400 font-mono outline-none focus:border-[var(--industrial-accent)]/50" 
                      />
                    </div>
                  </div>
                  <button onClick={() => setSelectorConfig({ mode: 'folder', title: 'Commit to Resource Hub', field: 'mcmc_save' })} disabled={!refinedTDB} className="w-full py-2 mt-2 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 disabled:bg-slate-800 disabled:text-slate-500 text-black rounded-none text-[9px] font-black uppercase transition-all shadow-lg flex items-center justify-center space-x-2">
                    <HardDriveDownload size={12} />
                    <span>Commit Results to Hub</span>
                  </button>
                </div>
              </div>
              <button onClick={isOptimizing ? stopMCMC : runMCMC} className={`w-full h-12 flex items-center justify-center space-x-4 rounded-none font-black uppercase tracking-[0.2em] text-[10px] shadow-xl transition-all active:scale-[0.98] ${isOptimizing ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 text-black'}`}>
                {isOptimizing ? <X size={20} /> : <Zap size={20} />}<span>{isOptimizing ? 'Abort Refinement' : 'Execute Refinement'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* PANEL 3: VALIDATION HUB - ADDED COORDINATE & ELEMENT SELECTION */}
        <div className="col-span-2 flex flex-col bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl overflow-hidden h-full relative">
          {isValidating && (
            <div className="absolute inset-0 z-50 bg-black backdrop-blur-sm flex flex-col items-center justify-center space-y-6 animate-in fade-in duration-300">
               <div className="relative"><Loader2 size={80} className="text-[var(--industrial-accent)] animate-spin" /><Database size={32} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white/20" /></div>
               <p className="text-xs font-black text-[var(--industrial-accent)] uppercase tracking-[0.3em]">Mapping Multi-TDB Artifacts...</p>
            </div>
          )}

          <header className="h-12 border-b border-[var(--industrial-border)] flex items-center bg-black px-1 shrink-0">
             {(['MAPS', 'TRACE', 'AI'] as const).map(t => (
                <button key={t} onClick={() => setActiveTab(t)} className={`flex-1 h-full flex items-center justify-center text-[9px] font-black uppercase tracking-widest transition-all border-b-2 ${activeTab === t ? 'border-[var(--industrial-accent)] text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' : 'border-transparent text-slate-600 hover:text-slate-400'}`}>
                 {t === 'MAPS' ? 'Validation Map' : t === 'TRACE' ? 'Parameter Trace' : 'Expert AI Advisor'}
               </button>
             ))}
          </header>

          <div className="flex-1 flex flex-col p-4 space-y-3 overflow-hidden">
             {activeTab === 'MAPS' && (
               <div className="flex-1 flex flex-col space-y-3 overflow-hidden">
                 <div className="space-y-3 shrink-0">
                    <div className="flex items-center justify-between"><div className="flex items-center space-x-2 text-[8px] font-black text-slate-600 uppercase tracking-widest"><FileStack size={12} className="text-[var(--industrial-accent)]" /><span>Comparison Scenario Manager</span></div><button onClick={() => setSelectorConfig({ mode: 'file', title: 'Add TDB to Comparison', field: 'add_tdb' })} className="px-3 py-1 bg-black hover:bg-[var(--industrial-accent)]/10 text-[var(--industrial-accent)] text-[8px] font-black uppercase rounded-none border border-[var(--industrial-accent)]/20 transition-all flex items-center space-x-2"><Plus size={10} /><span>Append Solution</span></button></div>
                    <div className="flex flex-wrap gap-2 py-2">
                       {tdbComparisonList.map(s => (
                         <div key={s.id} className={`flex items-center space-x-2 px-2 py-1 border ${s.selected ? 'border-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' : 'border-[var(--industrial-border)] bg-black'} transition-all`}>
                           <button onClick={() => toggleComparisonSelected(s.id)} className={`p-0.5 ${s.selected ? 'text-[var(--industrial-accent)]' : 'text-slate-600'}`}>
                             {s.selected ? <CheckSquare size={10} /> : <Square size={10} />}
                           </button>
                           <span className={`text-[8px] font-black uppercase tracking-tighter ${s.selected ? 'text-white' : 'text-slate-600'}`}>{s.label}</span>
                           {s.id !== 'initial' && s.id !== 'current' && (
                             <button onClick={() => setTdbComparisonList(prev => prev.filter(item => item.id !== s.id))} className="text-slate-700 hover:text-rose-500 transition-colors ml-1">
                               <Trash size={10} />
                             </button>
                           )}
                         </div>
                       ))}
                    </div>
                    <div className="bg-black border border-[var(--industrial-border)] p-3.5 rounded-none flex items-center justify-between shrink-0">
                       <div className="flex flex-col"><span className="text-[7px] font-black text-slate-600 uppercase mb-0.5 tracking-tighter">Mapping Mode</span><div className="flex flex-wrap gap-1">{(['PD', 'ACR', 'HM_MIX', 'DRIVING_FORCE'] as const).map(m => (<button key={m} onClick={() => setValidationMode(m)} className={`px-2 py-0.5 rounded-none text-[9px] font-bold uppercase tracking-tighter ${validationMode === m ? 'bg-[var(--industrial-accent)] text-black' : 'text-slate-600 hover:text-slate-400'}`}>{m === 'DRIVING_FORCE' ? 'Driving Force' : m === 'HM_MIX' ? 'Mixing Enthalpy' : m === 'ACR' ? 'Activity' : 'Phase Diagram'}</button>))}</div></div>
                     </div>
                  </div>

                  {/* ENHANCED PARAMETER GRID: Added X-Axis & Activity Element selection */}
                  <div className="bg-black border border-[var(--industrial-border)] p-3 rounded-none shadow-xl shrink-0">
                    <div className="flex items-end justify-between gap-4">
                      <div className="flex items-end gap-2 flex-1 overflow-x-auto custom-scrollbar pb-1">
                        {(validationMode === 'PD' || validationMode === 'DRIVING_FORCE') ? (
                          <>
                            <div className="w-24 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">T Min</label><input type="number" value={valParams.tMin} onChange={e => setValParams(p => ({...p, tMin: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" /></div>
                            <div className="w-24 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">T Max</label><input type="number" value={valParams.tMax} onChange={e => setValParams(p => ({...p, tMax: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" /></div>
                            <div className="w-24 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">T Step</label><input type="number" value={valParams.tStep} onChange={e => setValParams(p => ({...p, tStep: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" /></div>
                            <div className="w-32 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">X-Axis</label><select value={valParams.targetComp} onChange={e => setValParams(p => ({...p, targetComp: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-emerald-300 font-mono outline-none">{availableComps.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                          </>
                        ) : (
                          <>
                            <div className="w-24 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">Temp (K)</label><input type="number" value={valParams.targetTemp} onChange={e => setValParams(p => ({...p, targetTemp: parseInt(e.target.value)}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-[var(--industrial-accent)] font-mono outline-none" /></div>
                            <div className="w-32 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">Phase</label><select value={valParams.targetPhase} onChange={e => setValParams(p => ({...p, targetPhase: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-amber-300 font-mono outline-none">{availablePhases.map(ph => <option key={ph} value={ph}>{ph}</option>)}</select></div>
                            <div className="w-32 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">X-Axis</label><select value={valParams.targetComp} onChange={e => setValParams(p => ({...p, targetComp: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-emerald-300 font-mono outline-none">{availableComps.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                            {validationMode === 'ACR' && (
                              <div className="w-32 shrink-0 space-y-1.5"><label className="text-[8px] font-black text-slate-600 uppercase ml-1 tracking-tighter">Active El</label><select value={valParams.activityEl} onChange={e => setValParams(p => ({...p, activityEl: e.target.value}))} className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-2 py-2 text-[10px] text-rose-300 font-mono outline-none">{availableComps.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center space-x-1 shrink-0">
                        <button onClick={handleRunValidation} disabled={isValidating} className="px-3 h-10 flex items-center justify-center space-x-1 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent)]/80 text-black rounded-none font-black uppercase text-[9px] shadow-xl transition-all active:scale-95 shrink-0">
                          <Zap size={14} />
                          <span>Map</span>
                        </button>
                        <button 
                          onClick={() => setIsTableExpanded(true)} 
                          disabled={!validationCsv} 
                          className="px-2 h-10 flex items-center justify-center space-x-1 bg-black hover:bg-[#1a1a1a] disabled:opacity-30 text-emerald-400 rounded-none font-black uppercase text-[9px] border border-[var(--industrial-border)] transition-all active:scale-95 shrink-0"
                          title="View Data Table"
                        >
                          <FileSpreadsheet size={14} />
                        </button>
                        <button 
                          onClick={() => setSelectorConfig({ mode: 'folder', title: 'Commit Validation to Hub', field: 'val_save' })} 
                          disabled={!validationPlot && !validationCsv} 
                          className="px-2 h-10 flex items-center justify-center space-x-1 bg-[var(--industrial-accent)]/20 hover:bg-[var(--industrial-accent)]/30 disabled:opacity-30 text-[var(--industrial-accent)] rounded-none font-black uppercase text-[9px] border border-[var(--industrial-accent)]/20 transition-all active:scale-95 shrink-0"
                          title="Commit to Resource Hub"
                        >
                          <Save size={14} />
                        </button>
                        <div className="flex items-center space-x-1 bg-black border border-[var(--industrial-border)] rounded-none px-1 h-10 shrink-0">
                          <button 
                            onClick={() => setAiLanguage('zh')}
                            className={`px-2 h-8 rounded-none text-[8px] font-black uppercase transition-all ${aiLanguage === 'zh' ? 'bg-rose-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                          >
                            CN
                          </button>
                          <button 
                            onClick={() => setAiLanguage('en')}
                            className={`px-2 h-8 rounded-none text-[8px] font-black uppercase transition-all ${aiLanguage === 'en' ? 'bg-rose-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                          >
                            EN
                          </button>
                        </div>
                        <button 
                          onClick={handleRunAIAnalysis}
                          disabled={!validationMetrics || isAiThinking}
                          className="px-2 h-10 flex items-center justify-center space-x-1 bg-rose-600 hover:bg-rose-500 disabled:opacity-30 text-white rounded-none font-black uppercase text-[9px] shadow-xl transition-all active:scale-95 shrink-0"
                          title="Consult Expert AI Advisor"
                        >
                          {isAiThinking ? <Loader2 size={14} className="animate-spin" /> : <BrainCircuit size={14} />}
                          <span>AI</span>
                        </button>
                      </div>
                    </div>
                    
                    {/* User Feedback Input */}
                    <div className="mt-2 px-1">
                      <div className="relative">
                        <input 
                          type="text" 
                          value={userFeedback}
                          onChange={(e) => setUserFeedback(e.target.value)}
                          placeholder="Optional: Provide heuristic feedback (e.g., 'Eutectic temp is too low', 'Liquid is too stable')..."
                          className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-4 py-2 text-[10px] text-slate-300 placeholder:text-slate-600 focus:border-rose-500/50 outline-none transition-all"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[8px] font-black text-slate-600 uppercase pointer-events-none">
                          Human Feedback
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none overflow-hidden relative group flex items-center justify-center min-h-[200px]">
                    {validationPlot ? (
                      <div 
                         className="relative w-full h-full flex items-center justify-center p-4 cursor-zoom-in group/img"
                         onClick={() => setIsMapExpanded(true)}
                       >
                        <img src={`data:image/png;base64,${validationPlot}`} className="max-h-full max-w-full object-contain shadow-2xl transition-transform duration-300 group-hover/img:scale-[1.02]" />
                         <div className="absolute inset-0 bg-[var(--industrial-accent)]/0 group-hover/img:bg-[var(--industrial-accent)]/5 transition-colors flex items-center justify-center">
                           <Maximize2 size={32} className="text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow-lg" />
                         </div>
                      </div>
                    ) : (<div className="opacity-10 flex flex-col items-center select-none cursor-default"><ImageIcon size={160} /><span className="text-2xl font-black uppercase tracking-[0.8em] mt-4">Perspective Empty</span></div>)}
                 </div>
               </div>
             )}

             {activeTab === 'TRACE' && (
               <div className="flex-1 flex flex-col space-y-6 overflow-hidden">
                 <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none p-8 overflow-auto custom-scrollbar">
                   {refinedTrace && refinedProb ? (
                     <div className="space-y-8">
                       <div className="flex items-center space-x-4">
                         <LineChartIcon size={24} className="text-[var(--industrial-accent)]" />
                         <h4 className="text-sm font-bold text-white uppercase tracking-tight">
                           Convergence Trace
                           {isOptimizing && <span className="text-emerald-400 animate-pulse ml-2 text-[10px]">● LIVE SYNC</span>}
                         </h4>
                       </div>
                       
                       {/* Log Probability Chart */}
                       <div className="bg-black p-6 rounded-none border border-[var(--industrial-border)]">
                         <h5 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">Log-Probability Convergence (lnprob)</h5>
                         <div className="h-64 w-full">
                           <ResponsiveContainer width="100%" height="100%">
                             <LineChart data={memoProbData}>
                               <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" opacity={0.5} />
                               <XAxis type="number" dataKey="iteration" domain={['dataMin', 'dataMax']} stroke="#475569" fontSize={10} tickFormatter={(val) => `Iter ${val}`} />
                               <YAxis stroke="#475569" fontSize={10} domain={['auto', 'auto']} scale="auto" />
                               <Tooltip 
                                 contentStyle={{ backgroundColor: '#050505', borderColor: '[var(--industrial-border)]', fontSize: '10px' }} 
                                 itemStyle={{ color: '#cbd5e1' }}
                                 labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                               />
                               {refinedProb[0] && refinedProb[0].map((_: any, idx: number) => (
                                 <Line 
                                   key={idx} 
                                   type="linear" connectNulls 
                                   dataKey={`chain_${idx}`} 
                                   stroke={`hsl(${idx * 30}, 70%, 60%)`} 
                                   dot={false} 
                                   strokeWidth={1.5} 
                                   isAnimationActive={false}
                                 />
                               ))}
                             </LineChart>
                           </ResponsiveContainer>
                         </div>
                       </div>

                       {/* Parameter Traces */}
                       <div className="grid grid-cols-1 gap-6">
                         {config.symbols.slice(0, 32).map((symbol, pIdx) => (
                           <div key={symbol} className="bg-black p-6 rounded-none border border-[var(--industrial-border)]">
                             <h5 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">Parameter Trace: {symbol}</h5>
                             <div className="h-48 w-full">
                               <ResponsiveContainer width="100%" height="100%">
                                 <LineChart data={memoTraceData[symbol] || []}>
                                   <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" opacity={0.5} />
                                   <XAxis type="number" dataKey="iteration" domain={['dataMin', 'dataMax']} stroke="#475569" fontSize={10} tickFormatter={(val) => `Iter ${val}`} />
                                   <YAxis stroke="#475569" fontSize={10} domain={['auto', 'auto']} />
                                   <Tooltip 
                                     contentStyle={{ backgroundColor: '#050505', borderColor: '[var(--industrial-border)]', fontSize: '10px' }} 
                                     itemStyle={{ color: '#cbd5e1' }}
                                   />
                                   {refinedTrace[0] && refinedTrace[0].map((_: any, cIdx: number) => (
                                     <Line 
                                       key={cIdx} 
                                       type="linear" 
                                       connectNulls
                                        dataKey={`chain_${cIdx}`} 
                                       stroke={`hsl(${cIdx * 30}, 70%, 60%)`} 
                                       dot={false} 
                                       strokeWidth={1} 
                                       isAnimationActive={false}
                                     />
                                   ))}
                                 </LineChart>
                               </ResponsiveContainer>
                             </div>
                           </div>
                         ))}
                       </div>
                     </div>
                   ) : (<div className="h-full flex flex-col items-center justify-center opacity-20"><Activity size={80} /><span className="mt-4 text-xs font-black uppercase tracking-widest">No Trace Data Available</span></div>)}
                 </div>
               </div>
             )}

             {activeTab === 'AI' && (
               <div className="flex-1 flex flex-col space-y-6 overflow-hidden">
                 <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none p-10 overflow-auto custom-scrollbar relative">
                   {isAiThinking && (<div className="absolute inset-0 z-10 bg-black flex items-center justify-center"><Loader2 size={48} className="text-[var(--industrial-accent)] animate-spin" /></div>)}
                   {aiAnalysis ? (
                     <div className="prose prose-invert prose-sm max-w-none"><div className="flex items-center space-x-4 mb-8"><div className="p-3 bg-[var(--industrial-accent)] rounded-none"><BrainCircuit size={24} className="text-black" /></div><h4 className="text-lg font-black text-white uppercase tracking-tight">Expert Technical Diagnosis</h4></div><div className="whitespace-pre-wrap text-slate-300 leading-relaxed font-sans bg-black p-8 rounded-none border border-[var(--industrial-border)]">{aiAnalysis}</div></div>
                   ) : (<div className="h-full flex flex-col items-center justify-center opacity-20"><Sparkles size={80} /><span className="mt-4 text-xs font-black uppercase tracking-widest">AI evaluation sequence pending...</span></div>)}
                 </div>
               </div>
             )}
          </div>
          
          <footer className="h-10 border-t border-[var(--industrial-border)] bg-black flex items-center px-8 justify-between shrink-0">
             <div className="flex items-center space-x-4 text-[9px] font-bold uppercase tracking-widest text-slate-600"><span>ThermoAI Multi-Scenario Suite V11.4</span><span className="w-1 h-1 rounded-full bg-slate-800" /><span>Comparing {tdbComparisonList.filter(s=>s.selected).length} Models</span></div>
             <div className="flex items-center space-x-2"><span className={`w-2 h-2 rounded-full ${isOptimizing ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'}`} /><span className="text-[9px] font-black text-slate-500 uppercase">{isOptimizing ? 'Engine Live' : 'Engine Idle'}</span></div>
          </footer>
        </div>
      </div>

      {selectorConfig && (
        <FileSelectorModal 
          files={files} mode={selectorConfig.mode} title={selectorConfig.title} onClose={() => setSelectorConfig(null)}
          onConfirm={(path) => {
            if (selectorConfig.field === 'input_tdb') setConfig(prev => ({ ...prev, input_tdb: path as string }));
            else if (selectorConfig.field === 'input_phase_model') setConfig(prev => ({ ...prev, input_phase_model: path as string }));
            else if (selectorConfig.field === 'datasets_folder') setConfig(prev => ({ ...prev, datasets_folder: path as string }));
            else if (selectorConfig.field === 'val_ds') setValDsPath(path as string);
            else if (selectorConfig.field === 'mcmc_save') handleCommitResult(path as string);
            else if (selectorConfig.field === 'val_save') handleCommitValidation(path as string);
            else if (selectorConfig.field === 'add_tdb') addComparisonSource(path as string);
            setSelectorConfig(null);
          }}
        />
      )}

      {/* Log Expansion Modal */}
      {isLogExpanded && (
        <div className="fixed inset-0 z-[100] bg-black backdrop-blur-md flex items-center justify-center p-8 animate-in fade-in zoom-in duration-200">
          <div className="w-full max-w-6xl h-full bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl flex flex-col overflow-hidden">
            <header className="h-16 border-b border-[var(--industrial-border)] flex items-center px-8 justify-between bg-black shrink-0">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-[var(--industrial-accent)]/20 rounded-none">
                  <ScrollText size={20} className="text-[var(--industrial-accent)]" />
                </div>
                <h3 className="text-sm font-black uppercase tracking-widest text-white">mcmc-log.txt Live Stream (Expanded)</h3>
              </div>
              <button 
                onClick={() => setIsLogExpanded(false)}
                className="p-2 hover:bg-[#2a2a2a] rounded-none text-slate-400 hover:text-white transition-colors"
              >
                <X size={24} />
              </button>
            </header>
            <div className="flex-1 bg-black p-8 font-mono text-xs text-[var(--industrial-accent)]/90 overflow-y-auto custom-scrollbar leading-relaxed">
              {executionLogs.length > 0 ? (
                <>
                  {executionLogs.length > 300 && <div className="mb-1 border-l-2 border-amber-500/50 pl-4 whitespace-pre-wrap text-amber-500 italic hover:bg-amber-500/5 transition-colors">... {executionLogs.length - 300} earlier logs hidden to optimize display ...</div>}
                  {executionLogs.slice(-300).map((l, i) => (
                    <div key={i + Math.max(0, executionLogs.length - 300)} className="mb-1 border-l-2 border-[var(--industrial-accent)]/30 pl-4 whitespace-pre-wrap hover:bg-[var(--industrial-accent)]/5 transition-colors">
                      {l}
                    </div>
                  ))}
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center opacity-20 select-none">
                  <Terminal size={64} />
                  <span className="mt-4 text-sm font-black uppercase tracking-widest">No logs recorded yet...</span>
                </div>
              )}
            </div>
            <footer className="h-12 border-t border-[var(--industrial-border)] bg-black px-8 flex items-center justify-between shrink-0">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                Total Entries: {executionLogs.length}
              </div>
              <div className="flex items-center space-x-4">
                <button 
                  onClick={() => {
                    const text = executionLogs.join('\n');
                    navigator.clipboard.writeText(text);
                  }}
                  className="flex items-center space-x-2 text-[10px] font-black text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)] uppercase"
                >
                  <Copy size={14} />
                  <span>Copy to Clipboard</span>
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* Map Expansion Modal */}
      {isMapExpanded && validationPlot && (
        <div className="fixed inset-0 z-[100] bg-black backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in zoom-in duration-200">
          <div className="relative w-full h-full flex flex-col items-center justify-center">
            <button 
              onClick={() => setIsMapExpanded(false)}
              className="absolute top-4 right-4 p-3 bg-black hover:bg-[#2a2a2a] rounded-none text-white transition-all z-10 shadow-2xl border border-[var(--industrial-border)]"
            >
              <X size={24} />
            </button>
            <div className="w-full h-full flex items-center justify-center p-8">
              <img 
                src={`data:image/png;base64,${validationPlot}`} 
                className="max-h-full max-w-full object-contain shadow-[0_0_100px_rgba(79,70,229,0.2)] rounded-none" 
              />
            </div>
            <div className="absolute bottom-8 px-6 py-2 bg-black border border-[var(--industrial-border)] rounded-none backdrop-blur-md">
              <p className="text-[10px] font-black text-[var(--industrial-accent)] uppercase tracking-[0.4em]">Validation Map Artifact • High Resolution View</p>
            </div>
          </div>
        </div>
      )}

      {/* Data Table Modal */}
      {isTableExpanded && validationCsv && (
        <div className="fixed inset-0 z-[100] bg-black backdrop-blur-md flex items-center justify-center p-8 animate-in fade-in zoom-in duration-200">
          <div className="w-full max-w-6xl h-full bg-black border border-[var(--industrial-border)] rounded-none shadow-2xl flex flex-col overflow-hidden">
            <header className="h-16 border-b border-[var(--industrial-border)] flex items-center px-8 justify-between bg-black shrink-0">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-emerald-600/20 rounded-none">
                  <FileSpreadsheet size={20} className="text-emerald-400" />
                </div>
                <h3 className="text-sm font-black uppercase tracking-widest text-white">Validation Data Artifacts</h3>
              </div>
              <div className="flex items-center space-x-4">
                <button 
                  onClick={() => {
                    const blob = new Blob([validationCsv], { type: 'text/csv' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `validation_data_${new Date().getTime()}.csv`;
                    a.click();
                  }}
                  className="flex items-center space-x-2 text-[10px] font-black text-emerald-400 hover:text-emerald-300 uppercase px-4 py-2 bg-emerald-400/10 rounded-none border border-emerald-500/20 transition-all"
                >
                  <Download size={14} />
                  <span>Export CSV</span>
                </button>
                <button 
                  onClick={() => setIsTableExpanded(false)}
                  className="p-2 hover:bg-[#2a2a2a] rounded-none text-slate-400 hover:text-white transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-auto custom-scrollbar p-0">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-black z-10">
                  <tr>
                    {validationCsv.split('\n')[0].split(',').map((header, i) => (
                      <th key={i} className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-slate-500 border-b border-[var(--industrial-border)]">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--industrial-border)]/50">
                  {validationCsv.split('\n').slice(1).filter(row => row.trim()).map((row, i) => (
                    <tr key={i} className="hover:bg-white/5 transition-colors">
                      {row.split(',').map((cell, j) => (
                        <td key={j} className="px-6 py-3 text-[11px] font-mono text-slate-300 border-b border-[var(--industrial-border)]/30">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="h-12 border-t border-[var(--industrial-border)] bg-black px-8 flex items-center justify-between shrink-0">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                Total Records: {validationCsv.split('\n').length - 1}
              </div>
              <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                Format: Scientific CSV Standard
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};

export default Monitor;
