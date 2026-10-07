
import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart3, TrendingUp, PieChart, Info, Download, Maximize2, 
  Upload, Play, Settings, Activity, Layers, Thermometer, FileText, Database, Terminal, Save, ExternalLink,
  Plus, Trash2
} from 'lucide-react';
import FileSelectorModal from './FileSelectorModal';
import { FileNode } from '../types';

interface AnalysisProps {
  files: FileNode[];
}

const Analysis: React.FC<AnalysisProps> = ({ files }) => {
  const [tdbContent, setTdbContent] = useState<string>("");
  const [traceContent, setTraceContent] = useState<string>("");
  const [tdbPath, setTdbPath] = useState<string>("");
  const [tracePath, setTracePath] = useState<string>("");
  const [tdbFileName, setTdbFileName] = useState<string>("");
  const [traceFileName, setTraceFileName] = useState<string>("");
  const [datasetsPath, setDatasetsPath] = useState<string>("");
  const [datasetsFileName, setDatasetsFileName] = useState<string>("");
  
  const [showTdbModal, setShowTdbModal] = useState(false);
  const [showTraceModal, setShowTraceModal] = useState(false);
  const [showDsModal, setShowDsModal] = useState(false);

  const tdbInputRef = useRef<HTMLInputElement>(null);
  const traceInputRef = useRef<HTMLInputElement>(null);

  const handleLocalFileUpload = (event: React.ChangeEvent<HTMLInputElement>, type: 'tdb' | 'trace') => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (type === 'tdb') {
        setTdbFileName(file.name);
        setTdbPath(file.name); // Local file, path is just name
        setTdbContent(content);
        inspectTdb(file.name, content);
      } else {
        setTraceFileName(file.name);
        setTracePath(file.name); // Local file, path is just name
        setTraceContent(content); // Data URL for binary
      }
    };

    if (type === 'tdb') {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  const [calcType, setCalcType] = useState<string>("single_point");
  const [loading, setLoading] = useState<boolean>(false);
  const [resultImages, setResultImages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = (imgData: string, index: number) => {
    const link = document.createElement('a');
    link.href = imgData;
    link.download = `analysis_result_${index + 1}.png`;
    link.click();
  };

  const handleSaveToHub = async (imgData: string, index: number) => {
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: `analysis_result_${index + 1}.png`,
          content: imgData.split(',')[1],
          encoding: 'base64'
        })
      });
      if (response.ok) {
        alert('Image saved to file storage hub successfully!');
      } else {
        throw new Error('Failed to save image');
      }
    } catch (err) {
      console.error('Save error:', err);
      alert('Failed to save image to file storage hub.');
    }
  };

  const handleMaximize = (imgData: string) => {
    const newWindow = window.open('', '_blank');
    if (newWindow) {
      newWindow.document.write(`<img src="${imgData}" style="width:100%; height:100%; object-fit:contain;" />`);
    }
  };

  const findNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
    const parts = path.split('/').filter(p => p !== '');
    let current: FileNode | null = null;
    let currentNodes = nodes;
    for (const part of parts) {
      current = currentNodes.find(n => n.name === part) || null;
      if (!current) return null;
      if (current.children) currentNodes = current.children;
    }
    return current;
  };

  const collectRecursiveDatasets = (path: string): any[] => {
    const data: any[] = [];
    const rootNode = findNodeByPath(files, path);
    if (!rootNode) return data;
    const traverse = (node: FileNode) => {
      if (node.type === 'file' && node.name.toLowerCase().endsWith('.json') && node.content) {
        try { 
          const parsed = JSON.parse(node.content); 
          // Check if it looks like experimental data for invariant plotting
          // If it has 'x' and 'T' fields, we can use it.
          // Or if it's a list of such objects.
          if (Array.isArray(parsed)) {
            parsed.forEach(item => {
              if (item.x !== undefined && item.T !== undefined) data.push(item);
            });
          } else if (parsed.x !== undefined && parsed.T !== undefined) {
            data.push(parsed);
          } else if (parsed.output || parsed.values || parsed.reference) {
             // Standard ESPEI dataset format, might need extraction logic
             // For now, let's just collect it and let the backend handle it if needed
             data.push(parsed);
          }
        } catch (e) {}
      }
      if (node.children) node.children.forEach(traverse);
    };
    traverse(rootNode);
    return data;
  };

  const [params, setParams] = useState<any>({
    T: 1000,
    P: 101325,
    composition: {},
    t_min: 500,
    t_max: 1500,
    t_step: 20,
    x_component: '',
    target_phase: 'LIQUID',
    uq_phases: [],
    yscale: 1.0,
    ylabel: '',
    xlabel: '',
    xlim_min: '',
    xlim_max: '',
    property: 'GM',
    vary: 'T',
    fixed_val: 0.5,
    min: 300,
    max: 1500,
    steps: 50,
    x_guess: 0.5,
    t_low: 500,
    t_high: 1000,
    component: '',
    bw: 0.5,
    prob_levels: [
      { prob: 0.6, color: '#92c5de' },
      { prob: 0.8, color: '#0571b0' },
      { prob: 0.9, color: '#2166ac' }
    ],
    // Isolated fields for Phase Fraction
    pf_T_fixed: 1000,
    pf_T_min: 300,
    pf_T_max: 2000,
    pf_T_steps: 50,
    pf_X_fixed: 0.1,
    pf_X_min: 0,
    pf_X_max: 1,
    pf_X_steps: 50,
    n_clusters: '',
    // Isolated fields for Property UQ
    uq_T_fixed: 1000,
    uq_T_min: 300,
    uq_T_max: 2000,
    uq_T_steps: 50,
    uq_X_fixed: 0.1,
    uq_X_min: 0,
    uq_X_max: 1,
    uq_X_steps: 50
  });

  const inspectTdb = async (path: string, content: string) => {
    try {
      const response = await fetch('/analysis/inspect_tdb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tdb_path: path, tdb_content: content })
      });
      
      if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}`);
      }
      
      const text = await response.text();
      let data;
      try {
          data = JSON.parse(text);
      } catch (e) {
          console.error("Failed to parse JSON response from inspect_tdb:", text);
          throw new Error(`Invalid JSON response from server (inspect_tdb). The backend might be misconfigured.\nResponse snippet: ${text.slice(0, 200)}`);
      }
      
      if (data.status === 'success') {
        setAvailableComponents(data.components);
        setAvailablePhases(data.phases);
        
        const nonVaComps = data.components.filter((c: string) => c !== 'VA');
        const defaultComp = nonVaComps.length > 0 ? nonVaComps[0] : '';
        const defaultPhase = data.phases.length > 0 ? data.phases[0] : '';
        
        setParams((prev: any) => ({
          ...prev,
          x_component: prev.x_component && nonVaComps.includes(prev.x_component) ? prev.x_component : defaultComp,
          component: prev.component && nonVaComps.includes(prev.component) ? prev.component : defaultComp,
          target_phase: prev.target_phase && data.phases.includes(prev.target_phase) ? prev.target_phase : defaultPhase,
        }));
      }
    } catch (e) {
      console.error("Failed to inspect TDB", e);
    }
  };

  const inspectTrace = async (path: string) => {
    setIsInspecting(true);
    try {
      const response = await fetch('/analysis/inspect_trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trace_path: path, calculation_type: 'trace', parameters: {} })
      });
      
      if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}`);
      }
      
      const text = await response.text();
      let data;
      try {
          data = JSON.parse(text);
      } catch (e) {
          console.error("Failed to parse JSON response from inspect_trace:", text);
          throw new Error(`Invalid JSON response from server (inspect_trace). The backend might be misconfigured.\nResponse snippet: ${text.slice(0, 200)}`);
      }
      
      if (data.status === 'success') {
        setTraceShape(String(data.shape));
      }
    } catch (e) {
      console.error("Failed to inspect trace", e);
    } finally {
      setIsInspecting(false);
    }
  };

  const findFileByPath = (nodes: FileNode[], path: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findFileByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const handleFileSelect = (path: string | string[], type: 'tdb' | 'trace') => {
    const selectedPath = Array.isArray(path) ? path[0] : path;
    const fileName = selectedPath.split('/').pop() || selectedPath;
    
    // Find the file node to get content if available (for imported files)
    const fileNode = findFileByPath(files, selectedPath);
    const content = fileNode?.content || "";

    if (type === 'tdb') {
      setTdbPath(selectedPath);
      setTdbFileName(fileName);
      setTdbContent(content); 
      setShowTdbModal(false);
      inspectTdb(selectedPath, content);
    } else {
      setTracePath(selectedPath);
      setTraceFileName(fileName);
      // Don't set content for NPY files to avoid sending corrupted binary strings
      if (fileName.toLowerCase().endsWith('.npy')) {
          setTraceContent("");
      } else {
          setTraceContent(content);
      }
      setShowTraceModal(false);
    }
  };

  const handleParamChange = (key: string, value: any) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const handleCompositionChange = (key: string, value: any) => {
    setParams(prev => ({
      ...prev,
      composition: { ...prev.composition, [key]: value }
    }));
  };

  const handleProbLevelChange = (index: number, field: 'prob' | 'color', value: any) => {
    const newLevels = [...(params.prob_levels || [])];
    newLevels[index] = { ...newLevels[index], [field]: value };
    setParams(prev => ({ ...prev, prob_levels: newLevels }));
  };

  const addProbLevel = () => {
    const newLevels = [...(params.prob_levels || []), { prob: 0.5, color: '#3b82f6' }];
    setParams(prev => ({ ...prev, prob_levels: newLevels }));
  };

  const removeProbLevel = (index: number) => {
    const newLevels = (params.prob_levels || []).filter((_: any, i: number) => i !== index);
    setParams(prev => ({ ...prev, prob_levels: newLevels }));
  };

  const [traceShape, setTraceShape] = useState<string>('');
  const [traceSliceMode, setTraceSliceMode] = useState<string>('last');
  const [traceSliceVal, setTraceSliceVal] = useState<number>(1);
  const [isInspecting, setIsInspecting] = useState(false);
  
  const [availableComponents, setAvailableComponents] = useState<string[]>([]);
  const [availablePhases, setAvailablePhases] = useState<string[]>([]);

  // Dask Configuration State
  const [daskWorkers, setDaskWorkers] = useState<number>(4);
  const [daskThreads, setDaskThreads] = useState<number>(1);

  // TDB Element and Phase Parsing Logic
  useEffect(() => {
    if (!tdbContent) return;
    
    const lines = tdbContent.split('\n');
    const elements = new Set<string>();
    const phases = new Set<string>();
    
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('ELEMENT')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const el = parts[1].toUpperCase();
          if (el !== 'VA' && el !== '/-') {
            elements.add(el);
          }
        }
      } else if (trimmed.startsWith('PHASE')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const phaseName = parts[1].split(':')[0].toUpperCase();
          phases.add(phaseName);
        }
      }
    });
    
    const sortedElements = Array.from(elements).sort();
    setAvailableComponents(sortedElements);
    
    const sortedPhases = Array.from(phases).sort();
    if (sortedPhases.length > 0) {
      setAvailablePhases(sortedPhases);
    }
    
    // Auto-select defaults if not set
    if (sortedElements.length > 0) {
        // Default to second element for X component if available (binary system convention), else first
        const defaultX = sortedElements.length > 1 ? sortedElements[1] : sortedElements[0];
        
        setParams(prev => ({
            ...prev,
            x_component: prev.x_component || defaultX,
            component: prev.component || defaultX,
            // Ensure composition has a valid key
            composition: Object.keys(prev.composition).length === 0 
                ? { [`X_${defaultX}`]: 0.1 } 
                : prev.composition
        }));
    }
  }, [tdbContent]);

  const handleCompositionKeyChange = (newKey: string) => {
    const val = Object.values(params.composition)[0] as number || 0.1;
    setParams(prev => ({ ...prev, composition: { [`X_${newKey}`]: val } }));
  };

  const [logContent, setLogContent] = useState<string>("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);

  // Poll for logs when loading
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (loading) {
      interval = setInterval(async () => {
        try {
          const res = await fetch('/analysis/log');
          if (!res.ok) return;
          const text = await res.text();
          try {
            const data = JSON.parse(text);
            if (data.status === 'success') {
              setLogContent(data.log);
            }
          } catch (e) {
            // Ignore parse errors during polling
          }
        } catch (e) {
          console.error("Failed to fetch log", e);
        }
      }, 1000);
    } else {
      // Fetch once when not loading to get final state
      fetch('/analysis/log')
        .then(res => {
          if (!res.ok) return null;
          return res.text();
        })
        .then(text => {
          if (!text) return;
          try {
            const data = JSON.parse(text);
            if (data.status === 'success') setLogContent(data.log);
          } catch (e) {
            // Ignore parse errors
          }
        })
        .catch(e => console.error("Failed to fetch log", e));
    }
    return () => clearInterval(interval);
  }, [loading]);

  const runAnalysis = async () => {
    if ((!tdbContent && !tdbPath) || (!traceContent && !tracePath)) {
      setError("Please select both TDB and Trace files.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setResultImages([]);
    
    // Add command to terminal
    setTerminalLines(prev => [
        ...prev, 
        `user@thermoai:~/analysis$ python engine_analysis.py --type=${calcType} --workers=${daskWorkers}`
    ]);

    try {
      // Map isolated parameters to the ones expected by the backend
      const finalParams = { ...params };
      
      // Collect experimental data from datasets folder if specified
      if (datasetsPath) {
        finalParams.datasets_path = datasetsPath;
      }

      if (calcType === 'phase_fraction') {
        if (params.vary === 'X') { // Composition varies, T is fixed
          finalParams.fixed_val = params.pf_T_fixed;
          finalParams.min = params.pf_X_min;
          finalParams.max = params.pf_X_max;
          finalParams.steps = params.pf_X_steps;
        } else { // Temperature varies, X is fixed
          finalParams.fixed_val = params.pf_X_fixed;
          finalParams.min = params.pf_T_min;
          finalParams.max = params.pf_T_max;
          finalParams.steps = params.pf_T_steps;
        }
      } else if (calcType === 'property') {
        if (params.vary === 'X') { // Composition varies, T is fixed
          finalParams.fixed_val = params.uq_T_fixed;
          finalParams.min = params.uq_X_min;
          finalParams.max = params.uq_X_max;
          finalParams.steps = params.uq_X_steps;
        } else { // Temperature varies, X is fixed
          finalParams.fixed_val = params.uq_X_fixed;
          finalParams.min = params.uq_T_min;
          finalParams.max = params.uq_T_max;
          finalParams.steps = params.uq_T_steps;
        }
      }

      const response = await fetch('/analysis/calculate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tdb_content: tdbContent || null,
          trace_content: traceContent || null,
          tdb_path: tdbPath || null,
          trace_path: tracePath || null,
          calculation_type: calcType,
          parameters: finalParams,
          trace_slice_mode: traceSliceMode,
          trace_slice_val: traceSliceVal,
          dask_n_workers: daskWorkers,
          dask_threads_per_worker: daskThreads
        }),
      });

      // Check for network/server errors first
      if (!response.ok) {
          const status = response.status;
          const statusText = response.statusText;
          let errorBody = "";
          try {
              errorBody = await response.text();
              // Try to parse as JSON if possible
              try {
                  const jsonError = JSON.parse(errorBody);
                  if (jsonError.detail) errorBody = JSON.stringify(jsonError.detail);
                  else if (jsonError.message) errorBody = jsonError.message;
              } catch (e) {
                  // Not JSON, keep text
              }
          } catch (e) {
              errorBody = "Could not read response body";
          }

          let friendlyMsg = `Server Error (${status} ${statusText})`;
          if (status === 404) friendlyMsg = "Backend endpoint not found (404). Check if bridge.py is running and routes are mounted.";
          if (status === 502 || status === 504) friendlyMsg = "Cannot connect to backend (502/504). Ensure bridge.py is running on port 8081.";
          
          throw new Error(`${friendlyMsg}\nDetails: ${errorBody.slice(0, 200)}`);
      }

      const text = await response.text();
      let data;
      try {
          data = JSON.parse(text);
      } catch (e) {
          console.error("Failed to parse JSON response from calculate:", text);
          throw new Error(`Invalid JSON response from server (calculate). The backend might be misconfigured.\nResponse snippet: ${text.slice(0, 200)}`);
      }
      
      if (data.status === 'success') {
        if (data.images && Array.isArray(data.images)) {
            setResultImages(data.images.map((img: string) => `data:image/png;base64,${img}`));
        } else if (data.image) {
            setResultImages([`data:image/png;base64,${data.image}`]);
        }
        if (data.terminal_output) {
            const lines = data.terminal_output.split('\n');
            setTerminalLines(prev => [...prev, ...lines]);
        }
      } else {
        // Handle Application-level Error (200 OK but status='error')
        let errorMsg = data.message || "An error occurred during calculation.";
        
        // Check for FastAPI validation errors (422)
        if (data.detail && Array.isArray(data.detail)) {
            const validationErrors = data.detail.map((err: any) => 
                `${err.loc ? err.loc.join('.') : 'Unknown field'} - ${err.msg}`
            ).join('\n');
            errorMsg = `Validation Error:\n${validationErrors}`;
        }

        setError(errorMsg);
        
        if (data.terminal_output) {
            const lines = data.terminal_output.split('\n');
            setTerminalLines(prev => [...prev, ...lines]);
        } else {
             setTerminalLines(prev => [...prev, `Error: ${errorMsg}`]);
        }
      }
    } catch (err: any) {
      console.error(err);
      const msg = err.message || String(err);
      setError(msg);
      setTerminalLines(prev => [...prev, `System Error: ${msg}`]);
      
      // Add hint about local vs cloud
      if (msg.includes("502") || msg.includes("504") || msg.includes("Failed to fetch")) {
          setTerminalLines(prev => [...prev, "HINT: If you are using the Cloud Preview, it cannot reach your local backend.", "You must run the frontend locally (npm run dev) to connect to localhost:8081."]);
      }
    } finally {
      setLoading(false);
      setTerminalLines(prev => [...prev, ""]); // Empty line for spacing
    }
  };

  return (
    <div className="flex h-full bg-black text-[var(--industrial-text)] overflow-hidden">
      {/* Left Column: Settings (25%) */}
      <div className="w-1/4 min-w-[300px] border-r border-[var(--industrial-border)] p-6 overflow-y-auto space-y-8 bg-black">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2 mb-4 text-[var(--industrial-accent)] uppercase tracking-wider">
            <Settings className="w-5 h-5" />
            Configuration
          </h2>
          
          {/* File Selection */}
          <div className="space-y-4 mb-8">
            <div className="bg-black p-4 rounded-none border border-[var(--industrial-border)]">
              <label className="block text-sm font-medium text-slate-400 mb-2 flex items-center gap-2 uppercase tracking-tighter">
                <FileText className="w-4 h-4" /> TDB File (Database)
              </label>
              <button 
                onClick={() => setShowTdbModal(true)}
                className="w-full flex items-center justify-between bg-slate-900 hover:bg-slate-800 text-slate-300 py-2 px-3 rounded-none text-sm transition-colors border border-slate-700 font-mono"
              >
                <span className="truncate">{tdbFileName || "Select from Resource Hub"}</span>
                <Database className="w-4 h-4 text-[var(--industrial-accent)] ml-2" />
              </button>
              <button 
                onClick={() => tdbInputRef.current?.click()}
                className="mt-2 w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-slate-300 py-2 px-3 rounded-none text-xs transition-colors border border-slate-700 border-dashed uppercase tracking-widest"
              >
                <Upload className="w-3 h-3" /> Upload Local TDB
              </button>
              <input 
                type="file" 
                ref={tdbInputRef}
                onChange={(e) => handleLocalFileUpload(e, 'tdb')}
                className="hidden"
                accept=".tdb"
              />
            </div>

            <div className="bg-black p-4 rounded-none border border-[var(--industrial-border)]">
              <label className="block text-sm font-medium text-slate-400 mb-2 flex items-center gap-2 uppercase tracking-tighter">
                <Activity className="w-4 h-4" /> Trace File (.npy)
              </label>
              <button 
                onClick={() => setShowTraceModal(true)}
                className="w-full flex items-center justify-between bg-slate-900 hover:bg-slate-800 text-slate-300 py-2 px-3 rounded-none text-sm transition-colors border border-slate-700 font-mono"
              >
                <span className="truncate">{traceFileName || "Select from Resource Hub"}</span>
                <Database className="w-4 h-4 text-[var(--industrial-accent)] ml-2" />
              </button>
              <button 
                onClick={() => traceInputRef.current?.click()}
                className="mt-2 w-full flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-slate-300 py-2 px-3 rounded-none text-xs transition-colors border border-slate-700 border-dashed uppercase tracking-widest"
              >
                <Upload className="w-3 h-3" /> Upload Local Trace (.npy)
              </button>
              <input 
                type="file" 
                ref={traceInputRef}
                onChange={(e) => handleLocalFileUpload(e, 'trace')}
                className="hidden"
                accept=".npy"
              />
              
              {tracePath && (
                <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                    <div className="flex justify-between items-center">
                        <span className="text-xs text-slate-400 font-mono">Shape: {traceShape || 'Unknown'}</span>
                        <button onClick={() => inspectTrace(tracePath)} className="text-xs text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)] font-bold uppercase">
                            {isInspecting ? 'Checking...' : 'Check Shape'}
                        </button>
                    </div>
                    
                    <div>
                        <label className="text-xs text-slate-500 block mb-1 uppercase tracking-tighter">Iteration Selection</label>
                        <select 
                            value={traceSliceMode} 
                            onChange={(e) => setTraceSliceMode(e.target.value)}
                            className="w-full bg-black border border-slate-700 rounded-none p-1.5 text-xs text-slate-300 mb-2 font-mono"
                        >
                            <option value="last">Last Iteration (All Walkers) - Recommended</option>
                            <option value="last_n">Last N Iterations (All Walkers)</option>
                            <option value="specific">Specific Iteration Index</option>
                            <option value="all">All Iterations (Full Trace)</option>
                        </select>
                        
                        {(traceSliceMode === 'last_n' || traceSliceMode === 'specific') && (
                            <input 
                                type="number" 
                                value={traceSliceVal}
                                onChange={(e) => {
                                    const val = parseInt(e.target.value);
                                    setTraceSliceVal(isNaN(val) ? 0 : val);
                                }}
                                className="w-full bg-black border border-slate-700 rounded-none p-1.5 text-xs text-slate-300 font-mono"
                                placeholder={traceSliceMode === 'last_n' ? "Number of steps" : "Index"}
                            />
                        )}
                    </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-black p-4 rounded-none border border-[var(--industrial-border)] mb-6">
            <label className="block text-sm font-medium text-slate-400 mb-2 flex items-center gap-2 uppercase tracking-tighter">
              <Database className="w-4 h-4" /> Datasets Folder
            </label>
            <button 
              onClick={() => setShowDsModal(true)}
              className="w-full flex items-center justify-between bg-slate-900 hover:bg-slate-800 text-slate-300 py-2 px-3 rounded-none text-sm transition-colors border border-slate-700 font-mono"
            >
              <span className="truncate">{datasetsFileName || "Select Folder"}</span>
              <Plus className="w-4 h-4 text-[var(--industrial-accent)] ml-2" />
            </button>
          </div>

          {/* Dask Configuration */}
          <div className="mb-6 bg-black p-4 rounded-none border border-[var(--industrial-border)]">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              Dask Configuration
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1 uppercase tracking-tighter">Workers</label>
                <input 
                  type="number" 
                  min="1"
                  max="32"
                  value={daskWorkers} 
                  onChange={(e) => setDaskWorkers(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm text-slate-300 font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1 uppercase tracking-tighter">Threads/Worker</label>
                <input 
                  type="number" 
                  min="1"
                  max="8"
                  value={daskThreads} 
                  onChange={(e) => setDaskThreads(parseInt(e.target.value) || 1)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm text-slate-300 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Calculation Type */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-400 mb-2 uppercase tracking-tighter">Calculation Type</label>
            <select 
              value={calcType} 
              onChange={(e) => setCalcType(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-none p-2.5 text-slate-200 focus:ring-2 focus:ring-[var(--industrial-accent)]/50 focus:border-transparent outline-none font-mono"
            >
              <option value="single_point">Single Point Equilibrium</option>
              <option value="phase_diagram">Phase Diagram (Superimposed)</option>
              <option value="phase_fraction">Phase Fraction (1D)</option>
              <option value="invariant">Invariant Calculation</option>
              <option value="property">Property UQ</option>
              <option value="trace">Trace Visualization</option>
            </select>
          </div>

          {/* Dynamic Parameters Panels */}
          <div className="space-y-4 bg-black p-4 rounded-none border border-[var(--industrial-border)]/50">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">Parameters</h3>
            
            {/* Panel A: Single Point Equilibrium */}
            {calcType === 'single_point' && (
              <>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">Target Temp (K)</label>
                  <input 
                    type="number" 
                    value={params.T ?? ''} 
                    onChange={(e) => handleParamChange('T', e.target.value === '' ? '' : parseFloat(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">Composition Axis</label>
                  <div className="flex gap-2">
                    <select
                      className="w-1/3 bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      onChange={(e) => handleCompositionKeyChange(e.target.value)}
                      value={Object.keys(params.composition)[0]?.replace('X_', '') || ''}
                    >
                       {availableComponents.length > 0 ? (
                         availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                       ) : <option value="">Select...</option>}
                    </select>
                    <div className="w-2/3 relative">
                        <input 
                          type="number" 
                          step="0.01"
                          placeholder="Mole Fraction (X)" 
                          className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm pl-8 font-mono"
                          onChange={(e) => {
                            const key = Object.keys(params.composition)[0];
                            if (key) handleCompositionChange(key, e.target.value === '' ? '' : parseFloat(e.target.value));
                          }}
                          value={Object.values(params.composition)[0] ?? ''}
                        />
                        <span className="absolute left-2 top-2 text-slate-500 text-xs font-bold">X=</span>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">Target Phase (Optional)</label>
                  {availablePhases.length > 0 ? (
                    <select
                        value={params.target_phase || ''}
                        onChange={(e) => handleParamChange('target_phase', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                        <option value="">Auto-detect most probable</option>
                        {availablePhases.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (
                    <input 
                      type="text" 
                      value={params.target_phase || ''} 
                      onChange={(e) => handleParamChange('target_phase', e.target.value)}
                      placeholder="e.g. LIQUID (leave empty for auto)"
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  )}
                </div>
              </>
            )}

            {/* Panel B: Phase Diagram (Superimposed) */}
            {calcType === 'phase_diagram' && (
              <>
                <div>
                  <label className="text-xs text-slate-500 mb-2 block uppercase tracking-tighter">Target Phases (Multi-select)</label>
                  <div className="max-h-40 overflow-y-auto border border-slate-700 rounded-none p-2 bg-black custom-scrollbar">
                    {availablePhases.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {availablePhases.map(p => (
                          <label key={p} className="flex items-center space-x-2 text-[10px] cursor-pointer hover:bg-slate-900 p-1 rounded-none font-mono">
                            <input 
                              type="checkbox"
                              checked={params.uq_phases?.includes(p)}
                              onChange={(e) => {
                                const current = params.uq_phases || [];
                                if (e.target.checked) {
                                  handleParamChange('uq_phases', [...current, p]);
                                } else {
                                  handleParamChange('uq_phases', current.filter((ph: string) => ph !== p));
                                }
                              }}
                              className="rounded-none border-slate-700 bg-black text-[var(--industrial-accent)] focus:ring-[var(--industrial-accent)]/50"
                            />
                            <span>{p}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-600 font-mono italic">No phases available. Inspect TDB first.</div>
                    )}
                  </div>
                  <div className="mt-2 flex space-x-2">
                    <button 
                      onClick={() => handleParamChange('uq_phases', availablePhases)}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Select All
                    </button>
                    <button 
                      onClick={() => handleParamChange('uq_phases', [])}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">T Min</label>
                    <input 
                      type="number" 
                      value={params.t_min ?? ''} 
                      onChange={(e) => handleParamChange('t_min', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">T Max</label>
                    <input 
                      type="number" 
                      value={params.t_max ?? ''} 
                      onChange={(e) => handleParamChange('t_max', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Step</label>
                    <input 
                      type="number" 
                      value={params.t_step ?? ''} 
                      onChange={(e) => handleParamChange('t_step', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Component</label>
                    <select
                        value={params.x_component}
                        onChange={(e) => handleParamChange('x_component', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                        {availableComponents.length > 0 ? (
                          availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                        ) : <option value="">Select...</option>}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">X Min (Plot)</label>
                      <input 
                        type="number" 
                        step="0.01"
                        value={params.xlim_min ?? ''} 
                        onChange={(e) => handleParamChange('xlim_min', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">X Max (Plot)</label>
                      <input 
                        type="number" 
                        step="0.01"
                        value={params.xlim_max ?? ''} 
                        onChange={(e) => handleParamChange('xlim_max', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Panel C: Phase Fraction (1D) */}
            {calcType === 'phase_fraction' && (
              <>
                <div>
                  <label className="text-xs text-slate-500 mb-2 block uppercase tracking-tighter">Target Phases (Multi-select)</label>
                  <div className="max-h-40 overflow-y-auto border border-slate-700 rounded-none p-2 bg-black custom-scrollbar">
                    {availablePhases.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {availablePhases.map(p => (
                          <label key={p} className="flex items-center space-x-2 text-[10px] cursor-pointer hover:bg-slate-900 p-1 rounded-none font-mono">
                            <input 
                              type="checkbox"
                              checked={params.uq_phases?.includes(p)}
                              onChange={(e) => {
                                const current = params.uq_phases || [];
                                if (e.target.checked) {
                                  handleParamChange('uq_phases', [...current, p]);
                                } else {
                                  handleParamChange('uq_phases', current.filter((ph: string) => ph !== p));
                                }
                              }}
                              className="rounded-none border-slate-700 bg-black text-[var(--industrial-accent)] focus:ring-[var(--industrial-accent)]/50"
                            />
                            <span>{p}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-600 font-mono italic">No phases available. Inspect TDB first.</div>
                    )}
                  </div>
                  <div className="mt-2 flex space-x-2">
                    <button 
                      onClick={() => handleParamChange('uq_phases', availablePhases)}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Select All
                    </button>
                    <button 
                      onClick={() => handleParamChange('uq_phases', [])}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Vary Variable</label>
                    <select 
                      value={params.vary} 
                      onChange={(e) => handleParamChange('vary', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                      <option value="T">Temperature (Constant X)</option>
                      <option value="X">Composition (Constant T)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Component</label>
                    <select
                        value={params.x_component}
                        onChange={(e) => handleParamChange('x_component', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                        {availableComponents.length > 0 ? (
                          availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                        ) : <option value="">Select...</option>}
                    </select>
                  </div>
                </div>

                {params.vary === 'X' ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Fixed Temperature (K)</label>
                      <input 
                        type="number" 
                        value={params.pf_T_fixed ?? ''} 
                        onChange={(e) => handleParamChange('pf_T_fixed', e.target.value === '' ? '' : parseFloat(e.target.value))}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Fixed Composition Value</label>
                      <input 
                        type="number" 
                        step="0.01"
                        value={params.pf_X_fixed ?? ''} 
                        onChange={(e) => handleParamChange('pf_X_fixed', e.target.value === '' ? '' : parseFloat(e.target.value))}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      />
                    </div>
                  </div>
                )}
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Y Scale (Multiplier)</label>
                    <input 
                      type="number" 
                      value={params.yscale ?? 1.0} 
                      onChange={(e) => handleParamChange('yscale', parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      step="0.001"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Y Label</label>
                    <input 
                      type="text" 
                      value={params.ylabel ?? ''} 
                      onChange={(e) => handleParamChange('ylabel', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      placeholder="Auto"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Label</label>
                    <input 
                      type="text" 
                      value={params.xlabel ?? ''} 
                      onChange={(e) => handleParamChange('xlabel', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      placeholder="Auto"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Min</label>
                    <input 
                      type="number" 
                      value={params.xlim_min ?? ''} 
                      onChange={(e) => handleParamChange('xlim_min', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      placeholder="Auto"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Max</label>
                    <input 
                      type="number" 
                      value={params.xlim_max ?? ''} 
                      onChange={(e) => handleParamChange('xlim_max', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      placeholder="Auto"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Range Min</label>
                    <input 
                      type="number" 
                      value={params.vary === 'X' ? (params.pf_X_min ?? '') : (params.pf_T_min ?? '')} 
                      onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_min' : 'pf_T_min', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Range Max</label>
                    <input 
                      type="number" 
                      value={params.vary === 'X' ? (params.pf_X_max ?? '') : (params.pf_T_max ?? '')} 
                      onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_max' : 'pf_T_max', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">Number of Steps</label>
                  <input 
                    type="number" 
                    value={params.vary === 'X' ? (params.pf_X_steps ?? '') : (params.pf_T_steps ?? '')} 
                    onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_steps' : 'pf_T_steps', e.target.value === '' ? '' : parseFloat(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                  />
                </div>
              </>
            )}

            {/* Panel D: Invariant Calculation */}
            {calcType === 'invariant' && (
              <>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">Search Component</label>
                  <select
                      value={params.component}
                      onChange={(e) => handleParamChange('component', e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                  >
                      {availableComponents.length > 0 ? (
                        availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                      ) : <option value="">Select...</option>}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-500 uppercase tracking-tighter">X Guess</label>
                  <input 
                    type="number" 
                    step="0.01"
                    value={params.x_guess ?? ''} 
                    onChange={(e) => handleParamChange('x_guess', e.target.value === '' ? '' : parseFloat(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">T Low</label>
                    <input 
                      type="number" 
                      value={params.t_low ?? ''} 
                      onChange={(e) => handleParamChange('t_low', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">T High</label>
                    <input 
                      type="number" 
                      value={params.t_high ?? ''} 
                      onChange={(e) => handleParamChange('t_high', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Bandwidth (Smoothness)</label>
                    <input 
                      type="text" 
                      value={params.bw ?? ''} 
                      onChange={(e) => handleParamChange('bw', e.target.value)}
                      placeholder="0.5 or scott"
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">N Clusters (Auto if empty)</label>
                    <input 
                      type="number" 
                      value={params.n_clusters ?? ''} 
                      onChange={(e) => handleParamChange('n_clusters', e.target.value === '' ? '' : parseInt(e.target.value))}
                      placeholder="Auto"
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Confidence Intervals</label>
                    <button 
                      onClick={addProbLevel}
                      className="text-[9px] bg-[var(--industrial-accent)]/10 text-[var(--industrial-accent)] border border-[var(--industrial-accent)]/30 rounded-none px-2 py-0.5 hover:bg-[var(--industrial-accent)]/20 transition-colors flex items-center gap-1 uppercase font-bold"
                    >
                      <Plus size={10} /> Add Level
                    </button>
                  </div>
                  <div className="space-y-2 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                    {(params.prob_levels || []).map((level: any, index: number) => (
                      <div key={index} className="flex gap-2 items-center bg-black p-2 rounded-none border border-slate-700/50">
                        <div className="flex-1">
                          <input 
                            type="number" 
                            step="0.01"
                            min="0"
                            max="1"
                            value={level.prob} 
                            onChange={(e) => handleProbLevelChange(index, 'prob', parseFloat(e.target.value))}
                            className="w-full bg-slate-900 border border-slate-700 rounded-none px-2 py-1 text-xs font-mono"
                            placeholder="Prob (0-1)"
                          />
                        </div>
                        <div className="w-12 h-6 relative overflow-hidden rounded-none border border-slate-700">
                          <input 
                            type="color" 
                            value={level.color} 
                            onChange={(e) => handleProbLevelChange(index, 'color', e.target.value)}
                            className="absolute -top-1 -left-1 w-[150%] h-[150%] cursor-pointer"
                          />
                        </div>
                        <button 
                          onClick={() => removeProbLevel(index)}
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                          title="Remove level"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Panel E: Property UQ */}
            {calcType === 'property' && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Property</label>
                    <select 
                        value={params.property} 
                        onChange={(e) => {
                          handleParamChange('property', e.target.value);
                          if (e.target.value === 'HM_MIX' || e.target.value === 'ACR') {
                            handleParamChange('vary', 'X');
                          }
                          if (e.target.value === 'ACR') {
                            handleParamChange('plot_mode', 'Phases');
                            if (!params.act_component) {
                              handleParamChange('act_component', params.x_component || (availableComponents.length > 0 ? availableComponents[0] : ''));
                            }
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                        <option value="GM">Gibbs Free Energy (GM)</option>
                        <option value="HM_MIX">Enthalpy of Mixing (HM_MIX)</option>
                        <option value="ACR">Activity (ACR)</option>
                    </select>
                  </div>
                  {params.property !== 'ACR' && (
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Plot Mode</label>
                      <select 
                          value={params.plot_mode || 'System'} 
                          onChange={(e) => handleParamChange('plot_mode', e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                          disabled={params.property === 'ACR'}
                      >
                          {params.property !== 'ACR' && <option value="System">System Equilibrium</option>}
                          <option value="Phases">Individual Phases</option>
                      </select>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">X Component (X-axis)</label>
                    <select
                        value={params.x_component}
                        onChange={(e) => handleParamChange('x_component', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    >
                        {availableComponents.length > 0 ? (
                          availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                        ) : <option value="">Select...</option>}
                    </select>
                  </div>
                  {params.property === 'ACR' && (
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Activity Element</label>
                      <select
                          value={params.act_component || params.x_component}
                          onChange={(e) => handleParamChange('act_component', e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      >
                          {availableComponents.length > 0 ? (
                            availableComponents.map(c => <option key={c} value={c}>{c}</option>)
                          ) : <option value="">Select...</option>}
                      </select>
                    </div>
                  )}
                  {params.property !== 'ACR' && params.vary === 'X' && (
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Fixed Temperature (K)</label>
                      <input 
                        type="number" 
                        value={params.uq_T_fixed ?? ''} 
                        onChange={(e) => handleParamChange('uq_T_fixed', e.target.value === '' ? '' : parseFloat(e.target.value))}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs text-slate-500 mb-2 block uppercase tracking-tighter">Target Phases (Multi-select)</label>
                  <div className="max-h-40 overflow-y-auto border border-slate-700 rounded-none p-2 bg-black custom-scrollbar">
                    {availablePhases.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {availablePhases.map(p => (
                          <label key={p} className="flex items-center space-x-2 text-[10px] cursor-pointer hover:bg-slate-900 p-1 rounded-none font-mono">
                            <input 
                              type="checkbox"
                              checked={params.uq_phases?.includes(p)}
                              onChange={(e) => {
                                const current = params.uq_phases || [];
                                if (e.target.checked) {
                                  handleParamChange('uq_phases', [...current, p]);
                                } else {
                                  handleParamChange('uq_phases', current.filter((ph: string) => ph !== p));
                                }
                              }}
                              className="rounded-none border-slate-700 bg-black text-[var(--industrial-accent)] focus:ring-[var(--industrial-accent)]/50"
                            />
                            <span>{p}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-600 font-mono italic">No phases available. Inspect TDB first.</div>
                    )}
                  </div>
                  <div className="mt-2 flex space-x-2">
                    <button 
                      onClick={() => handleParamChange('uq_phases', availablePhases)}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Select All
                    </button>
                    <button 
                      onClick={() => handleParamChange('uq_phases', [])}
                      className="text-[9px] bg-slate-900 hover:bg-slate-800 px-2 py-1 rounded-none border border-slate-700 uppercase font-bold text-slate-400"
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                {params.property !== 'ACR' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Vary Variable</label>
                      <select 
                        value={params.vary} 
                        onChange={(e) => handleParamChange('vary', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        disabled={params.property === 'HM_MIX' || params.property === 'ACR'}
                      >
                        {params.property !== 'HM_MIX' && params.property !== 'ACR' && (
                          <option value="T">Temperature (Constant X)</option>
                        )}
                        <option value="X">Composition (Constant T)</option>
                      </select>
                    </div>
                    {params.vary === 'X' ? (
                      <div>
                        <label className="text-xs text-slate-500 uppercase tracking-tighter">Fixed Temperature (K)</label>
                        <input 
                          type="number" 
                          value={params.uq_T_fixed ?? ''} 
                          onChange={(e) => handleParamChange('uq_T_fixed', e.target.value === '' ? '' : parseFloat(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="text-xs text-slate-500 uppercase tracking-tighter">Fixed Composition Value</label>
                        <input 
                          type="number" 
                          step="0.01"
                          value={params.uq_X_fixed ?? ''} 
                          onChange={(e) => handleParamChange('uq_X_fixed', e.target.value === '' ? '' : parseFloat(e.target.value))}
                          className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        />
                      </div>
                    )}
                  </div>
                )}

                {params.property !== 'ACR' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Y Scale (Multiplier)</label>
                      <input 
                        type="number" 
                        value={params.yscale ?? 1.0} 
                        onChange={(e) => handleParamChange('yscale', parseFloat(e.target.value))}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        step="0.001"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">Y Label</label>
                      <input 
                        type="text" 
                        value={params.ylabel ?? ''} 
                        onChange={(e) => handleParamChange('ylabel', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        placeholder="Auto"
                      />
                    </div>
                  </div>
                )}

                {params.property !== 'ACR' && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">X Label</label>
                      <input 
                        type="text" 
                        value={params.xlabel ?? ''} 
                        onChange={(e) => handleParamChange('xlabel', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        placeholder="Auto"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">X Min</label>
                      <input 
                        type="number" 
                        value={params.xlim_min ?? ''} 
                        onChange={(e) => handleParamChange('xlim_min', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        placeholder="Auto"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase tracking-tighter">X Max</label>
                      <input 
                        type="number" 
                        value={params.xlim_max ?? ''} 
                        onChange={(e) => handleParamChange('xlim_max', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                        placeholder="Auto"
                      />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Range Min</label>
                    <input 
                      type="number" 
                      value={params.vary === 'X' ? (params.uq_X_min ?? '') : (params.uq_T_min ?? '')} 
                      onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_min' : 'pf_T_min', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Range Max</label>
                    <input 
                      type="number" 
                      value={params.vary === 'X' ? (params.uq_X_max ?? '') : (params.uq_T_max ?? '')} 
                      onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_max' : 'pf_T_max', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                </div>
                {params.property !== 'ACR' && (
                  <div>
                    <label className="text-xs text-slate-500 uppercase tracking-tighter">Number of Steps</label>
                    <input 
                      type="number" 
                      value={params.vary === 'X' ? (params.pf_X_steps ?? '') : (params.pf_T_steps ?? '')} 
                      onChange={(e) => handleParamChange(params.vary === 'X' ? 'pf_X_steps' : 'pf_T_steps', e.target.value === '' ? '' : parseFloat(e.target.value))}
                      className="w-full bg-slate-900 border border-slate-700 rounded-none p-2 text-sm font-mono"
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <button 
            onClick={runAnalysis}
            disabled={loading}
            className={`w-full py-3 rounded-none font-bold flex items-center justify-center gap-2 transition-all uppercase tracking-widest text-xs ${
              loading 
                ? 'bg-slate-800 cursor-not-allowed text-slate-500' 
                : 'bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-white shadow-lg hover:shadow-[var(--industrial-accent)]/25'
            }`}
          >
            {loading ? (
              <>Processing...</>
            ) : (
              <>
                <Play className="w-4 h-4" /> Run Calculation
              </>
            )}
          </button>
        </div>
      </div>

      {/* Middle Column: Log & Terminal (25%) */}
      <div className="w-1/4 min-w-[300px] border-r border-[var(--industrial-border)] bg-black flex flex-col">
        {/* Top Half: Execution Log (70%) */}
        <div className="h-[70%] p-4 flex flex-col min-h-0 border-b border-[var(--industrial-border)]">
            <h2 className="text-xl font-bold flex items-center gap-2 mb-4 text-[var(--industrial-accent)] uppercase tracking-wider">
            <FileText className="w-5 h-5" />
            Execution Log
            </h2>
            <div className="flex-1 bg-black rounded-none border border-[var(--industrial-border)] p-4 overflow-auto font-mono text-[10px] text-slate-300 whitespace-pre-wrap custom-scrollbar">
            {logContent || "Waiting for logs..."}
            </div>
        </div>

        {/* Bottom Half: Terminal (30%) */}
        <div className="h-[30%] p-4 flex flex-col min-h-0 bg-black">
            <h2 className="text-xs font-bold flex items-center gap-2 mb-2 text-slate-500 uppercase tracking-widest">
            <Terminal className="w-4 h-4" />
            Terminal
            </h2>
            <div className="flex-1 font-mono text-[10px] text-green-500 overflow-auto p-2 custom-scrollbar">
                {terminalLines.map((line, i) => (
                    <div key={i} className="mb-1 whitespace-pre-wrap">{line}</div>
                ))}
                <div className="mb-1">user@thermoai:~/analysis$ <span className="animate-pulse">_</span></div>
            </div>
        </div>
      </div>

      {/* Right Column: Display (50%) */}
      <div className="flex-1 p-8 overflow-y-auto bg-black flex flex-col">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold flex items-center gap-2 uppercase tracking-tighter">
            <Layers className="w-6 h-6 text-[var(--industrial-accent)]" />
            Visualization Results
          </h2>
          <div className="flex space-x-3">
            {resultImages.length > 0 && (
              <>
                <button 
                  onClick={() => handleDownload(resultImages[0], 0)}
                  className="p-2 bg-slate-900 border border-slate-700 rounded-none hover:bg-slate-800 text-slate-300"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => handleMaximize(resultImages[0])}
                  className="p-2 bg-slate-900 border border-slate-700 rounded-none hover:bg-slate-800 text-slate-300"
                  title="Maximize"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => handleSaveToHub(resultImages[0], 0)}
                  className="p-2 bg-slate-900 border border-slate-700 rounded-none hover:bg-slate-800 text-slate-300"
                  title="Save to Hub"
                >
                  <Save className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none p-6 shadow-2xl flex items-center justify-center relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 bg-black flex items-center justify-center z-10">
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 border-4 border-[var(--industrial-accent)] border-t-transparent rounded-full animate-spin"></div>
                <p className="text-[var(--industrial-accent)] font-bold uppercase tracking-widest animate-pulse text-xs">Calculating Uncertainty...</p>
              </div>
            </div>
          )}
          
          {error ? (
            <div className="text-center p-8 bg-red-950/30 border border-red-900/50 rounded-none max-w-lg">
              <Info className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-bold text-red-400 mb-2 uppercase">Calculation Failed</h3>
              <p className="text-slate-300 text-sm font-mono">{error}</p>
            </div>
          ) : resultImages.length > 0 ? (
            <div className="flex flex-col gap-6 w-full h-full overflow-y-auto items-center p-4 custom-scrollbar">
              {resultImages.map((img, idx) => (
                <img 
                  key={idx}
                  src={img} 
                  alt={`Analysis Result ${idx + 1}`} 
                  className="max-w-full object-contain rounded-none shadow-2xl bg-white p-2 border border-[var(--industrial-border)]"
                />
              ))}
            </div>
          ) : (
            <div className="text-center text-slate-600">
              <BarChart3 className="w-16 h-16 mx-auto mb-4 opacity-10" />
              <p className="text-lg font-bold uppercase tracking-widest">No results generated yet</p>
              <p className="text-xs mt-2 font-mono">Configure parameters and upload files to start analysis</p>
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <div className="bg-black border border-[var(--industrial-border)] p-4 rounded-none">
            <h4 className="text-[10px] font-bold text-slate-500 uppercase mb-1 tracking-widest">Status</h4>
            <p className="text-xs font-mono text-[var(--industrial-accent)] flex items-center gap-2">
              <span className="w-2 h-2 rounded-none bg-[var(--industrial-accent)]"></span>
              System Ready
            </p>
          </div>
          <div className="bg-black border border-[var(--industrial-border)] p-4 rounded-none">
            <h4 className="text-[10px] font-bold text-slate-500 uppercase mb-1 tracking-widest">Engine</h4>
            <p className="text-xs font-mono text-[var(--industrial-accent)]">PDUQ / PyCalphad</p>
          </div>
          <div className="bg-black border border-[var(--industrial-border)] p-4 rounded-none">
            <h4 className="text-[10px] font-bold text-slate-500 uppercase mb-1 tracking-widest">Last Run</h4>
            <p className="text-xs font-mono text-slate-400">-</p>
          </div>
        </div>
      </div>

      {showTdbModal && (
        <FileSelectorModal 
          files={files} 
          mode="file" 
          onConfirm={(path) => handleFileSelect(path, 'tdb')} 
          onClose={() => setShowTdbModal(false)} 
          title="Select TDB Database" 
        />
      )}

      {showTraceModal && (
        <FileSelectorModal 
          files={files} 
          mode="file" 
          onConfirm={(path) => handleFileSelect(path, 'trace')} 
          onClose={() => setShowTraceModal(false)} 
          title="Select Trace File (.npy)" 
        />
      )}

      {showDsModal && (
        <FileSelectorModal 
          files={files} 
          mode="folder" 
          onConfirm={(path) => {
            setDatasetsPath(path);
            setDatasetsFileName(path.split('/').pop() || "");
            setShowDsModal(false);
          }} 
          onClose={() => setShowDsModal(false)} 
          title="Select Datasets Folder" 
        />
      )}
    </div>
  );
};

export default Analysis;
